import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteEngine } from '../lib/engines/sqlite.js';
import { runMigrations } from '../lib/migrations.js';
import { validateMigrationSql } from '../lib/migration-sql.js';

function fixture(t, sql) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtk-migrate-'));
  const engine = new SqliteEngine({ engine: 'sqlite', sqlite: { file: path.join(directory, 'test.db') } });
  fs.writeFileSync(path.join(directory, '001.sql'), sql);
  t.after(() => { engine.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { engine, directory };
}

test('failed SQL rolls back all changes and leaves the migration pending', async t => {
  const { engine, directory } = fixture(t, 'CREATE TABLE example(id); INSERT INTO missing VALUES(1);');
  await assert.rejects(runMigrations(engine, directory));
  assert.equal(engine.listTables().includes('example'), false);
  assert.equal(engine.open().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0);
});

test('ledger rejection rolls back otherwise successful migration SQL', async t => {
  for (const action of ['ABORT', 'ROLLBACK']) {
    const { engine, directory } = fixture(t, 'CREATE TABLE example(id);');
    engine.ensureMigrationsTable();
    engine.open().exec(`CREATE TRIGGER reject_ledger BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(${action}, 'ledger denied'); END;`);
    await assert.rejects(runMigrations(engine, directory), /ledger denied/);
    assert.equal(engine.listTables().includes('example'), false);
  }
});

test('new checksums detect edits while legacy ledger entries remain skipped', async t => {
  const { engine, directory } = fixture(t, 'CREATE TABLE example(id);');
  engine.ensureMigrationsTable();
  engine.recordMigration('000.sql');
  fs.writeFileSync(path.join(directory, '000.sql'), 'CREATE TABLE legacy_must_not_run(id);');
  assert.deepEqual(await runMigrations(engine, directory), { applied: ['001.sql'], skipped: ['000.sql'] });
  assert.equal(engine.listTables().includes('legacy_must_not_run'), false);
  fs.writeFileSync(path.join(directory, '001.sql'), 'CREATE TABLE changed(id);');
  await assert.rejects(runMigrations(engine, directory), /checksum|changed/i);
});

test('transaction and client controls are rejected before any writes', async t => {
  for (const sql of ['CREATE TABLE escaped(id); COMMIT;', 'END;', '/* comment */ BEGIN;', '.read other.sql', 'SELECT 1;\n\\i other.sql']) {
    const { engine, directory } = fixture(t, sql);
    await assert.rejects(runMigrations(engine, directory), /transaction|directive/i);
    assert.equal(fs.existsSync(engine.databasePath), false);
  }
});

test('quoted transaction words and trigger bodies do not cause false rejection', async t => {
  const { engine, directory } = fixture(t, `CREATE TABLE example(id, description); CREATE TRIGGER fill AFTER INSERT ON example BEGIN UPDATE example SET description='COMMIT; -- BEGIN' WHERE id=NEW.id; END; INSERT INTO example(id) VALUES(1);`);
  await runMigrations(engine, directory);
  assert.equal(engine.open().prepare('SELECT description FROM example').get().description, 'COMMIT; -- BEGIN');
});

test('objects named trigger cannot disguise a transaction commit as a trigger ending', async t => {
  for (const declaration of [
    'CREATE TABLE trigger(id)',
    'CREATE TEMP TABLE trigger(id)',
    'CREATE TABLE example(id); CREATE INDEX trigger ON example(id)',
  ]) {
    const { engine, directory } = fixture(t, `${declaration}; END; CREATE TABLE escaped(id); INSERT INTO missing VALUES(1);`);
    await assert.rejects(runMigrations(engine, directory), /transaction controls/i);
    assert.equal(fs.existsSync(engine.databasePath), false);
  }
});

test('SQL Server is refused without opening or writing a database', async () => {
  await assert.rejects(runMigrations({ config: { engine: 'mssql' }, open() { assert.fail('opened database'); } }, 'missing'), /SQL Server|unsupported/i);
});

test('dialect-aware validation rejects controls and permits quoted function bodies', () => {
  for (const [dialect, sql] of [
    ['postgres', "SELECT 1; PREPARE TRANSACTION 'escaped';"],
    ['postgres', 'SET standard_conforming_strings=off;'],
    ['mysql', 'SET @@session.autocommit=1;'],
    ['mysql', '/*!50000 COMMIT */'],
    ['mysql', 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$'],
    ['mysql', 'SET sql_mode=\'NO_BACKSLASH_ESCAPES\';'],
    ['mysql', 'SELECT `column\\` FROM example; COMMIT; -- `'],
    ['mysql', 'SELECT 1--1; USE other_database;'],
    ['mysql', 'SET @@SESSION.`autocommit`=0;'],
    ['mysql', 'SET SESSION `sql_mode`=\'NO_BACKSLASH_ESCAPES\';'],
    ['postgres', 'SET "standard_conforming_strings"=off;'],
  ]) assert.throws(() => validateMigrationSql(sql, dialect), /unsupported|transaction|directive/i);
  validateMigrationSql("DO $body$ BEGIN RAISE NOTICE 'COMMIT;'; END $body$; /* outer /* nested */ comment */ SELECT 'BEGIN;';", 'postgres');
  validateMigrationSql("INSERT INTO example VALUES('text\\\' COMMIT;'); # COMMIT\nSELECT `COMMIT`;", 'mysql');
  validateMigrationSql('SELECT 1; -- legitimate comment hiding COMMIT;\nSELECT 2;', 'mysql');
});

function childRun(engine, directory) {
  const source = `import { SqliteEngine } from ${JSON.stringify(new URL('../lib/engines/sqlite.js', import.meta.url).href)}; import { runMigrations } from ${JSON.stringify(new URL('../lib/migrations.js', import.meta.url).href)}; const engine = new SqliteEngine(JSON.parse(process.argv[1])); try { console.log(JSON.stringify(await runMigrations(engine, process.argv[2]))); } finally {engine.close();}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(engine.config), directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test('two real processes apply a migration exactly once', async t => {
  const { engine, directory } = fixture(t, 'CREATE TABLE example(id); INSERT INTO example VALUES(1);');
  const runs = await Promise.all([childRun(engine, directory), childRun(engine, directory)]);
  assert.equal(runs.flatMap(run => run.applied).length, 1);
  assert.equal(engine.open().prepare('SELECT COUNT(*) AS n FROM example').get().n, 1);
});

test('SQLite process interruption rolls back SQL and leaves its ledger pending', async t => {
  const { engine, directory } = fixture(t, '');
  fs.unlinkSync(path.join(directory, '001.sql'));
  await runMigrations(engine, directory);
  engine.close();
  fs.writeFileSync(path.join(directory, '001.sql'), 'CREATE TABLE example(id); INSERT INTO example WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n;');
  const source = `import {SqliteEngine} from ${JSON.stringify(new URL('../lib/engines/sqlite.js', import.meta.url).href)}; import {runMigrations} from ${JSON.stringify(new URL('../lib/migrations.js', import.meta.url).href)}; const e=new SqliteEngine(JSON.parse(process.argv[1])); await runMigrations(e,process.argv[2]); e.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(engine.config), directory], { stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(engine.databasePath + '-journal')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for SQLite migration transaction.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill('SIGKILL'); await exited;
  assert.equal(engine.listTables().includes('example'), false);
  assert.equal(engine.open().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0);
  fs.writeFileSync(path.join(directory, '001.sql'), 'CREATE TABLE example(id);');
  assert.deepEqual(await runMigrations(engine, directory), { applied: ['001.sql'], skipped: [] });
});
