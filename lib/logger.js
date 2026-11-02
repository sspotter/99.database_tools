// Color is on whenever the terminal supports it (or FORCE_COLOR is set),
// and off when output is piped to a non-TTY unless explicitly forced.
const supportsColor = Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === '1';
// Emoji is on by default so seed/migrate/create/etc. are easy to scan at a
// glance; set DB_TOOLKIT_EMOJI=false to disable (e.g. logging to a plain file).
const supportsEmoji = process.env.DB_TOOLKIT_EMOJI !== 'false';

const color = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

// Sinks receive a structured copy of every log line in addition to the console
// output, so the web UI can stream command output without scraping stdout.
const logSinks = new Set();

export function addLogSink(sink) {
  logSinks.add(sink);
}

export function removeLogSink(sink) {
  logSinks.delete(sink);
}

function emitToSinks(level, message) {
  for (const sink of logSinks) {
    sink({ level, message });
  }
}

function paint(code, text) {
  if (!supportsColor) {
    return text;
  }
  return `${code}${text}${color.reset}`;
}

export function logInfo(message) {
  const prefix = supportsEmoji ? 'ℹ️ ' : '';
  console.log(paint(color.cyan, `${prefix}[info] ${message}`));
  emitToSinks('info', message);
}

export function logSuccess(message) {
  const prefix = supportsEmoji ? '✅ ' : '';
  console.log(paint(color.green, `${prefix}[ok] ${message}`));
  emitToSinks('ok', message);
}

export function logWarn(message) {
  const prefix = supportsEmoji ? '⚠️ ' : '';
  console.warn(paint(color.yellow, `${prefix}[warn] ${message}`));
  emitToSinks('warn', message);
}

export function logError(message) {
  const prefix = supportsEmoji ? '❌ ' : '';
  console.error(paint(color.red, `${prefix}[error] ${message}`));
  emitToSinks('error', message);
}

export function logPlain(message) {
  console.log(message);
  emitToSinks('plain', message);
}
