import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import mysql from 'mysql2/promise';
import { PostgresEngine } from '../lib/engines/postgres.js';
import { ExternalCliEngine } from '../lib/engines/external.js';
import { runProcess } from '../lib/process-runner.js';

function dockerRunner(container, port) {
  return (command, args, options) => {
    const env = { ...options.env, PGHOST: '127.0.0.1', PGPORT: String(port) };
    const names = Object.keys(env).filter((name) => /^(PG|MYSQL_PWD)/.test(name));
    const dockerArgs = ['exec', '-i', ...names.flatMap((name) => ['-e', name]), container, command, ...args];
    return runProcess('docker', dockerArgs, { ...options, env });
  };
}

test('native PostgreSQL dump restores COPY null quotes multiline and rolls back SQL failure', { skip: !process.env.DBTK_TEST_PG_ADMIN_URL }, async (t) => {
  const adminUrl = process.env.DBTK_TEST_PG_ADMIN_URL;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dbtk pg restore '));
  const sourceName = `dbtk_test_backup_${randomUUID().replaceAll('-', '')}`;
  const targetName = `dbtk_test_restore_${randomUUID().replaceAll('-', '')}`;
  t.after(async () => {
    await admin.query(`DROP DATABASE IF EXISTS "${sourceName}" WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`);
    await admin.end();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await admin.query(`CREATE DATABASE "${sourceName}"`);
  await admin.query(`CREATE DATABASE "${targetName}"`);
  const engineFor = (name) => {
    const url = new URL(adminUrl); url.pathname = `/${name}`;
    return new PostgresEngine({ postgres: { connectionString: url.toString(), database: 'dbtk_test_stale_config_name' } }, {
      processRunner: process.env.DBTK_TEST_NATIVE_DOCKER ? dockerRunner('db-toolkit-demo-postgres', 5432) : runProcess,
    });
  };
  const source = engineFor(sourceName);
  const target = engineFor(targetName);
  await source.runSql('CREATE TABLE sample (id integer PRIMARY KEY, content text)');
  await source.runSql("INSERT INTO sample VALUES (1, NULL), (2, 'quote''s'), (3, E'line1\\nline2'), (4, E'back\\\\slash\\ttab')");
  const dumpPath = path.join(directory, 'native dump.sql');
  await source.backup(dumpPath);
  assert.match(await fs.readFile(dumpPath, 'utf8'), /COPY public.sample/);
  await target.restore(dumpPath);
  assert.deepEqual((await target.runSql('SELECT * FROM sample ORDER BY id')).rows, [
    { id: 1, content: null }, { id: 2, content: "quote's" }, { id: 3, content: 'line1\nline2' }, { id: 4, content: 'back\\slash\ttab' },
  ]);
  await assert.rejects(target.restore(dumpPath), /empty target/);
  assert.equal((await target.runSql('SELECT COUNT(*)::int AS count FROM sample')).rows[0].count, 4);
  await target.runSql('DROP TABLE sample');
  const badDump = path.join(directory, 'failure.sql');
  await fs.writeFile(badDump, 'CREATE TABLE should_rollback(id integer);\nSELECT nonexistent_column;\n');
  await assert.rejects(target.restore(badDump), /exit code/);
  assert.equal((await target.runSql("SELECT to_regclass('public.should_rollback') AS relation")).rows[0].relation, null);
  await target.runSql('CREATE SCHEMA occupied; CREATE FUNCTION occupied.f() RETURNS integer LANGUAGE SQL AS $$ SELECT 1 $$');
  await assert.rejects(target.restore(dumpPath), /empty target/);
});

test('native MySQL dump streams consistent transactional data on an explicit scratch database', { skip: !process.env.DBTK_TEST_MYSQL_BACKUP_URL }, async (t) => {
  const url = new URL(process.env.DBTK_TEST_MYSQL_BACKUP_URL);
  const database = url.pathname.slice(1);
  assert.match(database, /^dbtk_test_/);
  const connection = await mysql.createConnection(url.toString());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dbtk mysql backup '));
  t.after(async () => {
    await connection.query('DROP TABLE IF EXISTS dbtk_backup_sample');
    await connection.end();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await connection.query('CREATE TABLE dbtk_backup_sample (id INT PRIMARY KEY, content TEXT) ENGINE=InnoDB');
  await connection.query('INSERT INTO dbtk_backup_sample VALUES (?, ?)', [1, "quotes'\nmultiline"]);
  const runner = process.env.DBTK_TEST_NATIVE_DOCKER ? (command, args, options) => {
    const containerArgs = args.map((arg, index) => args[index - 1] === '-P' ? '3306' : arg);
    return dockerRunner('db-toolkit-demo-mysql', 3306)(command, containerArgs, options);
  } : runProcess;
  const engine = new ExternalCliEngine({ engine: 'mysql', mysql: {
    host: url.hostname, port: url.port, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database,
  } }, { processRunner: runner });
  const output = path.join(directory, 'native mysql.sql');
  await engine.backup(output);
  assert.match(await fs.readFile(output, 'utf8'), /INSERT INTO `dbtk_backup_sample`/);
  await connection.query('DROP TABLE dbtk_backup_sample');
  await engine.restore(output);
  const [rows] = await connection.query('SELECT * FROM dbtk_backup_sample');
  assert.deepEqual(rows, [{ id: 1, content: "quotes'\nmultiline" }]);
});
