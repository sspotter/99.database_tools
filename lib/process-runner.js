import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, open, link, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

function diagnosticFilter(env, redact) {
  const secrets = [...Object.entries(env).filter(([name]) => /password|pwd|secret|token/i.test(name)).map(([, secret]) => secret), ...redact].filter(Boolean);
  return (diagnostic) => {
    let clean = diagnostic;
    for (const secret of secrets) {
      clean = clean.split(String(secret)).join('[REDACTED]');
      // A capture limit may split a secret at the end of stderr.
      for (let length = Math.min(String(secret).length - 1, clean.length); length > 0; length--) {
        if (clean.endsWith(String(secret).slice(0, length))) {
          clean = clean.slice(0, -length) + '[REDACTED]';
          break;
        }
      }
    }
    return clean.replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@/]+:)[^\s@]+@/gi, '$1[REDACTED]@');
  };
}

async function outputStage(outputFile) {
  if (!outputFile) return null;
  await mkdir(path.dirname(outputFile), { recursive: true });
  try {
    await lstat(outputFile);
    throw new Error('Output destination already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stagePath = `${outputFile}.${randomUUID()}.partial`;
  const file = await open(stagePath, 'wx', 0o600);
  return { stagePath, stream: file.createWriteStream() };
}

async function streamChild(command, args, options, stage) {
  const { env, inputFile, timeoutMs, signal, sanitize } = options;
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  const decoder = new StringDecoder('utf8');
  let failure;
  const stop = (message) => { failure ||= new Error(message); child.kill('SIGKILL'); };
  child.stderr.on('data', (chunk) => { diagnostic += decoder.write(chunk).slice(0, Math.max(0, 65536 - diagnostic.length)); });
  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`Native client failed: ${error.code || 'spawn error'}`)));
    child.once('close', (code) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Native client failed with exit code ${code}: ${sanitize(diagnostic).trim()}`));
      else resolve();
    });
  });
  const timer = setTimeout(() => stop('Native client timed out'), timeoutMs);
  const abort = () => stop('Native client aborted');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const streams = [];
  if (inputFile) streams.push(pipeline(fs.createReadStream(inputFile), child.stdin));
  else child.stdin.end();
  if (stage) streams.push(pipeline(child.stdout, stage.stream));
  else child.stdout.resume();
  const guardedStreams = streams.map((stream) => stream.catch((error) => {
    stop(`Native client stream failed: ${error.code || 'I/O error'}`);
    throw failure;
  }));
  try {
    const outcomes = await Promise.allSettled([completion, ...guardedStreams]);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function runProcess(command, args, { env = process.env, inputFile, outputFile, timeoutMs = 600000, signal, redact = [] } = {}) {
  if (signal?.aborted) throw new Error('Native client aborted');
  const sanitize = diagnosticFilter(env, redact);
  let stage;
  try {
    stage = await outputStage(outputFile);
    await streamChild(command, args, { env, inputFile, timeoutMs, signal, sanitize }, stage);
    // Hard-link publication is atomic and refuses a destination created during the dump.
    if (stage) await link(stage.stagePath, outputFile);
    return { exitCode: 0 };
  } finally {
    if (stage) {
      stage.stream.destroy();
      await unlink(stage.stagePath);
    }
  }
}
