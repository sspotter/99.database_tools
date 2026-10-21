import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgresEngine } from '../lib/engines/postgres.js';
import { ExternalCliEngine } from '../lib/engines/external.js';
import { runProcess } from '../lib/process-runner.js';

for (const kind of ['postgres', 'mysql']) {
  test(`${kind} backup uses native streaming without credentials in arguments`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dbtk server '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const outputPath = path.join(directory, 'backup.sql');
    const password = 'super-secret-sentinel';
    const runner = async (command, args, options) => {
      assert.equal(args.join(' ').includes(password), false);
      assert.equal(command, kind === 'postgres' ? 'pg_dump' : 'mysqldump');
      if (kind === 'postgres') {
        assert.equal(options.env.PGHOST, 'actual-host');
        assert.equal(options.env.PGPORT, '6543');
        assert.equal(options.env.PGDATABASE, 'actual-db');
        assert.equal(options.env.PGSSLMODE, 'verify-full');
        assert.equal(options.env.PGAPPNAME, 'dbtk-test');
        assert.equal(options.env.PGPASSWORD, password);
      } else {
        assert.ok(args.includes('--protocol=TCP'));
        assert.ok(args.includes('--single-transaction'));
        assert.ok(args.includes('--skip-lock-tables'));
        assert.equal(options.env.MYSQL_PWD, password);
      }
      return runProcess(process.execPath, ['-e', 'process.stdout.write("native dump")'], options);
    };
    const config = kind === 'postgres'
      ? { postgres: { connectionString: `postgres://alice:${password}@actual-host:6543/actual-db?sslmode=verify-full&application_name=dbtk-test`, host: 'wrong-host', port: 1111, database: 'wrong-db' } }
      : { engine: 'mysql', mysql: { host: 'localhost', port: 3306, user: 'alice', password, database: 'scratch' } };
    const engine = kind === 'postgres' ? new PostgresEngine(config, { processRunner: runner }) : new ExternalCliEngine(config, { processRunner: runner });
    assert.equal(await engine.backup(outputPath), outputPath);
    assert.equal(await fs.readFile(outputPath, 'utf8'), 'native dump');
  });
}

test('PostgreSQL native client ignores inherited routing and honors explicit TLS over inherited disable', async () => {
  const inherited = { PGHOSTADDR: '203.0.113.9', PGSERVICE: 'other-server', PGSERVICEFILE: '/other-service.conf', PGSSLMODE: 'disable' };
  const previous = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]));
  Object.assign(process.env, inherited);
  try {
    const engine = new PostgresEngine({ postgres: { connectionString: 'postgres://alice:sentinel@configured-host:6543/configured-db?ssl=true' } }, {
      processRunner: async (command, args, { env }) => {
        assert.equal(env.PGHOST, 'configured-host');
        assert.equal(env.PGPORT, '6543');
        assert.equal(env.PGDATABASE, 'configured-db');
        assert.equal(env.PGHOSTADDR, undefined);
        assert.equal(env.PGSERVICE, undefined);
        assert.equal(env.PGSERVICEFILE, undefined);
        assert.equal(env.PGSSLMODE, 'verify-full');
        return { exitCode: 0 };
      },
    });
    await engine.backup('unused-native-boundary.sql');
  } finally {
    for (const [name, original] of Object.entries(previous)) {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
});
