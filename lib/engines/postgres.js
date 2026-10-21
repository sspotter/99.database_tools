import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { runProcess } from '../process-runner.js';
import { quoteIdentifier, quoteLiteral, readTextFile } from '../utils.js';

function setDatabasePath(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function buildConnectionString(config, databaseName = null) {
  const base = config.postgres.connectionString;
  if (base) {
    if (!databaseName) {
      return base;
    }
    return setDatabasePath(base, databaseName);
  }

  const url = new URL('postgresql://localhost/postgres');
  url.hostname = config.postgres.host;
  url.port = String(config.postgres.port);
  url.username = config.postgres.user;
  url.password = config.postgres.password;
  url.pathname = `/${databaseName || config.postgres.database}`;
  return url.toString();
}

async function withClient(connectionString, handler) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch (error) {
    if (error?.code === 'ECONNREFUSED' || error instanceof AggregateError) {
      throw new Error(
        'PostgreSQL connection refused. Start the PostgreSQL server, check LOCAL_DATABASE_URL host/port, and make sure the server accepts TCP connections.'
      );
    }
    throw error;
  }
  try {
    return await handler(client);
  } finally {
    await client.end();
  }
}

function parseConnectionSettings(config) {
  const connectionString = buildConnectionString(config);
  const url = new URL(connectionString);
  return {
    user: decodeURIComponent(url.username || config.postgres.user || ''),
    password: decodeURIComponent(url.password || config.postgres.password || ''),
    database: decodeURIComponent(url.pathname.replace(/^\/+/, '') || config.postgres.database),
  };
}

function runPostgresAdminSql(config, sql) {
  const result = spawnSync(
    'sudo',
    ['-u', 'postgres', 'psql', '-d', config.postgres.adminDatabase || 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    }
  );

  if (result.error) {
    throw new Error(`Failed to run sudo -u postgres psql: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`Failed to run sudo -u postgres psql${detail ? `: ${detail}` : ''}`);
  }
}

export class PostgresEngine {
  constructor(config, { processRunner = runProcess } = {}) {
    this.config = config;
    this.processRunner = processRunner;
    this.databaseName = parseConnectionSettings(config).database;
  }

  async createDatabase() {
    const adminConnectionString = buildConnectionString(this.config, this.config.postgres.adminDatabase);
    const dbName = this.databaseName;
    const dbExists = await withClient(adminConnectionString, async (client) => {
      const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      return result.rowCount > 0;
    });

    if (!dbExists) {
      await withClient(adminConnectionString, async (client) => {
        const sql = `CREATE DATABASE ${quoteIdentifier(dbName, 'postgres')};`;
        await client.query(sql);
      });
    }

    return { database: dbName, created: !dbExists };
  }

  getLoginSettings() {
    return parseConnectionSettings(this.config);
  }

  createOrUpdateLoginRole() {
    const settings = this.getLoginSettings();
    if (!settings.user || !settings.password) {
      throw new Error('LOCAL_DATABASE_URL must include a username and password before a PostgreSQL role can be created.');
    }
    if (settings.user === 'postgres') {
      runPostgresAdminSql(
        this.config,
        `ALTER USER ${quoteIdentifier(settings.user, 'postgres')} WITH PASSWORD ${quoteLiteral(settings.password)};`
      );
      return { user: settings.user, action: 'updated' };
    }

    runPostgresAdminSql(
      this.config,
      `
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(settings.user)}) THEN
            ALTER ROLE ${quoteIdentifier(settings.user, 'postgres')} WITH LOGIN CREATEDB PASSWORD ${quoteLiteral(settings.password)};
          ELSE
            CREATE ROLE ${quoteIdentifier(settings.user, 'postgres')} WITH LOGIN CREATEDB PASSWORD ${quoteLiteral(settings.password)};
          END IF;
        END
        $$;
      `
    );
    return { user: settings.user, action: 'created_or_updated' };
  }

  async runSql(sqlText, { database } = {}) {
    const trimmed = sqlText.trim();
    if (!trimmed) {
      return { rows: [], rowCount: 0, command: '' };
    }

    const targetDatabase = database || this.databaseName;
    const connectionString = buildConnectionString(this.config, targetDatabase);
    return withClient(connectionString, (client) => client.query(trimmed));
  }

  runSqlFile(filePath, options = {}) {
    return this.runSql(readTextFile(filePath), options);
  }

  async listTables() {
    const result = await this.runSql(
      `
        SELECT tablename
        FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY tablename;
      `
    );
    return result.rows.map((row) => row.tablename);
  }

  async dropTable(tableName) {
    return this.runSql(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName, 'postgres')} CASCADE;`);
  }

  async previewRows(tableName, limit = 100) {
    // Validate against the real table list so the interpolated identifier below
    // can never be attacker-controlled SQL.
    if (!(await this.listTables()).includes(tableName)) {
      throw new Error(`Unknown table: ${tableName}`);
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const result = await this.runSql(
      `SELECT * FROM ${quoteIdentifier(tableName, 'postgres')} LIMIT ${safeLimit};`
    );
    const columns =
      result.fields?.map((field) => field.name) ??
      (result.rows.length ? Object.keys(result.rows[0]) : []);
    return { columns, rows: result.rows };
  }

  async reset(schemaFile) {
    const tables = await this.listTables();
    for (const tableName of tables) {
      await this.dropTable(tableName);
    }
    await this.clearMigrationLedger();
    if (schemaFile) {
      await this.runSqlFile(schemaFile);
    }
  }

  async health() {
    const result = await this.runSql('SELECT 1 AS health_check;');
    return {
      ok: Boolean(result.rows?.[0]?.health_check === 1 || result.rows?.[0]?.health_check === '1'),
      output: JSON.stringify(result.rows?.[0] ?? {}),
      tables: (await this.listTables()).length,
    };
  }

  nativeClientEnv() {
    const url = new URL(buildConnectionString(this.config));
    const query = url.searchParams;
    const env = {
      ...process.env,
      PGHOST: query.get('host') || decodeURIComponent(url.hostname),
      PGPORT: query.get('port') || url.port || '5432',
      PGUSER: query.get('user') || decodeURIComponent(url.username),
      PGPASSWORD: query.get('password') || decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    };
    // node-pg does not use libpq service files or hostaddr; keep native clients on the verified host.
    for (const variable of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) delete env[variable];
    const parameters = {
      sslmode: 'PGSSLMODE', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY',
      sslrootcert: 'PGSSLROOTCERT', sslcrl: 'PGSSLCRL', sslpassword: 'PGSSLPASSWORD',
      connect_timeout: 'PGCONNECT_TIMEOUT', application_name: 'PGAPPNAME',
      options: 'PGOPTIONS', target_session_attrs: 'PGTARGETSESSIONATTRS',
      channel_binding: 'PGCHANNELBINDING', passfile: 'PGPASSFILE',
    };
    for (const [parameter, variable] of Object.entries(parameters)) {
      if (query.has(parameter)) env[variable] = query.get(parameter);
    }
    if (query.get('ssl') === 'false' || query.get('ssl') === '0') env.PGSSLMODE = 'disable';
    if (!query.has('sslmode') && (query.get('ssl') === 'true' || query.get('ssl') === '1')) env.PGSSLMODE = 'verify-full';
    return env;
  }

  async backup(outputPath) {
    await this.processRunner('pg_dump', ['--format=plain', '--no-password'], {
      env: this.nativeClientEnv(), outputFile: outputPath,
    });
    return outputPath;
  }

  async restore(inputPath) {
    const populated = await this.runSql(`
      SELECT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        UNION ALL
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        UNION ALL
        SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        UNION ALL
        SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_'
          AND nspname NOT IN ('public', 'information_schema')
        UNION ALL
        SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql'
      ) AS populated;
    `);
    if (populated.rows[0].populated) {
      throw new Error('PostgreSQL restore requires an empty target database; create a separate empty database first.');
    }
    return this.processRunner('psql', ['--no-psqlrc', '--no-password', '--single-transaction', '--set=ON_ERROR_STOP=1'], {
      env: this.nativeClientEnv(), inputFile: inputPath,
    });
  }

  async ensureMigrationsTable() {
    return this.runSql(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async listAppliedMigrations() {
    await this.ensureMigrationsTable();
    const result = await this.runSql('SELECT filename FROM schema_migrations ORDER BY filename;');
    return result.rows.map((row) => row.filename);
  }

  async recordMigration(filename) {
    await this.ensureMigrationsTable();
    return this.runSql(
      `INSERT INTO schema_migrations (filename, applied_at) VALUES (${quoteLiteral(filename)}, CURRENT_TIMESTAMP);`
    );
  }

  async clearMigrationLedger() {
    return this.runSql('DROP TABLE IF EXISTS schema_migrations;');
  }

}
