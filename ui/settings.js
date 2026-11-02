export const SETTINGS_KEY = 'database-toolkit-settings-v1';
export const PAGE_SIZES = [50, 100, 250, 500, 1000];
export const COUNT_TIMEOUTS = [2000, 5000, 10000, 30000];
export const DEFAULT_SETTINGS = Object.freeze({ pageSize: 100, countTimeoutMs: 5000, statusPills: true, alignNumbers: true, inspectorOpen: true });

export function sanitizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const pick = (allowed, value, fallback) => (allowed.includes(value) ? value : fallback);
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  return {
    pageSize: pick(PAGE_SIZES, input.pageSize, DEFAULT_SETTINGS.pageSize),
    countTimeoutMs: pick(COUNT_TIMEOUTS, input.countTimeoutMs, DEFAULT_SETTINGS.countTimeoutMs),
    statusPills: flag(input.statusPills, DEFAULT_SETTINGS.statusPills),
    alignNumbers: flag(input.alignNumbers, DEFAULT_SETTINGS.alignNumbers),
    inspectorOpen: flag(input.inspectorOpen, DEFAULT_SETTINGS.inspectorOpen),
  };
}

// `storage` is { get(key, fallback), set(key, value) } — injected so tests need no browser.
export function createSettings(storage) {
  let current = sanitizeSettings(storage.get(SETTINGS_KEY, {}));
  const listeners = new Set();
  const commit = (next) => {
    current = next;
    storage.set(SETTINGS_KEY, current);
    for (const listener of [...listeners]) listener(current);
    return current;
  };
  return {
    get: () => current,
    update: (patch) => commit(sanitizeSettings({ ...current, ...patch })),
    reset: () => commit({ ...DEFAULT_SETTINGS }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
