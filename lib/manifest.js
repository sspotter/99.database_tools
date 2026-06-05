import fs from 'node:fs';
import path from 'node:path';
import { ensureDirSync, readTextFile, writeTextFile } from './utils.js';

export const MANIFEST_FILENAME = 'db-toolkit.manifest.json';

export function manifestPath(cwd) {
  return path.join(cwd, MANIFEST_FILENAME);
}

export function loadProjectManifest(cwd) {
  const filePath = manifestPath(cwd);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readTextFile(filePath));
  } catch (error) {
    throw new Error(`Failed to read project manifest at ${filePath}: ${error.message}`);
  }
}

function resolveEngineDefaultFile(cwd, engine, configuredPath, fallbackRelativePath) {
  const genericRelativePath = path.join('schemas', fallbackRelativePath).replaceAll('\\', '/');
  const engineSpecificPath = path.join(cwd, 'schemas', engine, fallbackRelativePath);
  const configuredRelativePath = configuredPath
    ? path.relative(cwd, configuredPath).replaceAll('\\', '/')
    : '';

  if (fs.existsSync(engineSpecificPath)) {
    if (!configuredPath || configuredRelativePath === genericRelativePath) {
      return engineSpecificPath;
    }
  }

  if (configuredPath) {
    return configuredPath;
  }

  return path.join(cwd, 'schemas', fallbackRelativePath);
}

export function buildProjectManifest({ cwd, engine, databaseName, config }) {
  const relative = (target) => path.relative(cwd, target).replaceAll('\\', '/');
  const activeEngine = String(engine || config?.engine || 'sqlite').toLowerCase();
  const connectionEnvName = activeEngine === 'postgres' ? 'LOCAL_DATABASE_URL' : 'DATABASE_URL';
  const schemaFile = relative(
    resolveEngineDefaultFile(
      cwd,
      activeEngine,
      config?.defaults?.schemaFile,
      'schema.sql'
    )
  );
  const updateFile = relative(
    resolveEngineDefaultFile(
      cwd,
      activeEngine,
      config?.defaults?.updateFile,
      'update_schema.sql'
    )
  );
  const migrationsDir = relative(config?.defaults?.migrationsDir || path.join(cwd, 'migrations'));
  const seedFile = relative(config?.defaults?.seedFile || path.join(cwd, 'schemas', 'seed.sql'));
  const backupDir = relative(config?.defaults?.backupDir || path.join(cwd, 'backups'));

  return {
    version: 1,
    activeEngine,
    connectionEnvName,
    databaseName: databaseName || config?.databaseName || 'app_database',
    schemaFile,
    updateFile,
    migrationsDir,
    seedFile,
    backupDir,
    notes: activeEngine === 'postgres'
      ? [
          'Use LOCAL_DATABASE_URL in .env',
          'PostgreSQL uses the pg driver for init and schema operations',
        ]
      : ['Use the selected engine defaults in db.js'],
  };
}

export function writeProjectManifest(cwd, manifest) {
  const filePath = manifestPath(cwd);
  ensureDirSync(path.dirname(filePath));
  writeTextFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return filePath;
}
