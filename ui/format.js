// DOM-free helpers shared by the UI modules and covered by node:test.
export function cellText(value) {
  if (value === null || value === undefined) return 'NULL';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : cellText(value);
  // Spreadsheet programs treat these prefixes as formulas, even in quoted CSV.
  if (typeof value === 'string' && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function toCsv(columns, rows) {
  return [columns.map((column) => csvCell(column)).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\r\n');
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export function baseName(path) { return String(path ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? ''; }

export function shortPath(path, max = 36) {
  if (!path || path.length <= max) return path || '';
  const tail = String(path).split(/[\\/]/).filter(Boolean).slice(-2).join('\\');
  return tail.length > max ? '…' + tail.slice(-(max - 1)) : '…\\' + tail;
}

export function engineMeta(engine) {
  return { sqlite: { code: 'SQ', name: 'SQLite' }, postgres: { code: 'PG', name: 'PostgreSQL' },
    mysql: { code: 'MY', name: 'MySQL' }, mssql: { code: 'MS', name: 'SQL Server' } }[engine] ?? { code: '??', name: String(engine) };
}

const MSSQL_YEARS = { 17: '2025', 16: '2022', 15: '2019', 14: '2017', 13: '2016', 12: '2014', 11: '2012' };
export function serverLabel(info) {
  if (!info) return '';
  const version = String(info.version ?? '');
  const [major, minor = '0'] = version.split('.');
  if (info.product === 'PostgreSQL') return `PostgreSQL ${major}`;
  if (info.product === 'SQL Server') return `SQL Server ${MSSQL_YEARS[major] ?? version}`;
  return `${info.product} ${major}.${minor}`;
}

function withGaps(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const items = [];
  for (const [index, number] of sorted.entries()) {
    if (index && number - sorted[index - 1] > 1) items.push('…');
    items.push(number);
  }
  return items;
}

// total === null means the COUNT timed out; a short final page still pins the exact total.
export function pageModel({ offset, limit, rowCount, total = null, hasMore = false }) {
  const page = Math.floor(offset / limit) + 1;
  const exactTotal = Number.isFinite(total) ? total : (!hasMore ? offset + rowCount : null);
  const from = rowCount ? offset + 1 : 0;
  const to = offset + rowCount;
  const pageCount = exactTotal === null ? null : Math.max(1, Math.ceil(exactTotal / limit));
  let label;
  if (!rowCount) label = exactTotal === 0 ? 'No rows' : 'No rows on this page';
  else if (exactTotal !== null) label = `Showing ${from}–${to} of ${exactTotal} rows`;
  else label = `Showing ${from}–${to} of ${to}+ rows`;
  let items;
  if (pageCount === null) items = withGaps([1, page - 1, page, hasMore ? page + 1 : page].filter((n) => n >= 1));
  else if (pageCount <= 7) items = Array.from({ length: pageCount }, (_, index) => index + 1);
  else items = withGaps([1, page - 1, page, page + 1, pageCount].filter((n) => n >= 1 && n <= pageCount));
  return { page, pageCount, from, to, label, items, total: exactTotal, exact: exactTotal !== null,
    hasPrev: page > 1, hasNext: pageCount === null ? hasMore : page < pageCount };
}

const NUMERIC_TYPE = /^(?:(?:tiny|small|medium|big)?int(?:eger)?(?:\(\d+\))?|decimal|numeric|float\d*|double(?: precision)?|real|money|smallmoney|number|serial|bigserial|smallserial)(?![a-z_])/i;
const KEY_NAME = /(^|_)id$/i;
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

// Right-align numbers, but never key columns (ids read left-aligned, as in the mockup).
export function isNumericColumn(name, rows, meta) {
  if (meta?.primaryKey || meta?.foreignKey || KEY_NAME.test(name)) return false;
  if (meta?.type) return NUMERIC_TYPE.test(meta.type.trim());
  const values = rows.map((row) => row[name]).filter((value) => value !== null && value !== undefined);
  return values.length > 0 && values.every((value) => typeof value === 'number' || (typeof value === 'string' && NUMERIC_TEXT.test(value)));
}

const PILL_EXCLUDED = /((^|_)id|name|email|url|path|notes?|title|description|address|phone|code|sku|slug)$/i;
// Low-cardinality short text in the loaded page (see 00-index Decisions §2).
export function isPillColumn(name, rows, meta) {
  if (meta?.primaryKey || meta?.foreignKey || PILL_EXCLUDED.test(name) || rows.length < 6) return false;
  if (meta?.type && !/char|text|enum|string|citext/i.test(meta.type)) return false;
  const values = rows.map((row) => row[name]).filter((value) => value !== null && value !== undefined);
  if (!values.length || !values.every((value) => typeof value === 'string' && value.length <= 24 && /^[\w .\-]+$/.test(value))) return false;
  const distinct = new Set(values).size;
  return distinct <= 8 && distinct * 2 <= rows.length;
}

const TONES = {
  ok: ['paid', 'active', 'success', 'succeeded', 'completed', 'complete', 'done', 'delivered', 'approved', 'enabled', 'true', 'yes', 'ok'],
  warn: ['pending', 'processing', 'draft', 'queued', 'review', 'hold', 'waiting', 'scheduled'],
  info: ['shipped', 'open', 'new', 'sent', 'in_progress', 'in progress', 'running'],
  bad: ['cancelled', 'canceled', 'failed', 'error', 'rejected', 'inactive', 'disabled', 'refunded', 'overdue', 'blocked', 'false', 'no'],
};
export function pillTone(value) {
  const key = String(value).trim().toLowerCase();
  for (const [tone, words] of Object.entries(TONES)) if (words.includes(key)) return tone;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ['a', 'b', 'c'][hash % 3];
}
