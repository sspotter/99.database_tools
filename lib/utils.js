import fs from 'node:fs';
import path from 'node:path';

export function ensureDirSync(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

export function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

export function writeTextFile(filePath, content) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

export function resolvePath(baseDir, candidate) {
  return path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
}

export function exists(filePath) {
  return fs.existsSync(filePath);
}

export function timestampTag(date = new Date()) {
  const iso = date.toISOString().replace(/[:.]/g, '-');
  return iso.slice(0, 19);
}

export function listSqlFiles(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  return fs
    .readdirSync(directoryPath)
    .filter((entry) => entry.toLowerCase().endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
}

// Single source of truth for engine-name aliasing. Accepts the common typos
// (`postgress`, `sqllite`) so every caller resolves them identically.
export function normalizeEngineName(value) {
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
    case 'sqllite':
      return 'sqlite';
    default:
      return null;
  }
}

export function quoteIdentifier(identifier, style) {
  if (style === 'mysql') {
    return `\`${String(identifier).replace(/`/g, '``')}\``;
  }
  if (style === 'mssql') {
    return `[${String(identifier).replace(/]/g, ']]')}]`;
  }
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

export function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function formatList(values) {
  if (!values.length) {
    return '(none)';
  }
  return values.map((value) => `- ${value}`).join('\n');
}
