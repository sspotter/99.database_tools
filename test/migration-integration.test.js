import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from 'pg';
import mysql from 'mysql2/promise';
import { runMigrations } from '../lib/migrations.js';

const pgUrl = process.env.DB_TOOLKIT_TEST_POSTGRES_MIGRATION_URL;
const mysqlUrl = process.env.DB_TOOLKIT_TEST_MYSQL_MIGRATION_URL;

function migrationDir(t, sql) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtk-server-migrate-'));
  fs.writeFileSync(path.join(directory, '001.sql'), sql);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function postgresFixture(t) {
  const admin = new Client({ connectionString: pgUrl });
  await admin.connect();
  const database = 'dbtk_test_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE DATABASE "${database}"`);
  const target = new URL(pgUrl); target.pathname = '/' + database;
  const client = new Client({ connectionString: target.href });
  await client.connect();
  t.after(async () => { await client.end(); await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.end(); });
  return { config: { engine: 'postgres', postgres: { connectionString: target.href } }, client };
}

function launch(config, directory) {
  const source = `import { runMigrations } from ${JSON.stringify(new URL('../lib/migrations.js', import.meta.url).href)}; await runMigrations({config:JSON.parse(process.env.DB_TOOLKIT_CHILD_CONFIG)},process.argv[1]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], {
    env: { ...process.env, DB_TOOLKIT_CHILD_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, completed };
}

async function waitUntil(query) {
  const deadline = Date.now() + 10000;
  while (!(await query())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for migration fixture.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('PostgreSQL failure and ledger rejection roll back schema, and concurrency applies once', { skip: !pgUrl }, async t => {
  const { config, client } = await postgresFixture(t);
  const directory = migrationDir(t, 'CREATE TABLE example(id INT); SELECT * FROM missing_table;');
  await assert.rejects(runMigrations({ config }, directory), /missing_table/);
  assert.equal((await client.query("SELECT to_regclass('example') AS table_name")).rows[0].table_name, null);
  await client.query(`CREATE FUNCTION reject_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger denied'; END $$; CREATE TRIGGER reject_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_ledger();`);
  fs.writeFileSync(path.join(directory, '001.sql'), 'CREATE TABLE example(id INT);');
  await assert.rejects(runMigrations({ config }, directory), /ledger denied/);
  assert.equal((await client.query("SELECT to_regclass('example') AS table_name")).rows[0].table_name, null);
  await client.query('DROP TRIGGER reject_ledger ON schema_migrations');
  const workers = [launch(config, directory), launch(config, directory)];
  for (const exit of await Promise.all(workers.map(worker => worker.completed))) assert.equal(exit.code, 0, exit.stderr);
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
  fs.writeFileSync(path.join(directory, '001.sql'), 'CREATE TABLE changed(id INT);');
  await assert.rejects(runMigrations({ config }, directory), /checksum mismatch/);
});

test('PostgreSQL process death rolls back SQL and releases the advisory lock', { skip: !pgUrl }, async t => {
  const { config, client } = await postgresFixture(t);
  const directory = migrationDir(t, 'CREATE TABLE example(id INT); SELECT pg_sleep(3);');
  const worker = launch(config, directory);
  await waitUntil(async () => (await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'CREATE TABLE example%' AND wait_event='PgSleep'")).rowCount > 0);
  worker.child.kill('SIGKILL');
  await worker.completed;
  fs.writeFileSync(path.join(directory, '001.sql'), 'CREATE TABLE example(id INT);');
  assert.deepEqual(await runMigrations({ config }, directory), { applied: ['001.sql'], skipped: [] });
});

async function mysqlFixture(t) {
  const target = new URL(mysqlUrl);
  const database = target.pathname.slice(1);
  assert.match(database, /^dbtk_test_[a-zA-Z0-9_]+$/);
  const settings = { host: target.hostname, port: Number(target.port), user: decodeURIComponent(target.username), password: decodeURIComponent(target.password), database };
  const connection = await mysql.createConnection({ ...settings, multipleStatements: true });
  for (const table of ['example', 'schema_migration_attempts', 'schema_migration_checksums', 'schema_migrations']) await connection.query('DROP TABLE IF EXISTS `' + table + '`');
  t.after(async () => {
    for (const table of ['example', 'schema_migration_attempts', 'schema_migration_checksums', 'schema_migrations']) await connection.query('DROP TABLE IF EXISTS `' + table + '`');
    await connection.end();
  });
  return { config: { engine: 'mysql', mysql: settings }, connection };
}

test('MySQL partial DDL failure is durable and automatic retry is blocked', { skip: !mysqlUrl }, async t => {
  const { config, connection } = await mysqlFixture(t);
  const directory = migrationDir(t, 'CREATE TABLE example(id INT); INSERT INTO missing_table VALUES(1);');
  await assert.rejects(runMigrations({ config }, directory), /manual|manually/);
  const [attempts] = await connection.query('SELECT status FROM schema_migration_attempts');
  assert.equal(attempts[0].status, 'failed');
  assert.equal((await connection.query('SELECT COUNT(*) AS n FROM schema_migrations'))[0][0].n, 0);
  fs.writeFileSync(path.join(directory, '001.sql'), 'INSERT INTO example VALUES(2);');
  await assert.rejects(runMigrations({ config }, directory), /retry is blocked/);
  assert.equal((await connection.query('SELECT COUNT(*) AS n FROM example'))[0][0].n, 0);
});

test('MySQL arithmetic dashes and quoted SET controls are rejected before ledger writes', { skip: !mysqlUrl }, async t => {
  const { config, connection } = await mysqlFixture(t);
  const [arithmetic] = await connection.query('SELECT 1--1 AS arithmetic');
  assert.equal(arithmetic[0].arithmetic, 2);
  const directory = migrationDir(t, '');
  for (const sql of [`SELECT 1--1; USE ${config.mysql.database};`, 'SET @@SESSION.`autocommit`=0;']) {
    fs.writeFileSync(path.join(directory, '001.sql'), sql);
    await assert.rejects(runMigrations({ config }, directory), /transaction|directive/i);
    const [tables] = await connection.query("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE 'schema_migration%'");
    assert.equal(tables.length, 0);
  }
});

test('MySQL process interruption retains started state and blocks automatic retry', { skip: !mysqlUrl }, async t => {
  const { config, connection } = await mysqlFixture(t);
  const directory = migrationDir(t, 'CREATE TABLE example(id INT); SELECT SLEEP(3);');
  const worker = launch(config, directory);
  await waitUntil(async () => (await connection.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='example'"))[0][0].n > 0);
  worker.child.kill('SIGKILL'); await worker.completed;
  const [attempts] = await connection.query('SELECT status FROM schema_migration_attempts');
  assert.equal(attempts[0].status, 'started');
  await assert.rejects(runMigrations({ config }, directory), /retry is blocked/);
});

test('MySQL concurrent runners apply once and reject changed applied files', { skip: !mysqlUrl }, async t => {
  const { config, connection } = await mysqlFixture(t);
  const directory = migrationDir(t, 'CREATE TABLE example(id INT); INSERT INTO example VALUES(1);');
  const workers = [launch(config, directory), launch(config, directory)];
  for (const exit of await Promise.all(workers.map(worker => worker.completed))) assert.equal(exit.code, 0, exit.stderr);
  assert.equal((await connection.query('SELECT COUNT(*) AS n FROM example'))[0][0].n, 1);
  assert.equal((await connection.query('SELECT status FROM schema_migration_attempts'))[0][0].status, 'applied');
  fs.writeFileSync(path.join(directory, '001.sql'), 'INSERT INTO example VALUES(2);');
  await assert.rejects(runMigrations({ config }, directory), /checksum mismatch/);
});

test('MySQL ledger rejection retains committed DDL and records failed attempt', { skip: !mysqlUrl }, async t => {
  const { config, connection } = await mysqlFixture(t);
  const directory = migrationDir(t, '');
  await runMigrations({ config }, directory);
  await connection.query('DELETE FROM schema_migrations; DELETE FROM schema_migration_checksums; DELETE FROM schema_migration_attempts');
  await connection.query("ALTER TABLE schema_migrations ADD CONSTRAINT reject_ledger CHECK(filename <> '001.sql')");
  fs.writeFileSync(path.join(directory, '001.sql'), 'CREATE TABLE example(id INT);');
  await assert.rejects(runMigrations({ config }, directory), /reject_ledger/);
  assert.equal((await connection.query('SELECT status FROM schema_migration_attempts'))[0][0].status, 'failed');
  assert.equal((await connection.query('SELECT COUNT(*) AS n FROM schema_migrations'))[0][0].n, 0);
  assert.equal((await connection.query('SELECT COUNT(*) AS n FROM example'))[0][0].n, 0);
});
