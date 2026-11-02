import fs from 'node:fs';
import path from 'node:path';
import { buildProjectManifest, writeProjectManifest } from './manifest.js';
import { normalizeEngineName, writeTextFile } from './utils.js';

function defaultSchemaFile(cwd, engine, filename) {
  const enginePath = path.join(cwd, 'schemas', engine, filename);
  if (fs.existsSync(enginePath)) {
    return path.relative(cwd, enginePath).replaceAll('\\', '/');
  }
  return path.join('schemas', filename).replaceAll('\\', '/');
}

export function buildEnvExample({ cwd, engine, options = {}, databaseName }) {
  const normalized = normalizeEngineName(engine);
  if (!normalized) {
    throw new Error('Missing or invalid engine. Use sqlite, postgres, mysql, or mssql.');
  }

  const dbName = options.database || databaseName || 'app_database';
  const host = options.host || '127.0.0.1';
  const values = [
    `DB_ENGINE=${normalized}`,
    `DB_NAME=${dbName}`,
    '',
  ];

  if (normalized === 'sqlite') {
    values.push(
      `DB_FILE=${options.file || 'data/toolkit.db'}`,
      '# DATABASE_URL=sqlite:data/toolkit.db'
    );
  }

  if (normalized === 'postgres') {
    const user = options.user || 'postgres';
    const password = options.password || 'change_me';
    const port = options.port || '5432';
    values.push(
      `LOCAL_DATABASE_URL=postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`,
      `PGHOST=${host}`,
      `PGPORT=${port}`,
      `PGUSER=${user}`,
      `PGPASSWORD=${password}`,
      `PGDATABASE=${dbName}`,
      'PGADMIN_DB=postgres'
    );
  }

  if (normalized === 'mysql') {
    const user = options.user || 'root';
    const password = options.password || 'change_me';
    const port = options.port || '3306';
    values.push(
      `DATABASE_URL=mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`,
      `MYSQL_HOST=${host}`,
      `MYSQL_PORT=${port}`,
      `MYSQL_USER=${user}`,
      `MYSQL_PASSWORD=${password}`,
      `MYSQL_DATABASE=${dbName}`
    );
  }

  if (normalized === 'mssql') {
    const user = options.user || 'sa';
    const password = options.password || 'change_me';
    const port = options.port || '1433';
    values.push(
      `DATABASE_URL=mssql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`,
      `MSSQL_HOST=${host}`,
      `MSSQL_PORT=${port}`,
      `MSSQL_USER=${user}`,
      `MSSQL_PASSWORD=${password}`,
      `MSSQL_DATABASE=${dbName}`,
      'MSSQL_ADMIN_DATABASE=master',
      'MSSQL_TRUST_CERT=true'
    );
  }

  values.push(
    '',
    `DB_SCHEMA_FILE=${defaultSchemaFile(cwd, normalized, 'schema.sql')}`,
    `DB_UPDATE_FILE=${defaultSchemaFile(cwd, normalized, 'update_schema.sql')}`,
    'DB_MIGRATIONS_DIR=migrations',
    'DB_SEED_FILE=schemas/seed.sql',
    'DB_BACKUP_DIR=backups',
    'DB_TOOLKIT_ASSUME_YES=false',
    ''
  );

  return values.join('\n');
}

export function writeEnvExample({ cwd, engine, options = {}, databaseName }) {
  const normalized = normalizeEngineName(engine);
  const content = buildEnvExample({ cwd, engine: normalized, options, databaseName });
  const filePath = path.join(cwd, '.env.example');
  writeTextFile(filePath, content);

  const manifest = buildProjectManifest({
    cwd,
    engine: normalized,
    databaseName: options.database || databaseName,
    config: null,
  });
  writeProjectManifest(cwd, manifest);

  return { filePath, engine: normalized };
}

export function ubuntuServerHints(engine) {
  const normalized = normalizeEngineName(engine);
  if (normalized === 'postgres') {
    return [
      'sudo apt-get update && sudo apt-get install -y postgresql postgresql-client',
      'sudo systemctl enable --now postgresql',
      'sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD \'change_me\';"',
    ];
  }
  if (normalized === 'mysql') {
    return [
      'sudo apt-get update && sudo apt-get install -y mysql-server',
      'sudo systemctl enable --now mysql',
      'sudo mysql -e "ALTER USER \'root\'@\'localhost\' IDENTIFIED WITH mysql_native_password BY \'change_me\'; FLUSH PRIVILEGES;"',
    ];
  }
  if (normalized === 'sqlite') {
    return ['sudo apt-get update && sudo apt-get install -y sqlite3'];
  }
  if (normalized === 'mssql') {
    return ['Install and start SQL Server, then use sqlcmd-compatible connection settings in .env.'];
  }
  return [];
}
