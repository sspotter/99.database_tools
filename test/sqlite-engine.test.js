import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteEngine } from '../lib/engines/sqlite.js';
import { listSqlFiles } from '../lib/utils.js';

// Resolve the repo's real schema/migration files relative to this test file so
// the suite runs regardless of the process cwd.
const repoRoot = path.resolve(import.meta.dirname, '..');
const schemaFile = path.join(repoRoot, 'schemas', 'schema.sql');
const migrationsDir = path.join(repoRoot, 'migrations');

// Real temp-file database per test (the engine IS the subject — no mocking the
// driver). close() before cleanup is required so Windows releases the file lock.
function makeEngine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtk-sqlite-'));
  const engine = new SqliteEngine({ engine: 'sqlite', sqlite: { file: path.join(dir, 'test.db') } });
  t.after(() => {
    try {
      engine.close();
    } catch {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { engine, dir };
}

test('createDatabase reports creation only on first call', (t) => {
  const { engine, dir } = makeEngine(t);
  const first = engine.createDatabase();
  assert.equal(first.created, true);
  assert.ok(fs.existsSync(path.join(dir, 'test.db')));

  const second = engine.createDatabase();
  assert.equal(second.created, false);
});

test('listTables returns user tables sorted and excludes sqlite internal tables', (t) => {
  const { engine } = makeEngine(t);
  engine.runSql('CREATE TABLE zeta (id INTEGER PRIMARY KEY AUTOINCREMENT);');
  engine.runSql('CREATE TABLE alpha (id INTEGER);');
  // The autoincrement insert creates the internal sqlite_sequence table, which
  // must be filtered out by the NOT LIKE 'sqlite_%' clause.
  engine.runSql('INSERT INTO zeta DEFAULT VALUES;');

  assert.deepEqual(engine.listTables(), ['alpha', 'zeta']);
});

test('dropTable removes the named table', (t) => {
  const { engine } = makeEngine(t);
  engine.runSql('CREATE TABLE temp_table (id INTEGER);');
  engine.dropTable('temp_table');
  assert.deepEqual(engine.listTables(), []);
});

test("running the repo's schema.sql creates the subscriptions table", (t) => {
  const { engine } = makeEngine(t);
  engine.createDatabase();
  engine.runSqlFile(schemaFile);
  assert.ok(
    engine.listTables().includes('subscriptions'),
    'schema.sql should create the subscriptions table'
  );
});

test("applying the repo's migrations creates the users and audit_log tables", (t) => {
  const { engine } = makeEngine(t);
  engine.createDatabase();
  engine.ensureMigrationsTable();

  const files = listSqlFiles(migrationsDir);
  assert.ok(files.length > 0, 'expected at least one migration file in migrations/');
  for (const filename of files) {
    engine.runSqlFile(path.join(migrationsDir, filename));
    engine.recordMigration(filename);
  }

  const tables = engine.listTables();
  assert.ok(tables.includes('users'), 'migration 002 should create users');
  assert.ok(tables.includes('audit_log'), 'migration 003 should create audit_log');
  // The ledger should reflect every applied migration, in filename order.
  assert.deepEqual(engine.listAppliedMigrations(), files);
});

test('previewRows returns columns and rows for a populated table', (t) => {
  const { engine } = makeEngine(t);
  engine.runSql('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);');
  engine.runSql("INSERT INTO notes (body) VALUES ('alpha'),('beta');");

  const result = engine.previewRows('notes', 100);
  assert.deepEqual(result.columns, ['id', 'body']);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].body, 'alpha');
});

test('previewRows reports columns (no rows) for an empty table and honors the limit', (t) => {
  const { engine } = makeEngine(t);
  engine.runSql('CREATE TABLE empty_t (a INTEGER, b TEXT);');
  const empty = engine.previewRows('empty_t', 100);
  assert.deepEqual(empty.columns, ['a', 'b']);
  assert.deepEqual(empty.rows, []);

  engine.runSql('CREATE TABLE many (id INTEGER);');
  engine.runSql('INSERT INTO many (id) VALUES (1),(2),(3),(4),(5);');
  assert.equal(engine.previewRows('many', 2).rows.length, 2);
});

test('previewRows rejects an unknown table instead of interpolating it into SQL', (t) => {
  const { engine } = makeEngine(t);
  assert.throws(() => engine.previewRows('no_such_table'), /Unknown table/);
});

test('reset drops every existing table including the migration ledger then rebuilds from the schema file', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql('CREATE TABLE stale (id INTEGER);');
  engine.ensureMigrationsTable();
  const schemaPath = path.join(dir, 'schema.sql');
  fs.writeFileSync(schemaPath, 'CREATE TABLE fresh (id INTEGER);');

  engine.reset(schemaPath);

  assert.deepEqual(engine.listTables(), ['fresh']);
});

test('migration ledger records applied files and lists them in filename order', (t) => {
  const { engine } = makeEngine(t);
  engine.ensureMigrationsTable();
  assert.deepEqual(engine.listAppliedMigrations(), []);

  engine.recordMigration('001_init.sql');
  engine.recordMigration('002_add_index.sql');

  assert.deepEqual(engine.listAppliedMigrations(), ['001_init.sql', '002_add_index.sql']);
});

test('health reports ok with the live table count', (t) => {
  const { engine } = makeEngine(t);
  engine.runSql('CREATE TABLE only_one (id INTEGER);');
  const result = engine.health();
  assert.equal(result.ok, true);
  assert.equal(result.tables, 1);
});

test('backup then restore round-trips data and restore overwrites the live database', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql('CREATE TABLE notes (body TEXT);');
  engine.runSql("INSERT INTO notes (body) VALUES ('hello');");
  const snapshot = path.join(dir, 'snapshot.db');

  engine.backup(snapshot);
  assert.ok(fs.existsSync(snapshot));

  engine.dropTable('notes');
  assert.deepEqual(engine.listTables(), []);

  engine.restore(snapshot);
  const rows = engine.open().prepare('SELECT body FROM notes').all();
  assert.deepEqual(rows.map((row) => row.body), ['hello']);
});
