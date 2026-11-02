import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import mysql from 'mysql2/promise';
import { listSqlFiles } from './utils.js';
import { validateMigrationSql } from './migration-sql.js';

const ledgerSql = `CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
const checksumSql = `CREATE TABLE IF NOT EXISTS schema_migration_checksums (
  filename VARCHAR(255) PRIMARY KEY, checksum VARCHAR(64) NOT NULL)`;
const attemptsSql = `CREATE TABLE IF NOT EXISTS schema_migration_attempts (
  filename VARCHAR(255) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, status VARCHAR(16) NOT NULL)`;

function alreadyApplied(migration, rows) {
  if (!rows.length) return false;
  if (rows[0].checksum && rows[0].checksum !== migration.checksum) {
    throw new Error(`Applied migration changed (checksum mismatch): ${migration.filename}. Restore the original file and create a new migration.`);
  }
  if (!rows[0].checksum) process.emitWarning(`Legacy migration ${migration.filename} is unverified (no recorded checksum); skipped without reapplying.`);
  return true;
}

async function applyFiles(session, migrations, onApplied) {
  const applied = [], skipped = [];
  for (const migration of migrations) {
    if (await session.apply(migration)) {
      applied.push(migration.filename);
      await onApplied?.(migration.filename);
    } else skipped.push(migration.filename);
  }
  return { applied, skipped };
}

function rollbackSqlite(db, failure) {
  try { db.exec('ROLLBACK'); }
  catch (rollbackError) {
    // SQLite can roll back automatically on trigger RAISE(ROLLBACK) or I/O failures.
    if (!/no transaction is active/u.test(rollbackError.message)) {
      throw new AggregateError([failure, rollbackError], 'Migration failed and rollback also failed.');
    }
  }
  throw failure;
}

function sqliteSession(engine) {
  const db = engine.open();
  db.exec('PRAGMA busy_timeout=30000;');
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(ledgerSql); db.exec(checksumSql); db.exec('COMMIT'); }
  catch (error) { rollbackSqlite(db, error); }
  return {
    apply(migration) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const rows = db.prepare('SELECT m.filename, c.checksum FROM schema_migrations m LEFT JOIN schema_migration_checksums c ON c.filename=m.filename WHERE m.filename=?').all(migration.filename);
        if (alreadyApplied(migration, rows)) { db.exec('COMMIT'); return false; }
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations(filename) VALUES(?)').run(migration.filename);
        db.prepare('INSERT INTO schema_migration_checksums(filename,checksum) VALUES(?,?) ON CONFLICT(filename) DO UPDATE SET checksum=excluded.checksum').run(migration.filename, migration.checksum);
        db.exec('COMMIT'); return true;
      } catch (error) { rollbackSqlite(db, error); }
    },
  };
}

async function postgresRun(config, migrations, options) {
  const client = new Client(config.postgres.connectionString ? { connectionString: config.postgres.connectionString } : config.postgres);
  try {
    await client.connect();
    // A session lock survives per-file commits and is released even after a process crash.
    await client.query('SELECT pg_advisory_lock(1684177972, 1835624306)');
    await client.query(ledgerSql);
    await client.query(checksumSql);
    return await applyFiles({ async apply(migration) {
      await client.query('BEGIN');
      try {
        const rows = (await client.query('SELECT m.filename,c.checksum FROM schema_migrations m LEFT JOIN schema_migration_checksums c ON c.filename=m.filename WHERE m.filename=$1', [migration.filename])).rows;
        if (alreadyApplied(migration, rows)) { await client.query('COMMIT'); return false; }
        await client.query('SET LOCAL standard_conforming_strings=on');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [migration.filename]);
        await client.query('INSERT INTO schema_migration_checksums(filename,checksum) VALUES($1,$2) ON CONFLICT(filename) DO UPDATE SET checksum=excluded.checksum', [migration.filename, migration.checksum]);
        await client.query('COMMIT'); return true;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    } }, migrations, options.onApplied);
  } finally { await client.end(); }
}

function repairMessage(filename) {
  return `MySQL migration ${filename} has an incomplete attempt. Automatic retry is blocked because DDL may already be committed. Inspect schema_migration_attempts and the schema, manually undo or finish the migration, then reconcile schema_migrations/checksums and remove the attempt row before retrying.`;
}

async function mysqlApply(connection, migration) {
  const [attempts] = await connection.execute('SELECT status FROM schema_migration_attempts WHERE filename=?', [migration.filename]);
  if (attempts.length && attempts[0].status !== 'applied') throw new Error(repairMessage(migration.filename));
  const [rows] = await connection.execute('SELECT m.filename,c.checksum FROM schema_migrations m LEFT JOIN schema_migration_checksums c ON c.filename=m.filename WHERE m.filename=?', [migration.filename]);
  if (alreadyApplied(migration, rows)) return false;
  await connection.execute("INSERT INTO schema_migration_attempts(filename,checksum,status) VALUES(?,?,'started') ON DUPLICATE KEY UPDATE checksum=VALUES(checksum),status='started'", [migration.filename, migration.checksum]);
  try {
    if (migration.sql.trim()) await connection.query(migration.sql);
    await connection.beginTransaction();
    await connection.execute('INSERT INTO schema_migrations(filename) VALUES(?)', [migration.filename]);
    await connection.execute('INSERT INTO schema_migration_checksums(filename,checksum) VALUES(?,?) ON DUPLICATE KEY UPDATE checksum=VALUES(checksum)', [migration.filename, migration.checksum]);
    await connection.execute("UPDATE schema_migration_attempts SET status='applied' WHERE filename=?", [migration.filename]);
    await connection.commit();
    return true;
  } catch (error) {
    try { await connection.rollback(); await connection.execute("UPDATE schema_migration_attempts SET status='failed' WHERE filename=?", [migration.filename]); }
    catch (stateError) { throw new AggregateError([error, stateError], repairMessage(migration.filename)); }
    throw new Error(`${repairMessage(migration.filename)} Cause: ${error.message}`, { cause: error });
  }
}

async function mysqlRun(config, migrations, options) {
  const connection = await mysql.createConnection({ ...config.mysql, multipleStatements: true });
  try {
    const [locks] = await connection.execute('SELECT GET_LOCK(?,30) AS acquired', ['db-toolkit-migrations']);
    if (Number(locks[0].acquired) !== 1) throw new Error('Could not acquire MySQL migration lock.');
    const [modes] = await connection.query('SELECT @@SESSION.sql_mode AS mode');
    if (modes[0].mode.split(',').some(mode => ['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES'].includes(mode))) {
      throw new Error('MySQL migrations require sql_mode without NO_BACKSLASH_ESCAPES or ANSI_QUOTES so SQL controls can be validated safely.');
    }
    await connection.query('SET autocommit=1');
    await connection.query(ledgerSql + ' ENGINE=InnoDB');
    await connection.query(checksumSql + ' ENGINE=InnoDB');
    await connection.query(attemptsSql + ' ENGINE=InnoDB');
    const [incomplete] = await connection.query("SELECT filename FROM schema_migration_attempts WHERE status <> 'applied' LIMIT 1");
    if (incomplete.length) throw new Error(repairMessage(incomplete[0].filename));
    return await applyFiles({ apply: migration => mysqlApply(connection, migration) }, migrations, options.onApplied);
  } finally { await connection.end(); }
}

export async function runMigrations(engine, directory, options = {}) {
  const dialect = engine.config.engine;
  if (!['sqlite', 'postgres', 'mysql'].includes(dialect)) throw new Error(`Migrations are unsupported for ${dialect === 'mssql' ? 'SQL Server' : dialect}; no database changes were made.`);
  const migrations = listSqlFiles(directory).map(filename => {
    const sql = fs.readFileSync(path.join(directory, filename), 'utf8');
    validateMigrationSql(sql, dialect);
    return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
  if (dialect === 'sqlite') return applyFiles(sqliteSession(engine), migrations, options.onApplied);
  if (dialect === 'postgres') return postgresRun(engine.config, migrations, options);
  return mysqlRun(engine.config, migrations, options);
}
