import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProjectManifest } from '../lib/manifest.js';

function resolvePath(cwd, value) {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function resolveEngineFile(cwd, engine, filename, fallbackRelativePath) {
  const engineSpecificPath = resolvePath(cwd, path.join('schemas', engine, fallbackRelativePath));
  const genericRelativePath = path.join('schemas', fallbackRelativePath).replaceAll('\\', '/');
  const filenameRelativePath = filename
    ? path.relative(cwd, resolvePath(cwd, filename)).replaceAll('\\', '/')
    : '';

  if (fs.existsSync(engineSpecificPath) && (!filename || filenameRelativePath === genericRelativePath)) {
    return engineSpecificPath;
  }

  if (filename) {
    return resolvePath(cwd, filename);
  }

  return resolvePath(cwd, path.join('schemas', fallbackRelativePath));
}

function toPort(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeEngineName(value) {
  switch (String(value || '').trim().toLowerCase()) {
    case 'postgress':
    case 'postgresql':
    case 'postgres':
      return 'postgres';
    case 'mysql':
      return 'mysql';
    case 'sqlserver':
    case 'mssql':
      return 'mssql';
    case 'sqlite':
      return 'sqlite';
    default:
      return null;
  }
}

function decodeUrlPart(value) {
  if (!value) {
    return '';
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeEngineFromProtocol(protocol) {
  switch (String(protocol || '').toLowerCase()) {
    case 'postgres:':
    case 'postgresql:':
      return 'postgres';
    case 'mysql:':
      return 'mysql';
    case 'sqlite:':
    case 'file:':
      return 'sqlite';
    case 'sqlserver:':
    case 'mssql:':
      return 'mssql';
    default:
      return null;
  }
}

function parseDatabaseUrl(rawUrl, cwd) {
  if (!rawUrl) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const engine = normalizeEngineFromProtocol(parsed.protocol);
  if (!engine) {
    return null;
  }

  if (engine === 'sqlite') {
    let filePath;
    if (parsed.protocol === 'file:') {
      filePath = fileURLToPath(parsed);
    } else {
      const pathname = decodeUrlPart(parsed.pathname || '');
      if (!pathname || pathname === '/') {
        filePath = 'data/toolkit.db';
      } else {
        const normalizedPath = pathname.startsWith('/') && /^[A-Za-z]:/.test(pathname.slice(1))
          ? pathname.slice(1)
          : pathname.replace(/^\/+/, '');
        filePath = normalizedPath;
      }
    }

    return {
      engine,
      sqlite: {
        file: resolvePath(cwd, filePath),
      },
      databaseName: path.parse(filePath).name || 'app_database',
    };
  }

  const databaseName = decodeUrlPart(parsed.pathname.replace(/^\/+/, '')) || 'app_database';
  const portFallback = engine === 'postgres' ? 5432 : engine === 'mysql' ? 3306 : 1433;

  return {
    engine,
    rawUrl,
    databaseName,
    [engine]: {
      host: parsed.hostname || 'localhost',
      port: toPort(parsed.port, portFallback),
      user: decodeUrlPart(parsed.username),
      password: decodeUrlPart(parsed.password),
      database: databaseName,
    },
  };
}

export function loadDatabaseConfig(env, cwd, overrideEngine) {
  const manifest = loadProjectManifest(cwd);
  const urlSource =
    (manifest?.connectionEnvName && env[manifest.connectionEnvName]) ||
    env.LOCAL_DATABASE_URL ||
    env.DATABASE_URL ||
    '';
  const urlConfig = parseDatabaseUrl(urlSource, cwd);
  const engine =
    normalizeEngineName(overrideEngine) ||
    normalizeEngineName(env.DB_ENGINE) ||
    normalizeEngineName(manifest?.activeEngine) ||
    urlConfig?.engine ||
    'sqlite';
  const databaseName = env.DB_NAME || env.DB_DATABASE || manifest?.databaseName || 'app_database';
  const mergedDatabaseName = urlConfig?.databaseName || databaseName;

  const config = {
    cwd,
    engine,
    databaseName: mergedDatabaseName,
    defaults: {
      schemaFile: resolveEngineFile(
        cwd,
        engine,
        env.DB_SCHEMA_FILE || manifest?.schemaFile,
        'schema.sql'
      ),
      updateFile: resolveEngineFile(
        cwd,
        engine,
        env.DB_UPDATE_FILE || manifest?.updateFile,
        'update_schema.sql'
      ),
      migrationsDir: resolvePath(cwd, env.DB_MIGRATIONS_DIR || manifest?.migrationsDir || 'migrations'),
      seedFile: resolvePath(cwd, env.DB_SEED_FILE || manifest?.seedFile || 'schemas/seed.sql'),
      backupDir: resolvePath(cwd, env.DB_BACKUP_DIR || manifest?.backupDir || 'backups'),
    },
    sqlite: {
      file: resolvePath(cwd, env.DB_FILE || env.SQLITE_FILE || 'data/toolkit.db'),
    },
    postgres: {
      host: env.PGHOST || env.DB_HOST || 'localhost',
      port: toPort(env.PGPORT, 5432),
      user: env.PGUSER || env.DB_USER || '',
      password: env.PGPASSWORD || env.DB_PASSWORD || '',
      database: env.PGDATABASE || databaseName,
      adminDatabase: env.PGADMIN_DB || 'postgres',
      connectionString: env.LOCAL_DATABASE_URL || env.DATABASE_URL || '',
    },
    mysql: {
      host: env.MYSQL_HOST || env.DB_HOST || 'localhost',
      port: toPort(env.MYSQL_PORT, 3306),
      user: env.MYSQL_USER || env.DB_USER || '',
      password: env.MYSQL_PASSWORD || env.DB_PASSWORD || '',
      database: env.MYSQL_DATABASE || databaseName,
    },
    mssql: {
      host: env.MSSQL_HOST || env.DB_HOST || 'localhost',
      port: toPort(env.MSSQL_PORT, 1433),
      user: env.MSSQL_USER || env.DB_USER || '',
      password: env.MSSQL_PASSWORD || env.DB_PASSWORD || '',
      database: env.MSSQL_DATABASE || databaseName,
      adminDatabase: env.MSSQL_ADMIN_DATABASE || 'master',
      trustServerCertificate: env.MSSQL_TRUST_CERT !== 'false',
    },
    safety: {
      assumeYes: env.DB_TOOLKIT_ASSUME_YES === 'true' || env.DB_ASSUME_YES === 'true',
    },
  };

  if (urlConfig) {
    if (urlConfig.sqlite) {
      config.sqlite = {
        ...config.sqlite,
        ...urlConfig.sqlite,
      };
    }
    if (urlConfig.postgres) {
      config.postgres = {
        ...config.postgres,
        ...urlConfig.postgres,
        connectionString: urlConfig.rawUrl,
      };
    }
    if (urlConfig.mysql) {
      config.mysql = {
        ...config.mysql,
        ...urlConfig.mysql,
      };
    }
    if (urlConfig.mssql) {
      config.mssql = {
        ...config.mssql,
        ...urlConfig.mssql,
      };
    }
  }

  return config;
}
