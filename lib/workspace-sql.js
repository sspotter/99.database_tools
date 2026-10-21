import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The lexer preserves quoted/comment semicolons; T-SQL additionally requires a grammar parser.
export function analyzeStatement(sql, engine) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 1_000_000) throw new Error('SQL text is required (maximum 1 MB)');
  let end = -1;
  let meaningful = false;
  let depth = 0;
  const topTokens = [];
  let parsedAst;
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith('--', i) || (engine === 'mysql' && c === '#')) {
      const lineEnd = sql.indexOf('\n', i);
      i = lineEnd < 0 ? sql.length : lineEnd + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      if (engine === 'mysql' && /[!+]/.test(sql[i + 2] || '')) throw new Error('Executable SQL comments are not allowed');
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i) && (engine === 'postgres' || engine === 'mssql')) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      continue;
    }
    if (c === ';') {
      if (end !== -1 || !meaningful) throw new Error('Execute exactly one statement');
      end = i++;
      continue;
    }
    if (end !== -1) throw new Error('Execute exactly one statement');
    meaningful = true;
    if (/[A-Za-z_]/.test(c)) {
      const token = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/)[0];
      if (depth === 0) topTokens.push(token.toUpperCase());
      i += token.length;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '$' && engine === 'postgres') {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close < 0) throw new Error('Unterminated dollar-quoted SQL string');
        i = close + tag.length;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      const backslash = engine === 'mysql' || (engine === 'postgres' && /[eE]/.test(sql[i - 1] || '') && !/[\w$]/.test(sql[i - 2] || ''));
      i++;
      let closed = false;
      while (i < sql.length) {
        if (backslash && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === close) {
          if (sql[i + 1] === close) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) throw new Error('Unterminated SQL quote');
      continue;
    }
    i++;
  }
  if (!meaningful) throw new Error('SQL text is required');
  if (engine === 'mssql') {
    if (topTokens.some((token) => ['RETURN', 'BREAK', 'CONTINUE', 'COMMIT', 'ROLLBACK', 'CHECKPOINT', 'RECONFIGURE', 'SHUTDOWN', 'REVERT'].includes(token))) {
      throw new Error('Execute exactly one statement; unsupported SQL Server control syntax');
    }
    let ast;
    try {
      const { Parser } = require('node-sql-parser/build/transactsql');
      ast = new Parser().astify(end < 0 ? sql : sql.slice(0, end));
    } catch { throw new Error('Unsupported SQL Server syntax; execute one SELECT, INSERT, UPDATE, or DELETE statement'); }
    const statements = Array.isArray(ast) ? ast : [ast];
    if (statements.length !== 1) throw new Error('Execute exactly one statement');
    if (!['select', 'insert', 'update', 'delete'].includes(statements[0]?.type)) throw new Error('Unsupported SQL Server statement; use a single SELECT, INSERT, UPDATE, or DELETE');
    parsedAst = statements[0];
  }
  const kind = topTokens[0] === 'WITH' ? topTokens.find((token) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(token)) : topTokens[0];
  return { sql: (end < 0 ? sql : sql.slice(0, end)).trim(), kind, topTokens, ast: parsedAst };
}

export function singleStatement(sql, engine) { return analyzeStatement(sql, engine).sql; }

export function assertQualifiedSqlServerTables(ast) {
  const requireQualified = (table, localNames) => {
    if (typeof table.table === 'string' && !table.db && !table.schema && !localNames.has(table.table)) {
      throw new Error('SQL Server queries with a selected schema must explicitly qualify physical tables as [schema].[table]');
    }
  };
  const walk = (value, inheritedCtes) => {
    if (!value || typeof value !== 'object') return;
    const ctes = new Set(inheritedCtes);
    for (const cte of Array.isArray(value.with) ? value.with : []) {
      ctes.add(cte.name.value);
      walk(cte.stmt, ctes);
    }
    const sources = Array.isArray(value.from) ? value.from : [];
    for (const table of sources) requireQualified(table, ctes);
    const targetNames = new Set(ctes);
    if (['update', 'delete'].includes(value.type)) {
      for (const table of sources) if (table.as) targetNames.add(table.as);
    }
    for (const table of Array.isArray(value.table) ? value.table : []) requireQualified(table, targetNames);
    // The installed parser cannot represent qualified SELECT INTO destinations.
    if (value.into?.type === 'into') {
      throw new Error('SQL Server SELECT INTO cannot qualify its destination here; use an explicitly qualified INSERT');
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'with') {
        walk(child, ctes);
      }
    }
  };
  walk(ast, new Set());
}

export function pageOptions(task) {
  const limit = task.limit ?? 500;
  const offset = task.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be an integer from 1 to 1000');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Offset must be a nonnegative integer');
  const direction = (task.sortDirection ?? 'asc').toLowerCase();
  if (!['asc', 'desc'].includes(direction)) throw new Error('Invalid sort direction');
  return { limit, offset, direction };
}

export function quoteName(name, engine) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.length > 1024) throw new Error('Invalid database identifier');
  if (engine === 'mysql') return '`' + name.replaceAll('`', '``') + '`';
  if (engine === 'mssql') return '[' + name.replaceAll(']', ']]') + ']';
  return '"' + name.replaceAll('"', '""') + '"';
}
