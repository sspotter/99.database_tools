import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDirSync,
  exists,
  listSqlFiles,
  quoteIdentifier,
  quoteLiteral,
  readTextFile,
  timestampTag,
  writeTextFile,
} from '../utils.js';

function binaryForEngine(engine) {
  if (engine === 'postgres') {
    return { client: 'psql', dump: 'pg_dump' };
  }
  if (engine === 'mysql') {
    return { client: 'mysql', dump: 'mysqldump' };
  }
  if (engine === 'mssql') {
    return { client: 'sqlcmd', dump: null };
  }
  throw new Error(`Unsupported external engine: ${engine}`);
}

function failOnSpawnError(result, commandName) {
  if (result.error) {
    throw new Error(`${commandName} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(`${commandName} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function buildConnectionArgs(config, databaseName, includeDatabase = true) {
  if (config.engine === 'postgres') {
    const args = ['-X', '-v', 'ON_ERROR_STOP=1'];
    args.push('-h', config.postgres.host);
    args.push('-p', String(config.postgres.port));
    if (config.postgres.user) {
      args.push('-U', config.postgres.user);
    }
    if (includeDatabase) {
      args.push('-d', databaseName);
    }
    return args;
  }

  if (config.engine === 'mysql') {
    const args = [
      '--batch',
      '--raw',
      '--skip-column-names',
      '--protocol=TCP',
      '-h',
      config.mysql.host,
      '-P',
      String(config.mysql.port),
    ];
    if (config.mysql.user) {
      args.push('-u', config.mysql.user);
    }
    if (includeDatabase) {
      args.push('--database', databaseName);
    }
    return args;
  }

  if (config.engine === 'mssql') {
    const args = ['-b', '-S', `${config.mssql.host},${config.mssql.port}`];
    if (config.mssql.user) {
      args.push('-U', config.mssql.user);
    }
    if (config.mssql.password) {
      args.push('-P', config.mssql.password);
    }
    if (includeDatabase) {
      args.push('-d', databaseName);
    }
    if (config.mssql.trustServerCertificate) {
      args.push('-C');
    }
    return args;
  }

  throw new Error(`Unsupported engine: ${config.engine}`);
}

function buildConnectionEnv(config) {
  if (config.engine === 'postgres') {
    return {
      ...process.env,
      PGPASSWORD: config.postgres.password,
    };
  }

  if (config.engine === 'mysql') {
    return {
      ...process.env,
      MYSQL_PWD: config.mysql.password,
    };
  }

  return process.env;
}

function buildIdentifierQuote(engine, identifier) {
  return quoteIdentifier(identifier, engine);
}

function runBinary(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
    ...options,
  });
  failOnSpawnError(result, command);
  return result;
}

function runSudoCommand(args, label) {
  const result = spawnSync('sudo', args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function tempSqlFile(sqlText) {
  const tempPath = path.join(
    os.tmpdir(),
    `db-toolkit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sql`
  );
  fs.writeFileSync(tempPath, sqlText, 'utf8');
  return tempPath;
}

export class ExternalCliEngine {
  constructor(config) {
    this.config = config;
    this.engine = config.engine;
    this.binary = binaryForEngine(config.engine);
  }

  assertSupported(operation) {
    if (this.engine === 'mssql' && (operation === 'backup' || operation === 'restore')) {
      throw new Error('Backup and restore are not implemented yet for SQL Server in this first version.');
    }
  }

  getLoginSettings() {
    if (this.engine === 'mysql') {
      return {
        user: this.config.mysql.user,
        password: this.config.mysql.password,
        database: this.config.mysql.database,
        host: this.config.mysql.host,
        port: this.config.mysql.port,
      };
    }
    return null;
  }

  startServerService() {
    if (this.engine === 'mysql') {
      runSudoCommand(['systemctl', 'enable', '--now', 'mysql'], 'sudo systemctl enable --now mysql');
      return { service: 'mysql' };
    }
    throw new Error(`Automatic service start is not implemented for ${this.engine}.`);
  }

  createOrUpdateLoginRole() {
    if (this.engine !== 'mysql') {
      throw new Error(`Role recovery is not implemented for ${this.engine}.`);
    }
    const settings = this.getLoginSettings();
    if (!settings.user || !settings.password) {
      throw new Error('DATABASE_URL or MYSQL_USER/MYSQL_PASSWORD must include a username and password before a MySQL user can be created.');
    }
    const host = settings.host === '127.0.0.1' || settings.host === 'localhost' ? 'localhost' : '%';
    const sql = [
      `CREATE USER IF NOT EXISTS ${quoteLiteral(settings.user)}@${quoteLiteral(host)} IDENTIFIED BY ${quoteLiteral(settings.password)};`,
      `ALTER USER ${quoteLiteral(settings.user)}@${quoteLiteral(host)} IDENTIFIED BY ${quoteLiteral(settings.password)};`,
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(settings.database, 'mysql')};`,
      `GRANT ALL PRIVILEGES ON ${quoteIdentifier(settings.database, 'mysql')}.* TO ${quoteLiteral(settings.user)}@${quoteLiteral(host)};`,
      'FLUSH PRIVILEGES;',
    ].join('\n');

    runSudoCommand(['mysql', '-e', sql], 'sudo mysql');
    return { user: settings.user, host, database: settings.database };
  }

  runSql(sqlText, { database, includeDatabase = true } = {}) {
    const trimmed = sqlText.trim();
    if (!trimmed) {
      return { stdout: '', stderr: '' };
    }

    const targetDatabase =
      database ||
      (this.engine === 'postgres'
        ? this.config.postgres.database
        : this.engine === 'mysql'
          ? this.config.mysql.database
          : this.config.mssql.database);

    if (this.engine === 'postgres') {
      return runBinary(this.binary.client, buildConnectionArgs(this.config, targetDatabase, includeDatabase), {
        input: trimmed + '\n',
        env: buildConnectionEnv(this.config),
      });
    }

    if (this.engine === 'mysql') {
      return runBinary(this.binary.client, buildConnectionArgs(this.config, targetDatabase, includeDatabase), {
        input: trimmed + '\n',
        env: buildConnectionEnv(this.config),
      });
    }

    if (this.engine === 'mssql') {
      const tempPath = tempSqlFile(trimmed);
      try {
        return runBinary(
          this.binary.client,
          [...buildConnectionArgs(this.config, targetDatabase, includeDatabase), '-i', tempPath],
          {}
        );
      } finally {
        fs.rmSync(tempPath, { force: true });
      }
    }

    throw new Error(`Unsupported engine: ${this.engine}`);
  }

  runSqlFile(filePath, options = {}) {
    return this.runSql(readTextFile(filePath), options);
  }

  createDatabase() {
    if (this.engine === 'postgres') {
      const sql = `CREATE DATABASE ${buildIdentifierQuote('postgres', this.config.postgres.database)};`;
      return this.runSql(sql, { database: this.config.postgres.adminDatabase, includeDatabase: true });
    }

    if (this.engine === 'mysql') {
      const sql = `CREATE DATABASE IF NOT EXISTS ${buildIdentifierQuote('mysql', this.config.mysql.database)};`;
      return this.runSql(sql, { includeDatabase: false });
    }

    if (this.engine === 'mssql') {
      const sql = `
        IF DB_ID(N${quoteLiteral(this.config.mssql.database)}) IS NULL
        BEGIN
          EXEC('CREATE DATABASE ${buildIdentifierQuote('mssql', this.config.mssql.database)}');
        END
      `;
      return this.runSql(sql, {
        database: this.config.mssql.adminDatabase,
        includeDatabase: true,
      });
    }

    throw new Error(`Unsupported engine: ${this.engine}`);
  }

  listTables() {
    if (this.engine === 'postgres') {
      const result = this.runSql(
        `
          SELECT tablename
          FROM pg_tables
          WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY tablename;
        `
      );
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }

    if (this.engine === 'mysql') {
      const result = this.runSql('SHOW TABLES;');
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }

    if (this.engine === 'mssql') {
      const result = this.runSql(
        `
          SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME;
        `
      );
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }

    throw new Error(`Unsupported engine: ${this.engine}`);
  }

  dropTable(tableName) {
    const sql = `DROP TABLE IF EXISTS ${buildIdentifierQuote(this.engine, tableName)};`;
    return this.runSql(sql);
  }

  reset(schemaFile) {
    const tables = this.listTables();
    for (const tableName of tables) {
      this.dropTable(tableName);
    }
    this.clearMigrationLedger();
    if (schemaFile) {
      this.runSqlFile(schemaFile);
    }
  }

  health() {
    const result = this.runSql('SELECT 1 AS health_check;');
    return {
      ok: /1/.test(result.stdout),
      output: result.stdout.trim(),
      tables: this.listTables().length,
    };
  }

  backup(outputPath) {
    this.assertSupported('backup');

    if (this.engine === 'postgres') {
      const result = runBinary(
        this.binary.dump,
        [
          '-h',
          this.config.postgres.host,
          '-p',
          String(this.config.postgres.port),
          '-U',
          this.config.postgres.user,
          '-d',
          this.config.postgres.database,
        ],
        {
          env: buildConnectionEnv(this.config),
        }
      );
      ensureDirSync(path.dirname(outputPath));
      fs.writeFileSync(outputPath, result.stdout, 'utf8');
      return outputPath;
    }

    if (this.engine === 'mysql') {
      const result = runBinary(
        this.binary.dump,
        [
          '-h',
          this.config.mysql.host,
          '-P',
          String(this.config.mysql.port),
          '-u',
          this.config.mysql.user,
          this.config.mysql.database,
        ],
        {
          env: buildConnectionEnv(this.config),
        }
      );
      ensureDirSync(path.dirname(outputPath));
      fs.writeFileSync(outputPath, result.stdout, 'utf8');
      return outputPath;
    }

    throw new Error(`Backup is not implemented for ${this.engine}`);
  }

  restore(inputPath) {
    this.assertSupported('restore');

    const sqlText = readTextFile(inputPath);
    return this.runSql(sqlText);
  }

  ensureMigrationsTable() {
    this.runSql(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  listAppliedMigrations() {
    this.ensureMigrationsTable();
    const result = this.runSql('SELECT filename FROM schema_migrations ORDER BY filename;');
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  recordMigration(filename) {
    this.ensureMigrationsTable();
    this.runSql(
      `INSERT INTO schema_migrations (filename, applied_at) VALUES (${quoteLiteral(filename)}, CURRENT_TIMESTAMP);`
    );
  }

  clearMigrationLedger() {
    this.runSql('DROP TABLE IF EXISTS schema_migrations;');
  }

  createMigrationDatabaseTableIfNeeded() {
    this.ensureMigrationsTable();
  }

  exportSql(outputPath) {
    const tempPath = tempSqlFile('-- export not implemented');
    fs.rmSync(tempPath, { force: true });
    writeTextFile(outputPath, '-- Export is not implemented for external engines yet.\n');
    return outputPath;
  }
}
