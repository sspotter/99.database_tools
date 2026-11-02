import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startUiServer } from '../lib/server.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-meta-'));
  const file = path.join(directory, 'meta.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items(value) VALUES ('a'),('b'),('a');
    CREATE VIEW slow_count AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<80000000) SELECT x FROM c;`);
  db.close();
  const token = 'meta-token';
  const server = await startUiServer({ cwd: directory, port: 0, token, quiet: true, connectionsDirectory: path.join(directory, 'profiles') });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, route, body) => {
    const response = await fetch(base + route, { method, headers: { 'x-ui-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const saved = await request('POST', '/api/connections', { name: 'meta', engine: 'sqlite', settings: { file }, credentialMode: 'none', readOnly: true });
  const profile = saved.body.profile;
  const task = (taskBody) => request('POST', '/api/workspace', { profileId: profile.id, revision: profile.revision, requestId: crypto.randomUUID(), task: taskBody });
  return { request, profile, task };
}

test('connect returns serverInfo and the profile list repeats it only while connected', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/api/connections')).body.profiles[0].serverInfo, null);
  const connected = await f.request('POST', `/api/connections/${f.profile.id}/connect`, { revision: f.profile.revision });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.serverInfo.product, 'SQLite');
  assert.equal((await f.request('GET', '/api/connections')).body.profiles[0].serverInfo.product, 'SQLite');
  await f.request('POST', `/api/connections/${f.profile.id}/disconnect`, { revision: f.profile.revision });
  assert.equal((await f.request('GET', '/api/connections')).body.profiles[0].serverInfo, null);
});

test('count returns exact totals and degrades to total:null when it exceeds its timeout', async (t) => {
  const f = await fixture(t);
  await f.request('POST', `/api/connections/${f.profile.id}/connect`, { revision: f.profile.revision });
  assert.deepEqual((await f.task({ action: 'count', table: 'items', filterColumn: 'value', filterValue: 'a' })).body, { total: 2, exact: true });
  const slow = await f.task({ action: 'count', table: 'slow_count', countTimeoutMs: 1000 });
  assert.equal(slow.status, 200);
  assert.deepEqual(slow.body, { total: null, exact: false });
});
