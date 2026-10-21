import { Worker } from 'node:worker_threads';
import { pageOptions, analyzeStatement, quoteName, assertQualifiedSqlServerTables } from './workspace-sql.js';

const engines = new Set(['sqlite', 'postgres', 'mysql', 'mssql']);

export function getCapabilities(engine) {
  const supported = engines.has(engine);
  return {
    browse: supported, query: supported, readOnlyQuery: supported && engine !== 'mssql',
    databases: supported, schemas: supported, inspect: supported, cancel: supported,
  };
}

export function runDatabaseTask(profile, task, { signal, timeoutMs = 30_000 } = {}) {
  if (!engines.has(profile?.engine)) return Promise.reject(new Error('Unsupported database engine'));
  try {
    if (!task || !['test', 'databases', 'schemas', 'tables', 'rows', 'inspect', 'query'].includes(task.action)) throw new Error('Unsupported database action');
    for (const field of ['database', 'schema', 'table', 'sortColumn', 'filterColumn']) {
      if (task[field] !== undefined) quoteName(task[field], profile.engine);
    }
    if (['rows', 'inspect'].includes(task.action) && !task.table) throw new Error('Table is required');
    if (['rows', 'query'].includes(task.action)) pageOptions(task);
    if (task.filterColumn !== undefined && task.filterValue !== null && !['string', 'number', 'boolean'].includes(typeof task.filterValue)) throw new Error('Filter value must be a scalar or null');
    if (typeof task.filterValue === 'string' && task.filterValue.length > 16384) throw new Error('Filter value is too large');
    if (typeof task.filterValue === 'number' && !Number.isFinite(task.filterValue)) throw new Error('Invalid filter value');
    if (task.action === 'query') {
      const { kind, ast } = analyzeStatement(task.sql, profile.engine);
      if (['BEGIN', 'END', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(kind)) throw new Error('Cross-request transactions are unsupported');
      if (profile.engine === 'mssql' && task.schema) assertQualifiedSqlServerTables(ast);
      if (profile.readOnly !== false && profile.engine === 'mysql' && !['SELECT', 'EXPLAIN', 'SHOW'].includes(kind)) {
        throw new Error('Read-only MySQL SQL supports SELECT, EXPLAIN and SHOW; transaction and procedure commands are not allowed');
      }
      if (profile.readOnly !== false && profile.engine === 'mssql') throw new Error('Read-only SQL is unsupported for SQL Server');
    }
  } catch (error) {
    return Promise.reject(Object.assign(error, { code: 'INVALID_TASK' }));
  }
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Query cancelled'), { code: 'ABORT_ERR' }));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    return Promise.reject(new Error('Invalid query timeout'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workspace-worker.js', import.meta.url), {
      workerData: { profile, task, timeoutMs }, execArgv: [],
    });
    let settled = false;
    let stopping = false;
    let forceTimer;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        for (const secret of [profile.settings?.password]) {
          if (secret) error.message = error.message.replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]');
        }
        error.message = error.message.replace(/(?:postgres(?:ql)?|mysql|mssql|sqlserver):\/\/[^\s]+/gi, '[redacted connection URL]');
        reject(error);
      } else resolve(value);
    };
    let stopError;
    const stop = (error) => {
      if (settled || stopping) return;
      stopping = true;
      stopError = error;
      worker.postMessage({ cancel: true });
      // Async drivers cancel on their native protocol; synchronous SQLite needs termination.
      forceTimer = setTimeout(() => {
        worker.terminate().then(() => finish(error), () => finish(error));
      }, 1000);
    };
    const abort = () => stop(Object.assign(new Error('Query cancelled'), { code: 'ABORT_ERR' }));
    const timer = setTimeout(() => stop(Object.assign(new Error('Query timed out'), { code: 'QUERY_TIMEOUT' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (message) => {
      if (stopping) return;
      if (message.error) {
        finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
      } else finish(null, message.result);
    });
    worker.on('error', (error) => finish(stopError || error));
    worker.on('exit', (code) => {
      if (stopping) finish(stopError);
      else if (!settled) finish(new Error(`Database worker exited unexpectedly (${code})`));
    });
    if (signal?.aborted) abort();
  });
}
