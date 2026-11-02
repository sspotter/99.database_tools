import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteEngine } from '../lib/engines/sqlite.js';
import { listSqlFiles } from '../lib/utils.js';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

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

test('opening waits for an external write lock before initializing durability pragmas', async t => {
  const { engine } = makeEngine(t);
  engine.runSql('CREATE TABLE notes(body TEXT)');
  engine.close();
  const peer = spawn(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 400);
  `, engine.databasePath], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise((resolve, reject) => { peer.on('exit', resolve); peer.on('error', reject); });
  t.after(async () => { if (peer.exitCode === null) peer.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => { peer.stdout.once('data', resolve); peer.once('error', reject); });
  assert.deepEqual(engine.listTables(), ['notes']);
  assert.equal(await exited, 0);
});

test('opening recovers committed WAL pages and retains durable journal settings', (t) => {
  const { engine } = makeEngine(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE recovered(id INTEGER); INSERT INTO recovered VALUES(42)");
    process.exit(0);
  `, engine.databasePath], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(fs.statSync(engine.databasePath + '-wal').size > 0);
  assert.deepEqual(engine.open().prepare('SELECT id FROM recovered').all().map(r => r.id), [42]);
  assert.equal(engine.open().prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.ok(engine.open().prepare('PRAGMA synchronous').get().synchronous >= 1);
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

test('backup includes committed WAL pages while another connection stays open', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(body TEXT);');
  const peer = new DatabaseSync(engine.databasePath);
  try {
    peer.exec("INSERT INTO notes VALUES('committed in WAL')");
    const snapshot = path.join(dir, "snapshot with ' quote.db");
    assert.equal(engine.backup(snapshot), snapshot);
    const copy = new DatabaseSync(snapshot, { readOnly: true });
    try {
      assert.deepEqual(copy.prepare('SELECT body FROM notes').all().map(row => row.body), ['committed in WAL']);
    } finally { copy.close(); }
  } finally { peer.close(); }
});

test('backup refuses an existing output without overwriting it', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql('CREATE TABLE notes(body TEXT)');
  const snapshot = path.join(dir, 'snapshot.db');
  fs.writeFileSync(snapshot, 'keep this backup');
  assert.throws(() => engine.backup(snapshot));
  assert.equal(fs.readFileSync(snapshot, 'utf8'), 'keep this backup');
});

test('backup snapshots an initialized database with no tables', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.createDatabase();
  const snapshot = path.join(dir, 'empty.db');
  engine.backup(snapshot);
  engine.restore(snapshot);
  assert.deepEqual(engine.listTables(), []);
});

test('restore rejects a truncated SQLite database before replacing data', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('original')");
  const snapshot = path.join(dir, 'truncated.db');
  engine.backup(snapshot);
  fs.truncateSync(snapshot, 200);
  assert.throws(() => engine.restore(snapshot));
  assert.deepEqual(engine.previewRows('notes').rows.map(row => row.body), ['original']);
});

test('restore reopens the original if the published database cannot be opened', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('snapshot')");
  const snapshot = path.join(dir, 'snapshot.db');
  engine.backup(snapshot);
  engine.runSql("UPDATE notes SET body='original'");
  const open = engine.open.bind(engine);
  t.mock.method(engine, 'open', () => {
    if (!engine.db) throw new Error('injected reopen failure');
    return open();
  });
  assert.throws(() => engine.restore(snapshot), /reopen failure/);
  t.mock.restoreAll();
  assert.deepEqual(engine.previewRows('notes').rows.map(row => row.body), ['original']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['snapshot.db', 'test.db']);
});

for (const invalid of ['not SQLite', '', 'SQLite format 3\0']) {
  test(`restore preserves the original when input is invalid (${invalid.length} bytes)`, (t) => {
    const { engine, dir } = makeEngine(t);
    engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('original')");
    const input = path.join(dir, 'invalid.db');
    fs.writeFileSync(input, invalid);
    assert.throws(() => engine.restore(input));
    assert.deepEqual(engine.previewRows('notes').rows.map(row => row.body), ['original']);
  });
}

test('restore refuses same-file paths and hardlink aliases', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('original')");
  const alias = path.join(dir, 'alias.db');
  fs.linkSync(engine.databasePath, alias);
  for (const input of [engine.databasePath, alias]) assert.throws(() => engine.restore(input), /same|alias/i);
  assert.deepEqual(engine.previewRows('notes').rows.map(row => row.body), ['original']);
});

test('restore refuses a busy WAL target and preserves peer committed rows', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('snapshot')");
  const snapshot = path.join(dir, 'snapshot.db');
  engine.backup(snapshot);
  engine.runSql('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  engine.open().exec('PRAGMA busy_timeout=50');
  const peer = new DatabaseSync(engine.databasePath);
  try {
    peer.exec("INSERT INTO notes VALUES('peer'); BEGIN; SELECT * FROM notes;");
    assert.throws(() => engine.restore(snapshot), /busy|locked|maintenance/i);
    assert.deepEqual(peer.prepare('SELECT body FROM notes').all().map(row => row.body), ['snapshot', 'peer']);
    assert.ok(fs.existsSync(engine.databasePath + '-wal'));
    peer.exec('ROLLBACK');
    assert.deepEqual(engine.previewRows('notes').rows.map(row => row.body), ['snapshot', 'peer']);
  } finally { peer.close(); }
});

test('restore publication failure preserves the original and removes its stage', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('snapshot')");
  const snapshot = path.join(dir, 'snapshot.db');
  engine.backup(snapshot);
  engine.runSql("UPDATE notes SET body='original'");
  t.mock.method(fs, 'renameSync', () => { throw new Error('injected publication failure'); });
  assert.throws(() => engine.restore(snapshot), /publication failure/);
  assert.deepEqual(engine.previewRows('notes').rows.map(row => row.body), ['original']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['snapshot.db', 'test.db']);
});

test('restore refuses orphan recovery sidecars instead of opening them with a new target', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql('CREATE TABLE notes(body TEXT)');
  const snapshot = path.join(dir, 'snapshot.db');
  engine.backup(snapshot);
  engine.close();
  fs.unlinkSync(engine.databasePath);
  const journal = engine.databasePath + '-journal';
  fs.writeFileSync(journal, 'recovery evidence');
  assert.throws(() => engine.restore(snapshot), /recovery|maintenance|sidecar/i);
  assert.equal(fs.readFileSync(journal, 'utf8'), 'recovery evidence');
  assert.equal(fs.existsSync(engine.databasePath), false);
});

test('restore refuses symbolic aliases without changing the linked database', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('original')");
  const alias = path.join(dir, 'symbolic.db');
  try { fs.symlinkSync(engine.databasePath, alias); } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('Windows symlink privilege unavailable');
    return;
  }
  assert.throws(() => engine.restore(alias), /same|alias/i);
  const linked = new SqliteEngine({ engine: 'sqlite', sqlite: { file: alias } });
  try {
    assert.throws(() => linked.restore(engine.databasePath), /symlink|alias/i);
    assert.deepEqual(engine.previewRows('notes').rows.map(row => row.body), ['original']);
  } finally { linked.close(); }
});

test('restore refuses an active rollback-journal reader without replacing its data', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('original')");
  const snapshot = path.join(dir, 'snapshot.db');
  engine.backup(snapshot);
  engine.open().exec('PRAGMA busy_timeout=50');
  const peer = new DatabaseSync(engine.databasePath);
  try {
    peer.exec('BEGIN; SELECT * FROM notes;');
    assert.throws(() => engine.restore(snapshot), /busy|locked/i);
    assert.deepEqual(peer.prepare('SELECT body FROM notes').all().map(row => row.body), ['original']);
    peer.exec('ROLLBACK');
  } finally { peer.close(); }
});

test('restore checkpoints its own WAL before replacing the target', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('snapshot')");
  const snapshot = path.join(dir, 'snapshot.db');
  engine.backup(snapshot);
  engine.runSql("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE notes SET body='later WAL row'");
  assert.equal(engine.restore(snapshot), engine.databasePath);
  assert.deepEqual(engine.previewRows('notes').rows.map(row => row.body), ['snapshot']);
  engine.close();
  assert.deepEqual(engine.previewRows('notes').rows.map(row => row.body), ['snapshot']);
});

test('restore retains a readable recovery original if rollback publication also fails', (t) => {
  const { engine, dir } = makeEngine(t);
  engine.runSql("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('snapshot')");
  const snapshot = path.join(dir, 'snapshot.db');
  engine.backup(snapshot);
  engine.runSql("UPDATE notes SET body='original'");
  const open = engine.open.bind(engine);
  t.mock.method(engine, 'open', () => {
    if (!engine.db) throw new Error('injected reopen failure');
    return open();
  });
  const rename = fs.renameSync.bind(fs);
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (path.basename(source) === 'original.db') throw new Error('injected rollback failure');
    rename(source, target);
  });
  assert.throws(() => engine.restore(snapshot), AggregateError);
  const recoveryDir = fs.readdirSync(dir).find(name => name.startsWith('.dbtk-restore-'));
  assert.ok(recoveryDir);
  const recovered = new DatabaseSync(path.join(dir, recoveryDir, 'original.db'), { readOnly: true });
  try {
    assert.deepEqual(recovered.prepare('SELECT body FROM notes').all().map(row => row.body), ['original']);
  } finally { recovered.close(); }
  assert.equal(fs.existsSync(engine.databasePath + '.dbtk-restore.lock'), false);
});
