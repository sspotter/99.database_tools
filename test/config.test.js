import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDatabaseConfig } from '../config/database.js';

// loadDatabaseConfig reads db-toolkit.manifest.json from cwd; using a fresh temp
// dir as cwd isolates each test from the repo's real manifest/env.
function tmpCwd(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtk-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('with no engine signals at all, config defaults to sqlite at data/toolkit.db', (t) => {
  const cwd = tmpCwd(t);
  const config = loadDatabaseConfig({}, cwd);
  assert.equal(config.engine, 'sqlite');
  assert.equal(config.databaseName, 'app_database');
  assert.equal(config.sqlite.file, path.resolve(cwd, 'data/toolkit.db'));
});

test('explicit override engine wins over DB_ENGINE in the environment', (t) => {
  const cwd = tmpCwd(t);
  const config = loadDatabaseConfig({ DB_ENGINE: 'mysql' }, cwd, 'postgres');
  assert.equal(config.engine, 'postgres');
});

// Guards the engine-name normalization that is currently duplicated across
// modules (fix-plan Task 1.2) — these aliases must all collapse consistently.
const normalizationCases = [
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['postgress', 'postgres'],
  ['mysql', 'mysql'],
  ['mssql', 'mssql'],
  ['sqlserver', 'mssql'],
  ['sqlite', 'sqlite'],
];

for (const [input, expected] of normalizationCases) {
  test(`DB_ENGINE "${input}" resolves to engine "${expected}"`, (t) => {
    const cwd = tmpCwd(t);
    assert.equal(loadDatabaseConfig({ DB_ENGINE: input }, cwd).engine, expected);
  });
}

test('postgres URL is decomposed into host, port, user, decoded password and database', (t) => {
  const cwd = tmpCwd(t);
  const url = 'postgres://user:p%40ss@db.host:6543/shop';
  const config = loadDatabaseConfig({ LOCAL_DATABASE_URL: url }, cwd);
  assert.equal(config.engine, 'postgres');
  assert.equal(config.databaseName, 'shop');
  assert.equal(config.postgres.host, 'db.host');
  assert.equal(config.postgres.port, 6543);
  assert.equal(config.postgres.user, 'user');
  assert.equal(config.postgres.password, 'p@ss');
  assert.equal(config.postgres.database, 'shop');
  assert.equal(config.postgres.connectionString, url);
});

test('mysql URL without a port falls back to the default mysql port', (t) => {
  const cwd = tmpCwd(t);
  const config = loadDatabaseConfig({ DATABASE_URL: 'mysql://root:pw@localhost/app' }, cwd);
  assert.equal(config.engine, 'mysql');
  assert.equal(config.mysql.port, 3306);
});

test('sqlite URL resolves the file path and derives the database name from it', (t) => {
  const cwd = tmpCwd(t);
  const config = loadDatabaseConfig({ DATABASE_URL: 'sqlite:custom/app.db' }, cwd);
  assert.equal(config.engine, 'sqlite');
  assert.equal(config.databaseName, 'app');
  assert.equal(config.sqlite.file, path.resolve(cwd, 'custom/app.db'));
});
