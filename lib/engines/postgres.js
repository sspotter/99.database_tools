import { Client } from 'pg';
import { ensureDirSync, quoteIdentifier, quoteLiteral, readTextFile, writeTextFile } from '../utils.js';

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
  await client.connect();
  try {
    return await handler(client);
  } finally {
    await client.end();
  }
}

export class PostgresEngine {
  constructor(config) {
    this.config = config;
    this.databaseName = config.postgres.database;
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

  async backup(outputPath) {
    throw new Error('PostgreSQL backup is not implemented in driver mode yet.');
  }

  async restore(inputPath) {
    const sqlText = readTextFile(inputPath);
    return this.runSql(sqlText);
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

  createMigrationDatabaseTableIfNeeded() {
    return this.ensureMigrationsTable();
  }

  async exportSql(outputPath) {
    writeTextFile(outputPath, '-- Export is not implemented for PostgreSQL driver mode yet.\n');
    return outputPath;
  }
}
