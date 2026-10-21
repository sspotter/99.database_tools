import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeConnectionInput } from '../lib/connections.js';
import { runDatabaseTask } from '../lib/workspace-db.js';

// Opt in only with explicitly disposable targets. Never fall back to project connection variables.
async function fixture(t, engine, url) {
  const profile = normalizeConnectionInput({ name: 'Disposable integration', engine, url, readOnly: true });
  const suffix = randomUUID().replaceAll('-', '');
  const schema = engine === 'postgres' ? `toolkit_${suffix}` : profile.settings.database;
  const table = `items_${suffix}`;
  let connection;
  let query;
  let quote;
  if (engine === 'postgres') {
    const { Client } = await import('pg');
    connection = new Client({ connectionString: url });
    await connection.connect();
    query = async (sql) => (await connection.query(sql)).rows;
    quote = (name) => '"' + name.replaceAll('"', '""') + '"';
    await query(`CREATE SCHEMA ${quote(schema)}`);
    t.after(async () => {
      try { await query(`DROP SCHEMA ${quote(schema)} CASCADE`); } finally { await connection.end(); }
    });
  } else {
    const mysql = await import('mysql2/promise');
    connection = await mysql.createConnection({
      host: profile.settings.host, port: profile.settings.port, user: profile.settings.user,
      password: profile.settings.password, database: profile.settings.database,
    });
    query = async (sql) => (await connection.query(sql))[0];
    quote = (name) => '`' + name.replaceAll('`', '``') + '`';
    t.after(async () => {
      try { await query(`DROP TABLE IF EXISTS ${quote(schema)}.${quote(table)}`); } finally { await connection.end(); }
    });
  }
  const reference = `${quote(schema)}.${quote(table)}`;
  await query(`CREATE TABLE ${reference}(id INTEGER PRIMARY KEY, marker VARCHAR(100))`);
  await query(`INSERT INTO ${reference} VALUES(1,'first'),(2,'second')`);
  const task = (input, options) => runDatabaseTask(profile, {
    database: profile.settings.database, schema, ...input,
  }, options);
  return { profile, schema, table, reference, query, task };
}

for (const [engine, variable] of [['postgres', 'DB_TOOLKIT_TEST_POSTGRES_URL'], ['mysql', 'DB_TOOLKIT_TEST_MYSQL_URL']]) {
  const url = process.env[variable];
  test(`${engine}: disposable driver discovers objects, binds row pages, and inspects keys`, { skip: !url }, async (t) => {
    const f = await fixture(t, engine, url);
    assert.equal((await f.task({ action: 'test' })).ok, true);
    assert.ok((await f.task({ action: 'databases' })).databases.includes(f.profile.settings.database));
    assert.ok((await f.task({ action: 'schemas' })).schemas.includes(f.schema));
    assert.ok((await f.task({ action: 'tables' })).tables.some((item) => item.name === f.table && item.schema === f.schema));
    const page = await f.task({ action: 'rows', table: f.table, limit: 1 });
    assert.equal(page.rows[0].marker, 'first');
    assert.equal(page.hasMore, true);
    const filtered = await f.task({ action: 'rows', table: f.table, filterColumn: 'marker', filterValue: 'first\' OR 1=1 --' });
    assert.deepEqual(filtered.rows, []);
    const metadata = await f.task({ action: 'inspect', table: f.table });
    assert.ok(metadata.columns.some((column) => column.name === 'id' && column.primaryKey));
    assert.deepEqual((await f.task({ action: 'query', sql: `SELECT marker AS value FROM ${f.reference} WHERE 1=0` })).columns, ['value']);
    await assert.rejects(f.task({ action: 'query', sql: `DELETE FROM ${f.reference}` }));
    assert.equal((await f.query(`SELECT COUNT(*) AS n FROM ${f.reference}`))[0].n, engine === 'postgres' ? '2' : 2);
  });

  test(`${engine}: writable SQL commits against the selected database and PostgreSQL schema`, { skip: !url }, async (t) => {
    const f = await fixture(t, engine, url);
    const table = engine === 'postgres' ? '"' + f.table + '"' : f.reference;
    await runDatabaseTask({ ...f.profile, readOnly: false }, {
      action: 'query', database: f.profile.settings.database, schema: f.schema,
      sql: `UPDATE ${table} SET marker='changed' WHERE id=1`,
    });
    const result = await f.task({ action: 'query', sql: `SELECT marker FROM ${table} WHERE id=1` });
    assert.equal(result.rows[0].marker, 'changed');
    await assert.rejects(f.task({ action: 'query', sql: 'SELECT 1 AS same,2 AS same' }), /duplicate|alias|column/i);
  });

  test(`${engine}: cancelling a sleeping query removes its server operation`, { skip: !url }, async (t) => {
    const f = await fixture(t, engine, url);
    const marker = `toolkit_cancel_${randomUUID().replaceAll('-', '')}`;
    const controller = new AbortController();
    const sql = `SELECT ${engine === 'postgres' ? 'pg_sleep' : 'SLEEP'}(60) /* ${marker} */`;
    const pending = f.task({ action: 'query', sql }, { signal: controller.signal });
    const rejected = assert.rejects(pending, /cancel|abort/i);
    const monitor = engine === 'postgres'
      ? `SELECT query AS operation FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active'`
      : 'SELECT INFO AS operation FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID()';
    let sawQuery = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await f.query(monitor)).some((row) => row.operation?.includes(marker))) { sawQuery = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    controller.abort();
    await rejected;
    assert.equal(sawQuery, true, 'The operation must be active on the server before cancelling it.');
    let remains = true;
    for (let attempt = 0; attempt < 30; attempt++) {
      remains = (await f.query(monitor)).some((row) => row.operation?.includes(marker));
      if (!remains) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(remains, false);
    assert.equal((await f.task({ action: 'test' })).ok, true);
  });
}

test('postgres: duplicate RETURNING aliases roll back the write and JSON cells stay bounded', {
  skip: !process.env.DB_TOOLKIT_TEST_POSTGRES_URL,
}, async (t) => {
  const f = await fixture(t, 'postgres', process.env.DB_TOOLKIT_TEST_POSTGRES_URL);
  await assert.rejects(runDatabaseTask({ ...f.profile, readOnly: false }, {
    action: 'query', schema: f.schema,
    sql: `INSERT INTO ${f.reference} VALUES(3,'third') RETURNING id AS same,marker AS same`,
  }), /duplicate|alias|column/i);
  assert.equal((await f.query(`SELECT COUNT(*) AS n FROM ${f.reference}`))[0].n, '2');
  const result = await f.task({ action: 'query', sql: "SELECT json_build_object('payload',repeat('x',100000)) AS payload" });
  assert.ok(JSON.stringify(result.rows[0].payload).length < 17000);
  assert.ok(result.truncatedValues > 0);
});

test('postgres: composite foreign key inspection preserves column pairing', {
  skip: !process.env.DB_TOOLKIT_TEST_POSTGRES_URL,
}, async (t) => {
  const f = await fixture(t, 'postgres', process.env.DB_TOOLKIT_TEST_POSTGRES_URL);
  const target = `"${f.schema}"."target"`;
  const child = `"${f.schema}"."child"`;
  await f.query(`CREATE TABLE ${target}(a INTEGER,b INTEGER,PRIMARY KEY(a,b))`);
  await f.query(`CREATE TABLE ${child}(id INTEGER PRIMARY KEY,x INTEGER,y INTEGER,FOREIGN KEY(x,y) REFERENCES ${target}(a,b))`);
  const result = await f.task({ action: 'inspect', table: 'child' });
  assert.equal(result.foreignKeys.length, 2);
  assert.deepEqual(result.foreignKeys.map((key) => [key.column, key.referencedColumn]), [['x', 'a'], ['y', 'b']]);
});
