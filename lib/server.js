import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig } from '../config/database.js';
import { createEngine } from './engines/index.js';
import { runCommand } from './commands.js';
import { scanDatabaseTools } from './toolchain.js';
import { listSqlFiles } from './utils.js';
import { addLogSink, removeLogSink } from './logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, '..', 'ui');

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

// Commands that must never run from the browser: `ui`/`serve` would spawn a
// nested server, `help` is noise. Everything else is allowed (destructive ones
// are confirmed in the UI before the request is sent).
const BLOCKED_COMMANDS = new Set(['ui', 'serve']);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function buildStatus(cwd) {
  const config = loadDatabaseConfig(process.env, cwd);
  const engine = createEngine(config);
  const status = {
    engine: config.engine,
    databaseName: config.databaseName,
    connection: { ok: false },
    tables: [],
    migrations: { applied: [], pending: [] },
    tools: scanDatabaseTools().map((tool) => ({
      key: tool.key,
      label: tool.label,
      installed: tool.installed,
    })),
  };

  try {
    status.connection = await engine.health();
  } catch (error) {
    status.connection = { ok: false, error: error?.message || String(error) };
  }

  try {
    status.tables = await engine.listTables();
  } catch (error) {
    status.tables = [];
    status.tablesError = error?.message || String(error);
  }

  try {
    const applied = (await engine.listAppliedMigrations?.()) ?? [];
    const files = listSqlFiles(config.defaults.migrationsDir);
    status.migrations = {
      applied,
      pending: files.filter((file) => !applied.includes(file)),
    };
  } catch (error) {
    status.migrations = { applied: [], pending: [], error: error?.message || String(error) };
  }

  engine.close?.();
  return status;
}

// JSON.stringify can't serialize every value a driver returns (BigInt throws,
// Buffers become byte arrays, Dates are fine but verbose). Normalize to plain
// display-friendly primitives.
function sanitizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `<blob ${value.length} bytes>`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

async function buildRows(cwd, table, limit) {
  if (!table || typeof table !== 'string') {
    throw new Error('A table name is required.');
  }
  const config = loadDatabaseConfig(process.env, cwd);
  const engine = createEngine(config);
  try {
    const { columns, rows } = await engine.previewRows(table, limit);
    const safeRows = rows.map((row) => {
      const out = {};
      for (const column of columns) {
        out[column] = sanitizeValue(row[column]);
      }
      return out;
    });
    return { ok: true, engine: config.engine, table, columns, rows: safeRows };
  } finally {
    engine.close?.();
  }
}

async function runUiCommand(cwd, { command, args = [], options = {} }) {
  if (!command || typeof command !== 'string') {
    throw new Error('A command is required.');
  }
  if (BLOCKED_COMMANDS.has(command)) {
    throw new Error(`The "${command}" command cannot be run from the web UI.`);
  }

  const effectiveEnv = { ...process.env };
  if (typeof options.url === 'string' && options.url.trim()) {
    effectiveEnv.LOCAL_DATABASE_URL = options.url.trim();
  }

  const config = loadDatabaseConfig(effectiveEnv, cwd, options.engine);
  const engine = createEngine(config);

  const logs = [];
  const sink = (entry) => logs.push(entry);
  addLogSink(sink);

  const context = {
    cwd,
    command,
    args: Array.isArray(args) ? args : [],
    options: { ...options, nonInteractive: true },
    config,
    engine,
    // The UI already confirmed destructive actions before sending the request.
    confirm: async () => true,
  };

  try {
    await runCommand(context);
    return { ok: true, logs };
  } catch (error) {
    return { ok: false, logs, error: error?.message || String(error) };
  } finally {
    removeLogSink(sink);
    engine.close?.();
  }
}

// Serialize command execution so the shared logger sink never interleaves
// output between two concurrent requests.
function createRunQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}

function serveStatic(res, route) {
  const filePath = path.join(uiDir, route.file);
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': route.type });
    res.end(data);
  });
}

export function startUiServer({ cwd, port }) {
  const token = crypto.randomUUID();
  const runQueue = createRunQueue();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method === 'GET' && STATIC_FILES[pathname]) {
      serveStatic(res, STATIC_FILES[pathname]);
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (req.headers['x-ui-token'] !== token) {
        sendJson(res, 403, { error: 'Invalid or missing UI token.' });
        return;
      }

      try {
        if (req.method === 'GET' && pathname === '/api/status') {
          sendJson(res, 200, await buildStatus(cwd));
          return;
        }
        if (req.method === 'GET' && pathname === '/api/rows') {
          const table = url.searchParams.get('table');
          const limit = url.searchParams.get('limit');
          const rows = await runQueue(() => buildRows(cwd, table, limit));
          sendJson(res, 200, rows);
          return;
        }
        if (req.method === 'POST' && pathname === '/api/run') {
          const body = await readJsonBody(req);
          const result = await runQueue(() => runUiCommand(cwd, body));
          sendJson(res, 200, result);
          return;
        }
      } catch (error) {
        sendJson(res, 400, { error: error?.message || String(error) });
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const urlWithToken = `http://127.0.0.1:${port}/?token=${token}`;
      console.log(`Database Toolkit UI running at ${urlWithToken}`);
      console.log('This is a localhost-only dev tool. Do not expose this port.');
      console.log('Press Ctrl+C to stop.');
      resolve(server);
    });
  });
}
