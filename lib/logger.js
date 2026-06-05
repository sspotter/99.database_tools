const supportsColor = process.stdout.isTTY;
const supportsEmoji = process.env.DB_TOOLKIT_EMOJI === 'true';

const color = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

function paint(code, text) {
  if (!supportsColor) {
    return text;
  }
  return `${code}${text}${color.reset}`;
}

export function logInfo(message) {
  const prefix = supportsEmoji ? 'ℹ️ ' : '';
  console.log(paint(color.cyan, `${prefix}[info] ${message}`));
}

export function logSuccess(message) {
  const prefix = supportsEmoji ? '✅ ' : '';
  console.log(paint(color.green, `${prefix}[ok] ${message}`));
}

export function logWarn(message) {
  const prefix = supportsEmoji ? '⚠️ ' : '';
  console.warn(paint(color.yellow, `${prefix}[warn] ${message}`));
}

export function logError(message) {
  const prefix = supportsEmoji ? '❌ ' : '';
  console.error(paint(color.red, `${prefix}[error] ${message}`));
}

export function logPlain(message) {
  console.log(message);
}

export function dim(message) {
  return paint(color.dim, message);
}
