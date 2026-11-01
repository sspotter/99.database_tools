import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// scripts/ui-sandbox.mjs must never let its workspace server see a real DATABASE_URL (or other
// PG*/MYSQL*/MSSQL* credentials) that happen to be set in the ambient shell: it is a throwaway
// sandbox over seeded demo data only. lib/server.js reads process.env directly for /api/status,
// so the sandbox script scrubs those vars from its own process.env before starting the server.
test('ui-sandbox scrubs ambient database credentials before serving /api/status', async (t) => {
  const scriptPath = fileURLToPath(new URL('../scripts/ui-sandbox.mjs', import.meta.url));
  const child = spawn(process.execPath, [scriptPath, '--engines', 'sqlite', '--port', '0'], {
    env: { ...process.env, DATABASE_URL: 'postgresql://evil:pw@attacker.example:5432/evil' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => child.kill());

  const ready = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('sandbox did not report a URL in time')), 20000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/running at (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`sandbox exited early (code ${code})`)); });
  });

  const url = new URL(ready);
  const token = url.searchParams.get('token');
  const response = await fetch(`${url.origin}/api/status`, { headers: { 'x-ui-token': token } });
  const body = await response.json();
  // A poisoned DATABASE_URL would report engine 'postgres' and the attacker host; the sandbox must
  // fall back to its own default (sqlite, no manifest in its scratch cwd) regardless.
  assert.equal(body.engine, 'sqlite');
});
