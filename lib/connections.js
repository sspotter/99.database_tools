import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { protectSecret, unprotectSecret } from './connection-secrets.js';

class ProfileError extends Error {
  constructor(message, code = 'INVALID_PROFILE') {
    super(message);
    this.code = code;
  }
}

function invalid(message) {
  throw new ProfileError(message);
}

const engines = ['sqlite', 'postgres', 'mysql', 'mssql'];
const sslModes = ['disable', 'require', 'verify-ca', 'verify-full'];
const profileKeys = ['id', 'revision', 'name', 'engine', 'group', 'environment',
  'favorite', 'readOnly', 'credentialMode', 'credentialStatus', 'settings', '_secret'];

function text(candidate, label, max = 255, required = false) {
  const field = candidate ?? '';
  if (typeof field !== 'string' || field.length > max || /[\x00-\x1f\x7f]/.test(field)
    || (required && !field.trim())) invalid(`Invalid ${label}.`);
  return field;
}

function booleanField(candidate, fallback, label) {
  if (candidate === undefined) return fallback;
  if (typeof candidate !== 'boolean') invalid(`Invalid ${label}.`);
  return candidate;
}

function isRecord(candidate) {
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate);
}

function connectionId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
    invalid('Invalid connection ID.');
  }
  return id;
}

function urlSettings(input) {
  text(input.url, 'connection URL', 8192, true);
  let url;
  try { url = new URL(input.url); } catch { invalid('Invalid connection URL.'); }
  const protocols = { 'postgres:': 'postgres', 'postgresql:': 'postgres', 'mysql:': 'mysql',
    'mssql:': 'mssql', 'sqlserver:': 'mssql' };
  const engine = protocols[url.protocol];
  if (!engine || (input.engine && input.engine !== engine) || url.hash) invalid('Unsupported connection URL.');
  const options = {};
  for (const [key, option] of url.searchParams) {
    if (!['sslmode', 'sslca'].includes(key) || Object.hasOwn(options, key)) invalid('Unsupported or duplicate connection URL option.');
    options[key] = option;
  }
  try {
    return { engine, settings: {
      host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)), sslMode: options.sslmode, sslCa: options.sslca
    } };
  } catch { invalid('Invalid connection URL encoding.'); }
}

function serverSettings(engine, settings, cwd) {
  const host = text(settings.host, 'host', 255, true);
  if (/[\s/@\\?#]/.test(host)) invalid('Invalid host.');
  const specifiedPort = settings.port !== undefined && settings.port !== '';
  if (specifiedPort && !(typeof settings.port === 'number'
    || (typeof settings.port === 'string' && /^[0-9]{1,5}$/.test(settings.port)))) invalid('Invalid port.');
  const port = specifiedPort ? Number(settings.port) : { postgres: 5432, mysql: 3306, mssql: 1433 }[engine];
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('Invalid port.');
  const sslMode = settings.sslMode ?? 'verify-full';
  if (!sslModes.includes(sslMode)) invalid('Invalid SSL mode.');
  const database = text(settings.database, 'database', 255);
  if (/[\\/]/.test(database)) invalid('Invalid database.');
  const sslCa = text(settings.sslCa, 'SSL CA file', 4096);
  return { host, port, user: text(settings.user, 'user', 255), database, sslMode,
    sslCa: sslCa ? path.resolve(cwd, sslCa) : '' };
}

export function normalizeConnectionInput(input, { cwd = process.cwd() } = {}) {
  if (!isRecord(input)) invalid('Invalid connection profile.');
  const source = input.url !== undefined && input.url !== '' ? urlSettings(input) : input;
  const { engine } = source;
  const settings = source.settings ?? {};
  if (!isRecord(settings)) invalid('Invalid connection settings.');
  if (!engines.includes(engine)) invalid('Unsupported database engine.');
  const credentialMode = engine === 'sqlite' ? 'none' : (input.credentialMode ?? 'session');
  if (!['saved', 'session', 'none'].includes(credentialMode)) invalid('Invalid credential mode.');
  const profile = {
    name: text(input.name, 'connection name', 200, true), engine,
    group: text(input.group, 'group', 100), environment: text(input.environment, 'environment', 100),
    favorite: booleanField(input.favorite, false, 'favorite'),
    readOnly: booleanField(input.readOnly, true, 'read-only preference'), credentialMode,
    settings: engine === 'sqlite'
      ? { file: path.resolve(cwd, text(settings.file, 'SQLite file', 4096, true)) }
      : serverSettings(engine, settings, cwd)
  };
  if (input.id !== undefined) profile.id = connectionId(input.id);
  if (input.revision !== undefined) {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) invalid('Invalid profile revision.');
    profile.revision = input.revision;
  }
  if (engine !== 'sqlite' && settings.password !== undefined) {
    const password = text(settings.password, 'password', 8192);
    if (credentialMode !== 'none') profile.settings.password = password;
  }
  profile.credentialStatus = credentialMode === 'none' ? 'none' : profile.settings.password ? 'ready' : 'required';
  return profile;
}

export function redactError(error) {
  if (error instanceof ProfileError) return error.message;
  const messages = {
    ECONNREFUSED: 'Connection refused. Check the host and port.',
    ENOTFOUND: 'Host not found. Check the host name.', ETIMEDOUT: 'Connection timed out.',
    ABORT_ERR: 'Request cancelled.', '28P01': 'Authentication failed. Re-enter credentials.',
    ER_ACCESS_DENIED_ERROR: 'Authentication failed. Re-enter credentials.',
    CERT_HAS_EXPIRED: 'TLS certificate has expired.',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate could not be verified.'
  };
  return messages[error?.code] ?? 'Database operation failed. Check connection settings, credentials, and server permissions.';
}

function persistedProfile(stored, cwd) {
  if (!isRecord(stored) || Object.keys(stored).some(key => !profileKeys.includes(key))) throw Error();
  connectionId(stored.id);
  if (!Number.isSafeInteger(stored.revision) || stored.revision < 1) throw Error();
  if (!['saved', 'session', 'none'].includes(stored.credentialMode)) throw Error();
  if (stored._secret !== undefined && !/^[a-f0-9-]{36}\.dpapi$/.test(stored._secret)) throw Error();
  if (Object.hasOwn(stored.settings ?? {}, 'password')) throw Error();
  const profile = normalizeConnectionInput(stored, { cwd });
  if (stored._secret) profile._secret = stored._secret;
  return profile;
}

async function atomicWrite(directory, filename, contents) {
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function createConnectionStore({ directory, cwd = process.cwd() } = {}) {
  directory = path.resolve(directory ?? path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'db-toolkit'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = path.join(directory, 'connections.json');
  const sessions = new Map();

  async function readProfiles() {
    try {
      const metadataStat = await stat(metadata);
      if (metadataStat.size > 2 * 1024 * 1024) throw Error();
      const document = JSON.parse(await readFile(metadata, 'utf8'));
      if (document.version !== 1 || !Array.isArray(document.profiles) || document.profiles.length > 1000) throw Error();
      const profiles = document.profiles.map(stored => persistedProfile(stored, cwd));
      if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw Error();
      return profiles;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new ProfileError('Connection metadata is unreadable.', 'STORE_UNAVAILABLE');
    }
  }

  async function mutateProfiles(operation) {
    const lock = new DatabaseSync(path.join(directory, 'connections-lock.sqlite'));
    try {
      // SQLite's OS lock is released even if this process exits during an awaited write.
      lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    } catch (error) {
      lock.close();
      if (error.errcode === 5 || error.errcode === 6) {
        throw new ProfileError('Connection store busy; retry the change.', 'REVISION_CONFLICT');
      }
      throw new ProfileError('Connection store lock is unavailable.', 'STORE_UNAVAILABLE');
    }
    try { return await operation(await readProfiles()); } finally {
      try { lock.exec('ROLLBACK'); } finally { lock.close(); }
    }
  }

  function findProfile(profiles, id) {
    connectionId(id);
    const profile = profiles.find(candidate => candidate.id === id);
    if (!profile) throw new ProfileError('Connection not found.', 'NOT_FOUND');
    return profile;
  }

  function requireRevision(profile, revision) {
    if (profile.revision !== revision) throw new ProfileError('Connection changed; reload the current revision.', 'REVISION_CONFLICT');
  }

  async function encryptedSecret(profile) {
    const encrypted = await readFile(path.join(directory, profile._secret), 'utf8');
    if (encrypted.length > 32768 || encrypted.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw Error();
    return encrypted;
  }

  async function privatePassword(profile) {
    if (profile.credentialMode === 'none') return undefined;
    if (profile.credentialMode === 'session') {
      const session = sessions.get(profile.id);
      return session?.revision === profile.revision ? session.password : undefined;
    }
    if (!profile._secret) return undefined;
    try { return await unprotectSecret(await encryptedSecret(profile)); } catch {
      throw new ProfileError('Credentials unavailable; re-enter credentials.', 'CREDENTIALS_UNAVAILABLE');
    }
  }

  async function credentialStatus(profile) {
    if (profile.credentialMode === 'none') return 'none';
    if (profile.credentialMode === 'session') return await privatePassword(profile) ? 'ready' : 'required';
    if (!profile._secret) return 'required';
    // Decryption is reserved for connecting; listing profiles never starts a process.
    try { await encryptedSecret(profile); return 'ready'; } catch { return 'unavailable'; }
  }

  async function publicProfile(profile) {
    const { id, revision, name, engine, group, environment, favorite, readOnly, credentialMode, settings } = profile;
    return { id, revision, name, engine, group, environment, favorite, readOnly, credentialMode,
      credentialStatus: await credentialStatus(profile), settings: { ...settings } };
  }

  async function prepareCredentials(profile, previous) {
    if (profile.credentialMode === 'saved' && process.platform !== 'win32') profile.credentialMode = 'session';
    const supplied = Object.hasOwn(profile.settings, 'password');
    let secret = profile.settings.password;
    delete profile.settings.password;
    if (!supplied && previous?.credentialMode === 'saved' && profile.credentialMode === 'saved') {
      profile._secret = previous._secret;
      return undefined;
    }
    if (!supplied && previous && profile.credentialMode !== 'none') secret = await privatePassword(previous);
    if (profile.credentialMode === 'saved' && secret) {
      profile._secret = `${randomUUID()}.dpapi`;
      await atomicWrite(directory, path.join(directory, profile._secret), await protectSecret(secret));
    }
    return secret;
  }

  async function writeProfiles(profiles) {
    const serialized = JSON.stringify({ version: 1, profiles }, null, 2);
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
      throw new ProfileError('Connection library exceeds the 2 MiB size limit.');
    }
    await atomicWrite(directory, metadata, serialized);
  }

  async function save(input) {
    if (!isRecord(input)) invalid('Invalid connection profile.');
    return mutateProfiles(async profiles => {
      const previous = input.id === undefined ? undefined : findProfile(profiles, input.id);
      if (previous) requireRevision(previous, input.revision);
      if (!previous && profiles.length >= 1000) invalid('Connection limit reached.');
      const merged = previous ? { ...previous, ...input, settings: { ...previous.settings, ...(input.settings ?? {}) } } : input;
      const profile = normalizeConnectionInput(merged, { cwd });
      profile.id = previous?.id ?? randomUUID();
      profile.revision = (previous?.revision ?? 0) + 1;
      const secret = await prepareCredentials(profile, previous);
      const next = previous ? profiles.map(candidate => candidate.id === profile.id ? profile : candidate) : [...profiles, profile];
      try { await writeProfiles(next); } catch (error) {
        if (profile._secret !== previous?._secret && profile._secret) await unlink(path.join(directory, profile._secret)).catch(() => {});
        if (error instanceof ProfileError) throw error;
        throw new ProfileError('Could not save connection metadata.', 'STORE_UNAVAILABLE');
      }
      sessions.delete(profile.id);
      if (profile.credentialMode === 'session' && secret) sessions.set(profile.id, { revision: profile.revision, password: secret });
      if (previous?._secret && previous._secret !== profile._secret) await unlink(path.join(directory, previous._secret)).catch(() => {});
      return publicProfile(profile);
    });
  }

  return {
    credentialPersistence: process.platform === 'win32' ? 'windows-dpapi' : 'session-only',
    async list() { return Promise.all((await readProfiles()).map(publicProfile)); },
    async get(id, { includeSecrets = false } = {}) {
      const profile = findProfile(await readProfiles(), id);
      const publicCopy = await publicProfile(profile);
      if (includeSecrets && profile.credentialMode !== 'none') {
        const secret = await privatePassword(profile);
        if (!secret) throw new ProfileError('Credentials required; re-enter credentials.', 'CREDENTIALS_REQUIRED');
        publicCopy.settings.password = secret;
      }
      return publicCopy;
    },
    save,
    async remove(id, revision) {
      return mutateProfiles(async profiles => {
        const profile = findProfile(profiles, id);
        requireRevision(profile, revision);
        await writeProfiles(profiles.filter(candidate => candidate.id !== id));
        sessions.delete(id);
        if (profile._secret) await unlink(path.join(directory, profile._secret)).catch(() => {});
      });
    },
    async clearSessionSecrets(id, revision) {
      const profile = findProfile(await readProfiles(), id);
      const expected = revision ?? profile.revision;
      if (sessions.get(id)?.revision === expected) sessions.delete(id);
    }
  };
}
