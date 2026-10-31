// Launches the web workspace against throwaway data. Usage:
//   node scripts/ui-sandbox.mjs [--port 4399] [--engines sqlite,postgres,mysql,mssql]
// Port: --port, else $PORT, else a random free port. Press Ctrl+C to stop and delete everything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startUiServer } from '../lib/server.js';
import { createConnectionStore } from '../lib/connections.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const port = Number(option('port', process.env.PORT || 0));
const engines = new Set(option('engines', 'sqlite').split(',').map((name) => name.trim()));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db-toolkit-sandbox-'));
const cwd = path.join(root, 'cwd');
fs.mkdirSync(cwd);
const sqliteFile = path.join(root, 'demo.sqlite');

// seed-demo.mjs seeds SQLite first; unreachable server ports (1) make its later steps fail harmlessly.
const seedEnv = { ...process.env, DB_TOOLKIT_DEMO_SQLITE_FILE: sqliteFile };
if (!engines.has('postgres')) seedEnv.DB_TOOLKIT_DEMO_POSTGRES_PORT = '1';
if (!engines.has('mysql')) seedEnv.DB_TOOLKIT_DEMO_MYSQL_PORT = '1';
spawnSync(process.execPath, [fileURLToPath(new URL('./seed-demo.mjs', import.meta.url))], { env: seedEnv, stdio: 'ignore' });
if (!fs.existsSync(sqliteFile)) throw new Error('Could not seed the sandbox SQLite database.');

const connectionsDirectory = path.join(root, 'profiles');
const store = await createConnectionStore({ directory: connectionsDirectory, cwd });
const credentialMode = store.credentialPersistence === 'windows-dpapi' ? 'saved' : 'session';
const demoUrl = (scheme, user, password, hostPort, query = '') => `${scheme}://${user}:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/toolkit_demo${query}`;
const profiles = [
  ['sqlite', { name: 'Demo · SQLite', engine: 'sqlite', credentialMode: 'none', settings: { file: sqliteFile } }],
  ['postgres', { name: 'Demo · PostgreSQL', engine: 'postgres', credentialMode, url: demoUrl('postgresql', 'toolkit_demo', 'demo_password_local_only', 15432, '?sslmode=disable') }],
  ['mysql', { name: 'Demo · MySQL', engine: 'mysql', credentialMode, url: demoUrl('mysql', 'toolkit_demo', 'demo_password_local_only', 13306, '?sslmode=disable') }],
  ['mssql', { name: 'SQL Server · Sandbox', engine: 'mssql', group: 'Sandbox', credentialMode, url: demoUrl('mssql', 'sa', 'Demo_password_1!', 11433, '?sslmode=require') }],
];
for (const [engine, profile] of profiles) {
  if (engines.has(engine)) await store.save({ group: 'Demo / Test', environment: 'development', readOnly: true, ...profile });
}

const token = crypto.randomUUID();
const server = await startUiServer({ cwd, port, token, connectionsDirectory });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }));
}
console.log(`Sandbox directory: ${root} (deleted on exit)`);
