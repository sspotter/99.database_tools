import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyzeStatement, pageOptions, quoteName } from './workspace-sql.js';

function filterClause(task, q) {
  if (task.filterColumn === undefined) return { where: '', params: [] };
  if (task.filterValue === null) return { where: ` WHERE ${q(task.filterColumn)} IS NULL`, params: [] };
  return { where: ` WHERE ${q(task.filterColumn)} = ?`, params: [task.filterValue] };
}

function execute(profile, task) {
  const file = profile.settings?.file;
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('SQLite database file does not exist');
  if (task.database && task.database !== file && task.database !== path.basename(file)) throw new Error('Unknown SQLite database');
  const writable = task.action === 'query' && profile.readOnly === false;
  const db = new DatabaseSync(file, { readOnly: !writable });
  const q = (name) => quoteName(name, 'sqlite');
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (!writable) db.exec('PRAGMA query_only=ON;');
    if (task.action === 'test') return { ok: true };
    if (task.action === 'serverInfo') return { product: 'SQLite', version: db.prepare('SELECT sqlite_version() AS version').get().version };
    if (task.action === 'databases') return { databases: [file] };
    if (task.action === 'schemas') return { schemas: ['main'] };
    const schema = task.schema ?? 'main';
    if (schema !== 'main') throw new Error('Unknown SQLite schema');
    if (task.action === 'catalog' || task.action === 'tables') {
      // LIMIT 10001 caps the fetch at the source, so a huge sqlite_master is never fully materialized before the check.
      const objects = db.prepare("SELECT 'main' AS schema, name, type FROM main.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 10001").all();
      if (objects.length > 10000) throw new Error('Catalog exceeds 10000 objects; open a smaller database');
      if (task.action === 'catalog') return { schemas: [{ name: 'main', objects }], defaultSchema: 'main' };
      return { tables: objects };
    }
    const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM main.sqlite_master WHERE type IN ('table','view') AND name = ?").get(name));
    if (task.action === 'query') {
      const { sql, kind, topTokens } = analyzeStatement(task.sql, 'sqlite');
      if (!writable && !['SELECT', 'EXPLAIN'].includes(kind)) {
        throw new Error('This statement is not allowed in read-only mode');
      }
      const { limit } = pageOptions(task);
      if (writable) db.exec('BEGIN');
      const stmt = db.prepare(sql);
      const columns = typeof stmt.columns === 'function' ? stmt.columns().map((column) => column.name) : [];
      const rowStatement = ['SELECT', 'EXPLAIN', 'PRAGMA'].includes(kind) || topTokens.includes('RETURNING');
      if (!rowStatement && !columns.length) {
        const result = stmt.run();
        if (writable) db.exec('COMMIT');
        return { columns, rows: [], rowCount: Number(result.changes), hasMore: false };
      }
      const resultWidth = kind === 'EXPLAIN' ? 0 : Math.max(0, ...db.prepare(`EXPLAIN ${sql}`).all()
        .filter((opcode) => opcode.opcode === 'ResultRow').map((opcode) => opcode.p2));
      stmt.setReadBigInts(true);
      const rows = [];
      for (const row of stmt.iterate()) {
        if (resultWidth > Object.keys(row).length) throw new Error('Duplicate result column names; use distinct aliases');
        rows.push(row);
        if (rows.length > limit) break;
      }
      if (!columns.length && rows.length) columns.push(...Object.keys(rows[0]));
      if (!columns.length && !rows.length && kind === 'SELECT') {
        // Node 23.9 lacks StatementSync.columns(); a temporary view exposes empty SELECT metadata.
        db.exec(`PRAGMA query_only=OFF; CREATE TEMP VIEW "__workspace_result__" AS ${sql}`);
        columns.push(...db.prepare('PRAGMA temp.table_info("__workspace_result__")').all().map((column) => column.name));
        if (!writable) db.exec('PRAGMA query_only=ON;');
      }
      if (new Set(columns).size !== columns.length) throw new Error('Duplicate result column names; use distinct aliases');
      if (writable) db.exec('COMMIT');
      return { columns, rows: rows.slice(0, limit), rowCount: Math.min(rows.length, limit), hasMore: rows.length > limit };
    }
    if (!tableExists(task.table)) throw new Error('Unknown table or view');
    const reference = `${q(schema)}.${q(task.table)}`;
    const columns = db.prepare(`PRAGMA main.table_info(${q(task.table)})`).all();
    if (task.action === 'count') {
      if (task.filterColumn !== undefined && !columns.some((column) => column.name === task.filterColumn)) throw new Error('Unknown column');
      const { where, params } = filterClause(task, q);
      return { total: Number(db.prepare(`SELECT COUNT(*) AS total FROM ${reference}${where}`).get(...params).total), exact: true };
    }
    if (task.action === 'inspect') {
      const primaryOf = (table) => db.prepare(`PRAGMA main.table_info(${q(table)})`).all()
        .filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
      const indexes = db.prepare(`PRAGMA main.index_list(${q(task.table)})`).all().map((index) => ({
        name: index.name, unique: Boolean(index.unique), origin: index.origin,
        columns: db.prepare(`PRAGMA main.index_info(${q(index.name)})`).all().map((column) => column.name),
      }));
      // `REFERENCES parent` without columns targets the parent's primary key; PRAGMA reports `to` as null.
      const foreignKeys = db.prepare(`PRAGMA main.foreign_key_list(${q(task.table)})`).all()
        .map((key) => ({ ...key, to: key.to ?? primaryOf(key.table)[key.seq] ?? null }));
      return {
        columns: columns.map((column) => ({ name: column.name, type: column.type, nullable: !column.notnull && !column.pk,
          default: column.dflt_value, primaryKey: Boolean(column.pk) })),
        indexes, foreignKeys,
        definition: db.prepare('SELECT sql FROM main.sqlite_master WHERE name=?').get(task.table)?.sql,
      };
    }
    if (task.action !== 'rows') throw new Error('Unsupported database action');
    const { limit, offset, direction } = pageOptions(task);
    for (const name of [task.sortColumn, task.filterColumn]) {
      if (name !== undefined && !columns.some((column) => column.name === name)) throw new Error('Unknown column');
    }
    const { where, params } = filterClause(task, q);
    const order = task.sortColumn ? [{ name: task.sortColumn }] : columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
    const orderSql = order.length ? ` ORDER BY ${order.map((column) => q(column.name) + ' ' + direction).join(', ')}` : '';
    const stmt = db.prepare(`SELECT * FROM ${reference}${where}${orderSql} LIMIT ? OFFSET ?`);
    stmt.setReadBigInts(true);
    const rows = stmt.all(...params, limit + 1, offset);
    return { columns: columns.map((column) => column.name), rows: rows.slice(0, limit), hasMore: rows.length > limit,
      stableOrder: !task.sortColumn && order.length > 0 };
  } finally {
    db.close();
  }
}

process.once('message', ({ profile, task }) => {
  try { process.send({ result: execute(profile, task) }); }
  catch (error) { process.send({ error: { message: error.message, code: error.code } }); }
  finally { process.disconnect(); }
});
