import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDatabaseTask, getCapabilities } from '../lib/workspace-db.js';
import { singleStatement, analyzeStatement, assertQualifiedSqlServerTables } from '../lib/workspace-sql.js';
import * as serverEngines from '../lib/workspace-server-engines.js';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-db-'));
  const file = path.join(dir, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE "literal.dot" (id INTEGER PRIMARY KEY, body TEXT DEFAULT 'empty');
    INSERT INTO "literal.dot" VALUES (1,'alpha'),(2,'beta'),(3,'alpha');
    CREATE VIEW notes_view AS SELECT * FROM "literal.dot";
    CREATE INDEX body_idx ON "literal.dot" (body);`);
  db.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { engine: 'sqlite', readOnly: true, settings: { file } };
}

test('connection test never creates a missing SQLite file', async (t) => {
  const p = fixture(t);
  p.settings.file += '.missing';
  await assert.rejects(runDatabaseTask(p, { action: 'test' }), /exist|open/i);
  assert.equal(fs.existsSync(p.settings.file), false);
});

test('SQLite explorer preserves literal dotted object names and returns metadata', async (t) => {
  const p = fixture(t);
  assert.deepEqual(await runDatabaseTask(p, { action: 'test' }), { ok: true });
  assert.deepEqual(await runDatabaseTask(p, { action: 'schemas' }), { schemas: ['main'] });
  const objects = await runDatabaseTask(p, { action: 'tables', schema: 'main' });
  assert.deepEqual(objects.tables, [
    { schema: 'main', name: 'literal.dot', type: 'table' },
    { schema: 'main', name: 'notes_view', type: 'view' },
  ]);
  const info = await runDatabaseTask(p, { action: 'inspect', schema: 'main', table: 'literal.dot' });
  assert.equal(info.columns[0].name, 'id');
  assert.equal(info.columns[0].primaryKey, true);
  assert.ok(info.indexes.some((index) => index.name === 'body_idx' && index.columns[0] === 'body'));
  assert.match(info.definition, /CREATE TABLE/);
});

test('row pages bind filter values, validate identifiers and retain empty-result columns', async (t) => {
  const p = fixture(t);
  const task = { action: 'rows', schema: 'main', table: 'literal.dot', limit: 1,
    sortColumn: 'id', sortDirection: 'desc', filterColumn: 'body', filterValue: 'alpha' };
  const page = await runDatabaseTask(p, task);
  assert.deepEqual(page.columns, ['id', 'body']);
  assert.deepEqual(page.rows, [{ id: 3, body: 'alpha' }]);
  assert.equal(page.hasMore, true);
  assert.deepEqual((await runDatabaseTask(p, { ...task, offset: 1 })).rows, [{ id: 1, body: 'alpha' }]);
  const empty = await runDatabaseTask(p, { ...task, filterValue: "' OR 1=1 --" });
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.columns, ['id', 'body']);
  await assert.rejects(runDatabaseTask(p, { ...task, sortColumn: 'id; DROP TABLE notes_view' }), /column/i);
  await assert.rejects(runDatabaseTask(p, { ...task, schema: 'other' }), /schema|table/i);
  await assert.rejects(runDatabaseTask(p, { ...task, limit: -1 }), /limit/i);
});

test('read-only SQL rejects writes including attempts to disable query_only', async (t) => {
  const p = fixture(t);
  for (const sql of ['DELETE FROM "literal.dot"', 'PRAGMA query_only=OFF', 'ATTACH DATABASE \'new.db\' AS extra']) {
    await assert.rejects(runDatabaseTask(p, { action: 'query', sql }), /read.only|not allowed|readonly/i);
  }
  assert.equal((await runDatabaseTask(p, { action: 'rows', table: 'literal.dot' })).rows.length, 3);
});

test('SQL scanner handles quoted/comment semicolons and rejects hidden second statements', async (t) => {
  const p = fixture(t);
  const result = await runDatabaseTask(p, { action: 'query', sql: "SELECT ';' AS value /* ; */; -- ;\n" });
  assert.deepEqual(result.rows, [{ value: ';' }]);
  await assert.rejects(runDatabaseTask(p, { action: 'query', sql: 'SELECT 1; /* comment */ DELETE FROM "literal.dot"' }), /one statement/i);
  await assert.rejects(runDatabaseTask(p, { action: 'query', sql: "SELECT 'unterminated" }), /unterminated/i);
});

test('SQL results are bounded while writable SQL persists only when explicitly enabled', async (t) => {
  const p = fixture(t);
  const result = await runDatabaseTask(p, { action: 'query', limit: 3,
    sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000) SELECT x FROM n' });
  assert.deepEqual(result.rows, [{ x: 1 }, { x: 2 }, { x: 3 }]);
  assert.equal(result.hasMore, true);
  await runDatabaseTask({ ...p, readOnly: false }, { action: 'query', sql: 'INSERT INTO "literal.dot" VALUES(4,\'write\')' });
  assert.equal((await runDatabaseTask(p, { action: 'rows', table: 'literal.dot' })).rows.length, 4);
});

test('writable CTE SQL executes once and reports successful changes without a result set', async (t) => {
  const p = fixture(t);
  const result = await runDatabaseTask({ ...p, readOnly: false }, { action: 'query',
    sql: 'WITH source(x) AS (SELECT 9) INSERT INTO "literal.dot"(id) SELECT x FROM source' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.rowCount, 1);
  assert.equal((await runDatabaseTask(p, { action: 'rows', table: 'literal.dot' })).rows.length, 4);
});

test('timeout and abort terminate running SQLite work without blocking another task', async (t) => {
  const p = fixture(t);
  const sql = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n';
  await assert.rejects(runDatabaseTask(p, { action: 'query', sql }, { timeoutMs: 1000 }), /timed out|timeout/i);
  const controller = new AbortController();
  const running = runDatabaseTask(p, { action: 'query', sql }, { signal: controller.signal });
  const cancelled = assert.rejects(running, /cancel|abort/i);
  setTimeout(() => controller.abort(), 600);
  assert.deepEqual(await runDatabaseTask(p, { action: 'test' }), { ok: true });
  await cancelled;
  // A fresh writer can lock and change the file after the interrupted worker exits.
  const db = new DatabaseSync(p.settings.file);
  db.exec('BEGIN EXCLUSIVE; INSERT INTO "literal.dot" VALUES(4,\'released\'); COMMIT;');
  db.close();
});

test('SQL Server advertises browsing but disables unenforceable read-only SQL', () => {
  assert.equal(getCapabilities('mssql').browse, true);
  assert.equal(getCapabilities('mssql').readOnlyQuery, false);
});

test('SQL results serialize large integers and binary cells and visibly truncate large values', async (t) => {
  const p = fixture(t);
  const result = await runDatabaseTask(p, { action: 'query',
    sql: "SELECT 9223372036854775807 AS big, x'0102ff' AS bytes, printf('%050000d',1) AS huge" });
  assert.equal(result.rows[0].big, '9223372036854775807');
  assert.equal(result.rows[0].bytes, '0x0102ff');
  assert.ok(result.rows[0].huge.length < 17000);
  assert.ok(result.truncatedValues > 0);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('empty SQL result retains selected column aliases on the bundled Node runtime', async (t) => {
  const p = fixture(t);
  const result = await runDatabaseTask(p, { action: 'query', sql: 'SELECT id AS identity,body FROM "literal.dot" WHERE 0' });
  assert.deepEqual(result.columns, ['identity', 'body']);
  assert.deepEqual(result.rows, []);
});

test('invalid tasks fail before opening any network connection', async () => {
  const p = { engine: 'postgres', settings: { host: 'invalid.invalid', password: 'sensitive' } };
  for (const task of [{ action: 'other' }, { action: 'rows', table: 'x', limit: 1001 },
    { action: 'query', sql: 'SELECT 1; SELECT 2' }, { action: 'rows', table: 'x', filterColumn: 'a', filterValue: {} }]) {
    await assert.rejects(runDatabaseTask(p, task), (error) => error.code === 'INVALID_TASK');
  }
});

test('statement scanner handles dialect quotes and rejects ambiguous SQL Server batches', () => {
  assert.equal(singleStatement('SELECT $tag$;inside$tag$; -- tail', 'postgres'), 'SELECT $tag$;inside$tag$');
  assert.equal(singleStatement("SELECT E'escape\\\';value';", 'postgres'), "SELECT E'escape\\\';value'");
  assert.equal(singleStatement('SELECT [semi;column] FROM [semi;table];', 'mssql'), 'SELECT [semi;column] FROM [semi;table]');
  assert.equal(singleStatement('SELECT 1 /* outer /* nested */ end */;', 'postgres'), 'SELECT 1 /* outer /* nested */ end */');
  assert.throws(() => singleStatement('SELECT 1 /*!; DELETE FROM t */', 'mysql'), /comments/i);
  assert.throws(() => singleStatement('SELECT 1 SELECT 2', 'mssql'), /one statement|unsupported/i);
  assert.throws(() => singleStatement('BEGIN DELETE FROM t END', 'mssql'), /unsupported/i);
  assert.throws(() => singleStatement('SELECT 1 RETURN', 'mssql'), /one statement|unsupported/i);
});

test('driver TLS configuration verifies MySQL hostname in verify-full and distinguishes explicit weaker modes', () => {
  const strict = serverEngines.tlsOptions({ sslMode: 'verify-full' });
  assert.equal(strict.rejectUnauthorized, true);
  assert.equal(strict.verifyIdentity, true);
  const caOnly = serverEngines.tlsOptions({ sslMode: 'verify-ca' });
  assert.equal(caOnly.rejectUnauthorized, true);
  assert.equal(caOnly.verifyIdentity, false);
  assert.equal(serverEngines.tlsOptions({ sslMode: 'require' }).rejectUnauthorized, false);
  assert.equal(serverEngines.tlsOptions({ sslMode: 'disable' }), false);
});

test('MySQL read-only SQL rejects procedure and transaction commands that could escape its read-only transaction', async () => {
  const p = { engine: 'mysql', readOnly: true, settings: { host: 'invalid.invalid' } };
  for (const sql of ['CALL commits_and_writes()', 'COMMIT', 'SET SESSION transaction_read_only=0']) {
    await assert.rejects(runDatabaseTask(p, { action: 'query', sql }), (error) => error.code === 'INVALID_TASK');
  }
});

test('workers support callers started with Node input-type eval flags', (t) => {
  const p = fixture(t);
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../lib/workspace-db.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {runDatabaseTask} from ${JSON.stringify(moduleUrl)}; await runDatabaseTask(${JSON.stringify(p)},{action:'test'});`],
  { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('duplicate result labels fail explicitly and duplicate write RETURNING rolls back', async (t) => {
  const p = fixture(t);
  await assert.rejects(runDatabaseTask(p, { action: 'query', sql: 'SELECT 1 AS x,2 AS x' }), /duplicate.*column|aliases/i);
  await assert.rejects(runDatabaseTask({ ...p, readOnly: false }, { action: 'query',
    sql: 'INSERT INTO "literal.dot" VALUES(4,\'no change\') RETURNING id AS x,body AS x' }), /duplicate.*column|aliases/i);
  assert.equal((await runDatabaseTask(p, { action: 'rows', table: 'literal.dot' })).rows.length, 3);
});

test('SQL Server selected-schema queries require explicitly qualified physical tables', async () => {
  const p = { engine: 'mssql', readOnly: false, settings: { host: 'invalid.invalid' } };
  await assert.rejects(runDatabaseTask(p, { action: 'query', schema: 'analytics', sql: 'SELECT * FROM users' }),
    (error) => error.code === 'INVALID_TASK' && /qualif/i.test(error.message));
});

test('SQL Server aliases cannot exempt physical sources or leak into sibling queries', () => {
  for (const sql of [
    'SELECT * FROM users AS users',
    'UPDATE users SET marker=1 FROM users AS users',
    'DELETE users FROM users AS users',
    'SELECT * FROM analytics.accounts AS users JOIN users AS u ON users.id=u.id',
    'SELECT * FROM analytics.accounts AS users WHERE EXISTS(SELECT * FROM users)',
    'SELECT * FROM analytics.accounts WHERE EXISTS(SELECT * FROM analytics.users AS users) AND EXISTS(SELECT * FROM users)',
    'WITH c AS (SELECT * FROM later), later AS (SELECT 1 AS id) SELECT * FROM c',
    'SELECT * INTO users FROM analytics.accounts',
    'SELECT * INTO [literal.dot] FROM analytics.accounts',
  ]) {
    assert.throws(() => assertQualifiedSqlServerTables(analyzeStatement(sql, 'mssql').ast), /qualif/i, sql);
  }
});

test('new actions are registered; count requires a table; unknown actions are rejected', async (t) => {
  const p = fixture(t);
  const caps = getCapabilities('sqlite');
  assert.deepEqual([caps.count, caps.catalog, caps.serverInfo], [true, true, true]);
  await assert.rejects(runDatabaseTask(p, { action: 'count' }), /Table is required/);
  await assert.rejects(runDatabaseTask(p, { action: 'bogus' }), /Unsupported database action/);
});

function relational(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-rel-'));
  const file = path.join(dir, 'rel.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers, status TEXT, total NUMERIC);
    CREATE INDEX idx_orders_customer ON orders(customer_id);
    INSERT INTO customers VALUES (1,'a'),(2,'b');
    INSERT INTO orders VALUES (1,1,'paid',10),(2,1,'pending',20),(3,2,'paid',30);
    CREATE VIEW order_totals AS SELECT customer_id, SUM(total) AS total FROM orders GROUP BY customer_id;`);
  db.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { engine: 'sqlite', readOnly: true, settings: { file } };
}

test('SQLite inspect is normalized: implicit FK target resolved, synthetic primary key first', async (t) => {
  const p = relational(t);
  const info = await runDatabaseTask(p, { action: 'inspect', schema: 'main', table: 'orders' });
  assert.deepEqual(info.primaryKey, ['id']);
  assert.deepEqual(info.foreignKeys, [{ name: null, column: 'customer_id', referencedSchema: 'main', referencedTable: 'customers', referencedColumn: 'id' }]);
  assert.deepEqual(info.indexes.map((i) => [i.name, i.primary]), [['PRIMARY KEY', true], ['idx_orders_customer', false]]);
  assert.equal(info.columns.find((c) => c.name === 'customer_id').foreignKey, true);
});

test('SQLite count shares the row filter, handles NULL filters, views, and unknown columns', async (t) => {
  const p = relational(t);
  const count = (extra = {}) => runDatabaseTask(p, { action: 'count', schema: 'main', table: 'orders', ...extra });
  assert.deepEqual(await count(), { total: 3, exact: true });
  assert.deepEqual(await count({ filterColumn: 'status', filterValue: 'paid' }), { total: 2, exact: true });
  assert.deepEqual(await count({ filterColumn: 'status', filterValue: null }), { total: 0, exact: true });
  await assert.rejects(count({ filterColumn: 'nope', filterValue: 1 }), /Unknown column/);
  assert.deepEqual(await runDatabaseTask(p, { action: 'count', table: 'order_totals' }), { total: 2, exact: true });
});

test('SQLite serverInfo and catalog', async (t) => {
  const p = relational(t);
  const info = await runDatabaseTask(p, { action: 'serverInfo' });
  assert.equal(info.product, 'SQLite');
  assert.match(info.version, /^\d+\.\d+/);
  assert.deepEqual(await runDatabaseTask(p, { action: 'catalog' }), {
    schemas: [{ name: 'main', objects: [
      { schema: 'main', name: 'customers', type: 'table' },
      { schema: 'main', name: 'order_totals', type: 'view' },
      { schema: 'main', name: 'orders', type: 'table' },
    ] }],
    defaultSchema: 'main',
  });
});

test('SQLite catalog caps at 10000 objects', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-db-cap-'));
  const file = path.join(dir, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec('BEGIN');
  for (let i = 0; i < 10001; i += 1) db.exec(`CREATE TABLE t${i} (id INTEGER)`);
  db.exec('COMMIT');
  db.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = { engine: 'sqlite', readOnly: true, settings: { file } };
  await assert.rejects(runDatabaseTask(p, { action: 'catalog' }), /exceeds 10000 objects/);
});

test('SQL Server qualified sources support write aliases and scoped CTE references', () => {
  for (const sql of [
    'SELECT * FROM analytics.users AS users',
    'UPDATE u SET marker=1 FROM analytics.users AS u',
    'DELETE u FROM analytics.users AS u',
    'WITH users AS (SELECT * FROM analytics.users) SELECT * FROM users',
    'WITH users AS (SELECT * FROM analytics.users) UPDATE users SET marker=1',
    'WITH first AS (SELECT * FROM analytics.users), second AS (SELECT * FROM first) SELECT * FROM second',
    'WITH users AS (SELECT * FROM analytics.users) SELECT * FROM analytics.accounts WHERE EXISTS(SELECT * FROM users)',
    'SELECT * FROM (SELECT * FROM analytics.users) AS users',
  ]) {
    assert.doesNotThrow(() => assertQualifiedSqlServerTables(analyzeStatement(sql, 'mssql').ast), sql);
  }
});
