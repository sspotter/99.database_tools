import { parentPort, workerData } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runServerTask } from './workspace-server-engines.js';

let cancel = () => {};
let cancelled = false;
parentPort.on('message', (message) => {
  if (message.cancel) { cancelled = true; cancel(); }
});

function sqliteTask(profile, task) {
  return new Promise((resolve, reject) => {
    // DatabaseSync has no interrupt API on Node 23; a child can be killed inside a native sqlite step.
    const child = fork(fileURLToPath(new URL('./workspace-sqlite-worker.js', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
      execArgv: [],
    });
    let response;
    cancel = () => child.kill();
    child.on('message', (message) => { response = message; });
    child.on('error', reject);
    child.on('exit', () => {
      if (cancelled) reject(new Error('Query cancelled'));
      else if (response?.error) reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
      else if (response) resolve(response.result);
      else reject(new Error('SQLite session exited unexpectedly'));
    });
    child.send({ profile, task });
    if (cancelled) cancel();
  });
}

const started = Date.now();

function serializableResult(result) {
  let truncatedValues = 0;
  const visit = (value, depth = 0) => {
    if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : String(value);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) {
      const binary = '0x' + Buffer.from(value.subarray(0, 8192)).toString('hex');
      if (value.length > 8192) { truncatedValues++; return binary + '… [truncated]'; }
      return binary;
    }
    if (typeof value === 'string' && value.length > 16384) {
      truncatedValues++;
      return value.slice(0, 16384) + '… [truncated]';
    }
    if (value && typeof value === 'object') {
      if (depth > 20) { truncatedValues++; return '[nested value truncated]'; }
      if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, depth + 1)]));
    }
    return value;
  };
  const output = visit(result);
  if (output.rows) {
    output.rows = output.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (value && typeof value === 'object') {
        const json = JSON.stringify(value);
        if (json.length > 16384) { truncatedValues++; return [key, json.slice(0, 16384) + '… [truncated]']; }
      }
      return [key, value];
    })));
  }
  if (truncatedValues) output.truncatedValues = truncatedValues;
  return output;
}
try {
  const { profile, task, timeoutMs } = workerData;
  const result = profile.engine === 'sqlite'
    ? await sqliteTask(profile, task)
    : await runServerTask(profile, task, timeoutMs, (handler) => { cancel = handler; if (cancelled) cancel(); });
  if (task.action === 'query' || task.action === 'rows') result.durationMs = Date.now() - started;
  parentPort.postMessage({ result: serializableResult(result) });
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, code: error.code } });
} finally {
  parentPort.close();
}
