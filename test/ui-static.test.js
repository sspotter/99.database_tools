import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startUiServer } from '../lib/server.js';

async function serve(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-static-'));
  const server = await startUiServer({ cwd: directory, port: 0, token: 't', quiet: true, connectionsDirectory: path.join(directory, 'p') });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('static files: html, css and js modules are served with the right types and no-cache', async (t) => {
  const base = await serve(t);
  const html = await fetch(base + '/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.headers.get('cache-control'), /no-cache/);
  const js = await fetch(base + '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /text\/javascript/);
  const css = await fetch(base + '/styles.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('static files: unknown names, other extensions and traversal attempts are 404', async (t) => {
  const base = await serve(t);
  for (const route of ['/nope.js', '/package.json', '/server.js', '/..%2Flib%2Fserver.js', '/%2e%2e/lib/server.js', '/ui/app.js', '/a/b.js']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 404, route);
  }
});

test('favicon requests return 204 so the console stays clean', async (t) => {
  const base = await serve(t);
  assert.equal((await fetch(base + '/favicon.ico')).status, 204);
});
