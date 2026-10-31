import crypto from 'node:crypto';
import { createConnectionStore, normalizeConnectionInput } from './connections.js';
import { runDatabaseTask, getCapabilities, TASK_ACTIONS } from './workspace-db.js';
import { loadDatabaseConfig } from '../config/database.js';

const ACTIONS = new Set(TASK_ACTIONS);
const MAX_RUNNING = 16;

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
}

export async function createWorkspaceApi({ cwd, connectionsDirectory }) {
  const store = await createConnectionStore({ cwd, directory: connectionsDirectory });
  const connected = new Map();
  const connecting = new Map();
  const running = new Map();
  const serverInfos = new Map();

  async function current(id, revision) {
    const profile = await store.get(id);
    if (!profile) fail('Connection profile not found.', 404);
    if (!Number.isSafeInteger(revision) || revision !== profile.revision) {
      fail('This connection changed. Reopen the tab or reconnect using the current profile.', 409);
    }
    return profile;
  }

  function invalidate(id) {
    connected.delete(id);
    connecting.delete(id);
    serverInfos.delete(id);
    for (const entry of running.values()) if (entry.profileId === id) entry.controller.abort();
  }

  async function run(profile, task, requestId, { timeoutMs = 30000 } = {}) {
    if (running.has(requestId)) fail('A request with this ID is already running.', 409);
    if (running.size >= MAX_RUNNING) fail('Too many database requests. Cancel a query and try again.', 429);
    const controller = new AbortController();
    running.set(requestId, { profileId: profile.id, controller });
    try {
      const result = await runDatabaseTask(profile, task, { signal: controller.signal, timeoutMs });
      if (controller.signal.aborted) fail('Database request cancelled.');
      if (profile.id) await current(profile.id, profile.revision);
      return result;
    } finally {
      running.delete(requestId);
    }
  }

  async function importCurrent() {
    const config = loadDatabaseConfig(process.env, cwd);
    const input = {
      name: 'Current configuration', engine: config.engine,
      environment: 'development', readOnly: true, credentialMode: 'session',
    };
    if (config.engine === 'sqlite') {
      input.settings = { file: config.sqlite.file };
      input.credentialMode = 'none';
    } else if (config.engine === 'postgres' && config.postgres.connectionString) {
      input.url = config.postgres.connectionString;
    } else {
      const settings = config[config.engine];
      input.settings = {
        host: settings.host, port: settings.port, user: settings.user,
        password: settings.password, database: settings.database,
      };
    }
    return { profile: await store.save(input) };
  }

  async function handle(method, pathname, body = {}) {
    if (pathname === '/api/connections' && method === 'GET') {
      const profiles = await store.list();
      return {
        profiles: profiles.map((profile) => {
          const isConnected = connected.get(profile.id) === profile.revision;
          return { ...profile, connected: isConnected, serverInfo: isConnected ? serverInfos.get(profile.id) ?? null : null };
        }),
        capabilities: Object.fromEntries(['sqlite', 'postgres', 'mysql', 'mssql'].map((engine) => [engine, getCapabilities(engine)])),
        credentialPersistence: store.credentialPersistence,
      };
    }
    if (pathname === '/api/connections' && method === 'POST') {
      requireObject(body, 'Profile');
      if (body.id) await current(body.id, body.revision);
      const profile = await store.save(body);
      invalidate(profile.id);
      return { profile: { ...profile, connected: false } };
    }
    if (pathname === '/api/connections/test' && method === 'POST') {
      requireObject(body.profile, 'Profile');
      let input = body.profile;
      // Edits can test unchanged saved credentials without returning them to the browser.
      if (input.id) {
        await current(input.id, input.revision);
        const oldProfile = await store.get(input.id);
        const needsPreviousPassword = (input.engine || oldProfile.engine) !== 'sqlite'
          && (input.credentialMode || oldProfile.credentialMode) !== 'none'
          && !input.url && !Object.hasOwn(input.settings || {}, 'password');
        const previous = needsPreviousPassword
          ? await store.get(input.id, { includeSecrets: true }) : oldProfile;
        input = { ...previous, ...input, settings: { ...previous.settings, ...input.settings } };
      }
      const profile = await normalizeConnectionInput(input, { cwd });
      // Unsaved tests have no registry identity, even when based on an existing profile.
      return run({ ...profile, id: undefined }, { action: 'test' }, crypto.randomUUID());
    }
    if (pathname === '/api/connections/import-current' && method === 'POST') return importCurrent();

    const match = /^\/api\/connections\/([A-Za-z0-9_-]{1,100})(?:\/(connect|disconnect))?$/.exec(pathname);
    if (match) {
      const [, id, action] = match;
      if (method === 'DELETE' && !action) {
        await current(id, body.revision);
        await store.remove(id, body.revision);
        invalidate(id);
        return { ok: true };
      }
      if (method === 'POST' && action === 'disconnect') {
        await current(id, body.revision);
        invalidate(id);
        await store.clearSessionSecrets(id, body.revision);
        return { ok: true };
      }
      if (method === 'POST' && action === 'connect') {
        await current(id, body.revision);
        invalidate(id);
        const attempt = crypto.randomUUID();
        connecting.set(id, attempt);
        try {
          const profile = await store.get(id, { includeSecrets: true });
          if (profile.revision !== body.revision) fail('Connection changed during login. Reconnect using its current revision.', 409);
          if (connecting.get(id) !== attempt) fail('Connection attempt cancelled.');
          await run(profile, { action: 'test' }, `connect-${attempt}`);
          if (connecting.get(id) !== attempt) fail('Connection attempt cancelled.');
          let databases;
          let discoveryError;
          try {
            ({ databases } = await run(profile, { action: 'databases' }, `discover-${attempt}`));
          } catch {
            // A valid login need not have permission to discover every database.
            databases = [profile.settings.database || 'main'];
            discoveryError = 'Connected. Database discovery is unavailable; showing the configured database.';
          }
          if (connecting.get(id) !== attempt) fail('Connection attempt cancelled.');
          let serverInfo = null;
          try { serverInfo = await run(profile, { action: 'serverInfo' }, `info-${attempt}`); }
          catch { /* The version label is optional; a login that can connect must still connect. */ }
          if (connecting.get(id) !== attempt) fail('Connection attempt cancelled.');
          const publicProfile = await current(id, profile.revision);
          if (connecting.get(id) !== attempt) fail('Connection attempt cancelled.');
          connected.set(id, profile.revision);
          serverInfos.set(id, serverInfo);
          return { profile: { ...publicProfile, connected: true }, databases, serverInfo, ...(discoveryError ? { discoveryError } : {}) };
        } finally {
          if (connecting.get(id) === attempt) connecting.delete(id);
        }
      }
    }
    if (pathname === '/api/workspace/cancel' && method === 'POST') {
      const entry = running.get(body.requestId);
      entry?.controller.abort();
      return { cancelled: Boolean(entry) };
    }
    if (pathname === '/api/workspace' && method === 'POST') {
      requireObject(body.task, 'Database task');
      if (!ACTIONS.has(body.task.action)) fail('Unsupported database task.');
      if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId)) {
        fail('A valid unique request ID is required.');
      }
      await current(body.profileId, body.revision);
      if (connected.get(body.profileId) !== body.revision) fail('Connect this profile before opening database objects.', 409);
      const profile = await store.get(body.profileId, { includeSecrets: true });
      if (profile.revision !== body.revision || connected.get(profile.id) !== body.revision) {
        fail('Connection changed. Reopen this tab and reconnect.', 409);
      }
      if (body.task.action === 'count') {
        const { countTimeoutMs, ...task } = body.task;
        const timeoutMs = Math.min(60000, Math.max(1000, Number.isInteger(countTimeoutMs) ? countTimeoutMs : 5000));
        try { return await run(profile, task, body.requestId, { timeoutMs }); }
        catch (error) {
          // A slow COUNT must never block or fail the grid; the UI shows "100+ rows" instead.
          if (error.code === 'QUERY_TIMEOUT') return { total: null, exact: false };
          throw error;
        }
      }
      return run(profile, body.task, body.requestId);
    }
    return undefined;
  }

  return {
    handle,
    dispose() {
      for (const entry of running.values()) entry.controller.abort();
      connected.clear();
      connecting.clear();
    },
  };
}
