import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDatabaseConfig } from '../config/database.js';
import { SqliteEngine } from '../lib/engines/sqlite.js';
import { runCommand } from '../lib/commands.js';
import * as toolchain from '../lib/toolchain.js';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtk-cli-safety-'));
  const config = loadDatabaseConfig({}, cwd);
  const engine = new SqliteEngine(config);
  const context = { cwd, config, engine, args: [], options: { nonInteractive: true }, confirm: async () => true };
  t.after(() => { engine.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return context;
}

test('CLI migration failure preserves earlier files but rolls back the current file and ledger', async (t) => {
  const context = fixture(t);
  fs.mkdirSync(context.config.defaults.migrationsDir, { recursive: true });
  fs.writeFileSync(path.join(context.config.defaults.migrationsDir, '001_valid.sql'), 'CREATE TABLE kept(id INTEGER);');
  fs.writeFileSync(path.join(context.config.defaults.migrationsDir, '002_failure.sql'), 'CREATE TABLE partial(id INTEGER); INSERT INTO missing_table VALUES(1);');
  await assert.rejects(runCommand({ ...context, command: 'migrate' }));
  assert.ok(context.engine.listTables().includes('kept'));
  assert.equal(context.engine.listTables().includes('partial'), false);
  assert.deepEqual(context.engine.listAppliedMigrations(), ['001_valid.sql']);
});

test('native client requirements follow the actual operation and driver', () => {
  assert.equal(typeof toolchain.requiredClientForOperation, 'function');
  for (const [engine, command, executable] of [
    ['postgres', 'backup', 'pg_dump'], ['postgres', 'restore', 'psql'],
    ['mysql', 'backup', 'mysqldump'], ['mysql', 'restore', 'mysql'],
    ['mysql', 'tables', 'mysql'], ['mssql', 'tables', 'sqlcmd'],
  ]) assert.equal(toolchain.requiredClientForOperation(engine, command).executable, executable);
  for (const [engine, command] of [['sqlite', 'backup'], ['postgres', 'migrate'], ['postgres', 'init'], ['mysql', 'migrate'], ['mssql', 'migrate']]) {
    assert.equal(toolchain.requiredClientForOperation(engine, command), null);
  }
});

test('backup names remain distinct when multiple snapshots are made within one second', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T12:00:00Z') });
  const context = fixture(t);
  context.engine.runSql('CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(1);');
  await runCommand({ ...context, command: 'backup' });
  await runCommand({ ...context, command: 'backup' });
  const files = fs.readdirSync(context.config.defaults.backupDir);
  assert.equal(files.length, 2);
  assert.notEqual(files[0], files[1]);
});

test('PostgreSQL restore confirmation names the empty target and avoids an overwrite promise', async (t) => {
  const context = fixture(t);
  const input = path.join(context.cwd, 'empty.sql');
  fs.writeFileSync(input, '-- disposable fixture');
  const clientDirectory = path.join(context.cwd, 'clients');
  fs.mkdirSync(clientDirectory);
  fs.writeFileSync(path.join(clientDirectory, process.platform === 'win32' ? 'psql.exe' : 'psql'), '');
  const originalPath = process.env.PATH;
  process.env.PATH = clientDirectory;
  t.after(() => { process.env.PATH = originalPath; });
  let prompt;
  await runCommand({ ...context, command: 'restore', args: [input], config: { ...context.config, engine: 'postgres', databaseName: 'display_name', postgres: { database: 'dbtk_test_empty' } },
    engine: { restore: async () => { throw new Error('Restore must not execute after declined confirmation.'); } },
    confirm: async (message) => { prompt = message; return false; },
  });
  assert.match(prompt, /empty.*PostgreSQL|PostgreSQL.*empty/i);
  assert.match(prompt, /dbtk_test_empty/);
  assert.doesNotMatch(prompt, /overwrite/i);
});


test('missing pg_dump fails before opening a PostgreSQL backup connection', async (t) => {
  const context = fixture(t);
  const originalPath = process.env.PATH;
  process.env.PATH = context.cwd;
  t.after(() => { process.env.PATH = originalPath; });
  await assert.rejects(runCommand({ ...context, command: 'backup',
    config: { ...context.config, engine: 'postgres', databaseName: 'dbtk_test_missing' },
    engine: { backup: async () => { throw new Error('Should not reach the database without pg_dump.'); } },
  }), /Missing required client: pg_dump/);
});


test('MySQL restore confirmation uses the configured driver database', async (t) => {
  const context = fixture(t);
  const input = path.join(context.cwd, 'input.sql');
  fs.writeFileSync(input, '-- disposable fixture');
  const clients = path.join(context.cwd, 'clients');
  fs.mkdirSync(clients);
  fs.writeFileSync(path.join(clients, process.platform === 'win32' ? 'mysql.exe' : 'mysql'), '');
  const originalPath = process.env.PATH;
  process.env.PATH = clients;
  t.after(() => { process.env.PATH = originalPath; });
  let prompt;
  await runCommand({ ...context, command: 'restore', args: [input],
    config: { ...context.config, engine: 'mysql', databaseName: 'display_name', mysql: { database: 'actual_target' } },
    confirm: async (message) => { prompt = message; return false; },
  });
  assert.match(prompt, /actual_target/);
  assert.doesNotMatch(prompt, /display_name/);
});
