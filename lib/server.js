import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig } from '../config/database.js';
import { createEngine } from './engines/index.js';
import { runCommand } from './commands.js';
import { scanDatabaseTools } from './toolchain.js';
import { addLogSink, removeLogSink } from './logger.js';
import { createWorkspaceApi } from './workspace-api.js';
import { redactError } from './connections.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, '..', 'ui');

const STATIC_TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

// Only flat `<name>.js` / `<name>.css` files inside ui/ are public; the pattern cannot contain `/`, `\`, `%` or `.`.
function staticRoute(pathname) {
  if (pathname === '/' || pathname === '/index.html') return { file: 'index.html', type: 'text/html; charset=utf-8' };
  const match = /^\/([a-z0-9-]+)\.(js|css)$/.exec(pathname);
  return match ? { file: `${match[1]}.${match[2]}`, type: STATIC_TYPES[match[2]] } : undefined;
}

// Management commands remain in the CLI until their safety work is complete.
const SAFE_UI_COMMANDS = new Set(['scan']);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch {
        reject(new Error('Request body must be a JSON object.'));
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
    status.connection = { ok: false, error: redactError(error) };
  }

  try {
    status.tables = await engine.listTables();
  } catch (error) {
    status.tables = [];
    status.tablesError = redactError(error);
  }

  // Reading status must not create or update a migration ledger in the database.
  status.migrations = { applied: [], pending: [], unavailable: true };

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
  if (!SAFE_UI_COMMANDS.has(command)) {
    throw new Error('Database management commands are available through the CLI. This workspace currently supports browsing and SQL tabs.');
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
    res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-cache' });
    res.end(data);
  });
}

export async function startUiServer({ cwd, port, connectionsDirectory, token = crypto.randomUUID(), quiet = false }) {
  const runQueue = createRunQueue();
  const workspace = await createWorkspaceApi({ cwd, connectionsDirectory });

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    if (req.headers.host !== expectedHost && req.headers.host !== `localhost:${server.address()?.port}`) {
      sendJson(res, 403, { error: 'Only local requests are allowed.' });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    const route = req.method === 'GET' ? staticRoute(pathname) : undefined;
    if (route) {
      serveStatic(res, route);
      return;
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (req.headers['x-ui-token'] !== token || (origin && origin !== `http://${expectedHost}` && origin !== `http://localhost:${server.address()?.port}`)) {
        sendJson(res, 403, { error: 'Invalid or missing UI token.' });
        return;
      }

      try {
        const body = ['POST', 'DELETE'].includes(req.method) ? await readJsonBody(req) : {};
        const result = await workspace.handle(req.method, pathname, body);
        if (result !== undefined) {
          sendJson(res, 200, result);
          return;
        }
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
          const result = await runQueue(() => runUiCommand(cwd, body));
          sendJson(res, 200, result);
          return;
        }
      } catch (error) {
        const status = error.statusCode || ({ NOT_FOUND: 404, REVISION_CONFLICT: 409 }[error.code]) || 400;
        sendJson(res, status, { error: error.statusCode ? error.message : redactError(error) });
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  server.on('close', () => workspace.dispose());
  const originalClose = server.close.bind(server);
  server.close = (...args) => {
    workspace.dispose();
    return originalClose(...args);
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const urlWithToken = `http://127.0.0.1:${server.address().port}/?token=${token}`;
      if (!quiet) {
        console.log(`Database Toolkit UI running at ${urlWithToken}`);
        console.log('This is a localhost-only dev tool. Do not expose this port.');
        console.log('Press Ctrl+C to stop.');
      }
      resolve(server);
    });
  });
}
