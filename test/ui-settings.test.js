import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, sanitizeSettings, createSettings, SETTINGS_KEY } from '../ui/settings.js';

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { get: (key, fallback) => (data.has(key) ? data.get(key) : fallback), set: (key, value) => { data.set(key, value); return true; }, data };
};

test('sanitizeSettings falls back to defaults for unknown or malformed values', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ pageSize: 7, countTimeoutMs: 'x', statusPills: 'yes', alignNumbers: 0, inspectorOpen: null }), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ pageSize: 250, countTimeoutMs: 10000, statusPills: false, alignNumbers: false, inspectorOpen: false }),
    { pageSize: 250, countTimeoutMs: 10000, statusPills: false, alignNumbers: false, inspectorOpen: false });
});

test('createSettings loads, updates, persists, notifies and resets', () => {
  const storage = memory({ [SETTINGS_KEY]: { pageSize: 50, bogus: true } });
  const settings = createSettings(storage);
  assert.equal(settings.get().pageSize, 50);
  assert.equal('bogus' in settings.get(), false);
  const seen = [];
  const off = settings.subscribe((value) => seen.push(value.statusPills));
  settings.update({ statusPills: false });
  assert.deepEqual(seen, [false]);
  assert.equal(storage.data.get(SETTINGS_KEY).statusPills, false);
  settings.update({ pageSize: 9999 });
  assert.equal(settings.get().pageSize, 100, 'invalid values revert to the default');
  off();
  settings.reset();
  assert.deepEqual(settings.get(), DEFAULT_SETTINGS);
  // The 50->100 revert is a real change and notifies; the reset after off() does not.
  assert.deepEqual(seen, [false, false]);
});
