import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startUiServer } from '../lib/server.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-http-'));
  for (const [name, value] of [['first', 'alpha'], ['second', 'beta']]) {
    const db = new DatabaseSync(path.join(directory, `${name}.db`));
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT);');
    db.prepare('INSERT INTO items (value) VALUES (?)').run(value);
    db.close();
  }
  const token = 'disposable-test-token';
  const server = await startUiServer({
    cwd: directory, port: 0, token, quiet: true,
    connectionsDirectory: path.join(directory, 'profiles'),
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, route, body, extra = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { 'x-ui-token': token, ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function add(name = 'first') {
    const response = await request('POST', '/api/connections', {
      name, engine: 'sqlite', settings: { file: path.join(directory, `${name}.db`) },
      credentialMode: 'none', readOnly: true,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.profile;
  }
  const connect = (profile) => request('POST', `/api/connections/${profile.id}/connect`, { revision: profile.revision });
  const workspace = (profile, task, requestId = crypto.randomUUID()) => request('POST', '/api/workspace', {
    profileId: profile.id, revision: profile.revision, task, requestId,
  });
  return { directory, request, add, connect, workspace };
}

test('local API requires its token, rejects foreign origins, and forbids caching profiles', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/api/connections', undefined, { 'x-ui-token': '' })).status, 403);
  assert.equal((await f.request('GET', '/api/connections', undefined, { origin: 'https://foreign.example' })).status, 403);
  const response = await f.request('GET', '/api/connections');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.profiles, []);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.body.capabilities.sqlite.browse, true);
});

test('profiles remain disconnected until explicitly connected and independent targets return their own rows', async (t) => {
  const f = await fixture(t);
  const first = await f.add('first');
  const second = await f.add('second');
  assert.equal((await f.workspace(first, { action: 'rows', table: 'items' })).status, 409);
  assert.equal((await f.connect(first)).status, 200);
  assert.equal((await f.connect(second)).status, 200);
  const [a, b] = await Promise.all([
    f.workspace(first, { action: 'rows', table: 'items', limit: 25 }),
    f.workspace(second, { action: 'rows', table: 'items', limit: 25 }),
  ]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(a.body.rows[0].value, 'alpha');
  assert.equal(b.body.rows[0].value, 'beta');
  assert.equal((await f.request('GET', '/api/connections')).body.profiles.filter((p) => p.connected).length, 2);
});

test('editing a profile rejects stale requests and disconnects its previous revision', async (t) => {
  const f = await fixture(t);
  const profile = await f.add();
  await f.connect(profile);
  const edit = await f.request('POST', '/api/connections', { ...profile, name: 'Renamed' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.profile.revision, profile.revision + 1);
  assert.equal((await f.workspace(profile, { action: 'tables' })).status, 409);
  assert.equal((await f.connect(profile)).status, 409);
  assert.equal((await f.request('POST', '/api/connections', { ...profile, name: 'Stale edit' })).status, 409);
  assert.equal((await f.request('DELETE', `/api/connections/${profile.id}`, { revision: profile.revision })).status, 409);
  assert.equal((await f.workspace(edit.body.profile, { action: 'tables' })).status, 409);
});

test('disconnect and deletion disable profile operations without affecting another profile', async (t) => {
  const f = await fixture(t);
  const first = await f.add('first');
  const second = await f.add('second');
  await f.connect(first);
  await f.connect(second);
  assert.equal((await f.request('POST', `/api/connections/${first.id}/disconnect`, { revision: first.revision })).status, 200);
  assert.equal((await f.workspace(first, { action: 'tables' })).status, 409);
  assert.equal((await f.workspace(second, { action: 'tables' })).status, 200);
  assert.equal((await f.request('DELETE', `/api/connections/${first.id}`, { revision: first.revision })).status, 200);
  assert.equal((await f.connect(first)).status, 404);
});

test('testing an unsaved missing SQLite path creates neither file nor profile', async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.directory, 'must-not-exist.db');
  const response = await f.request('POST', '/api/connections/test', {
    profile: { engine: 'sqlite', name: 'Missing', settings: { file: missing } },
  });
  assert.equal(response.status, 400);
  await assert.rejects(fs.access(missing));
  assert.deepEqual((await f.request('GET', '/api/connections')).body.profiles, []);
});

test('testing replacement settings does not require the old disconnected credentials', async (t) => {
  const f = await fixture(t);
  const saved = await f.request('POST', '/api/connections', {
    name: 'Expired credential', engine: 'postgres', credentialMode: 'session',
    settings: { host: 'localhost', user: 'fixture', password: 'old-disposable-secret' },
  });
  const profile = saved.body.profile;
  await f.request('POST', `/api/connections/${profile.id}/disconnect`, { revision: profile.revision });
  const result = await f.request('POST', '/api/connections/test', { profile: {
    id: profile.id, revision: profile.revision, name: 'Replacement', engine: 'sqlite',
    settings: { file: path.join(f.directory, 'first.db') },
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await f.request('GET', '/api/connections')).body.profiles[0].engine, 'postgres');
});

test('profile responses omit credentials and saved profiles cannot execute legacy management commands', async (t) => {
  const f = await fixture(t);
  const secret = 'not-a-real-password-7831';
  const response = await f.request('POST', '/api/connections', {
    name: 'Offline profile', url: `postgresql://tester:${secret}@127.0.0.1:5432/disposable`,
    credentialMode: 'session',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(JSON.stringify(response.body).includes(secret), false);
  assert.equal(JSON.stringify((await f.request('GET', '/api/connections')).body).includes(secret), false);
  assert.equal((await f.request('POST', '/api/run', { command: 'reset', profileId: response.body.profile.id })).status, 400);
});

test('workspace accepts only bounded identifiable requests and cancels the actual query worker', async (t) => {
  const f = await fixture(t);
  const profile = await f.add();
  await f.connect(profile);
  assert.equal((await f.workspace(profile, { action: 'tables' }, '')).status, 400);
  assert.equal((await f.workspace(profile, { action: 'restore' })).status, 400);
  const requestId = 'cancel-disposable-query';
  const pending = f.workspace(profile, {
    action: 'query', sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT SUM(x) FROM n',
  }, requestId);
  // Keep retrying until cancellation sees the registered request, rather than guessing startup time.
  let cancelled;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    cancelled = await f.request('POST', '/api/workspace/cancel', { requestId });
    if (cancelled.body.cancelled) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(cancelled.body.cancelled, true);
  const result = await pending;
  assert.equal(result.status, 400);
  assert.match(result.body.error, /cancel|abort/i);
  assert.equal((await f.workspace(profile, { action: 'tables' })).status, 200);
});
