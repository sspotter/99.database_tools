import { createSettings } from './settings.js';

// ---- token: kept in tab-scoped session storage, removed from the address bar -------------------------------
const tokenStorageKey = 'database-toolkit-token:' + location.origin;
const pageUrl = new URL(location.href);
let token = pageUrl.searchParams.get('token') || '';
try {
  if (token) sessionStorage.setItem(tokenStorageKey, token);
  else token = sessionStorage.getItem(tokenStorageKey) || '';
} catch { /* Token remains in memory if browser storage is disabled. */ }
if (pageUrl.searchParams.has('token')) {
  pageUrl.searchParams.delete('token');
  history.replaceState(null, '', pageUrl.pathname + pageUrl.search + pageUrl.hash);
}

// ---- storage: every access is guarded; the UI must work with storage disabled ------------------------------
export const safeStorage = {
  get(key, fallback) { try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage may be disabled */ } },
};

// ---- DOM helpers -------------------------------------------------------------------------------------------
export const $ = (id) => document.getElementById(id);
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
export function button(text, action, className = '', disabled = false) {
  const node = el('button', className, text);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', action);
  return node;
}
export function option(value, text = value) {
  const node = el('option', '', text);
  node.value = value;
  return node;
}
export function label(text, control) {
  const node = el('label', '', text);
  node.append(control);
  return node;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
// References a symbol from the inline sprite in index.html (`<symbol id="i-NAME">`).
export function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon${className ? ' ' + className : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---- state, events, cross-module actions -------------------------------------------------------------------
export const state = {
  profiles: [], profilesVersion: 0, capabilities: {}, persistence: '', selectedId: null,
  connected: new Set(), pendingConnections: new Set(),
  databasesByProfile: {}, catalogs: {}, serverInfo: {}, target: null, expanded: new Set(),
  navigation: null, navigationVersion: 0, // legacy explorer state — removed in phase 4
  tabs: [], activeTab: null, editing: null, errors: 0,
  history: [], persistHistory: false, view: 'workspace', lastRun: null,
};
const listeners = new Map();
export const bus = {
  on(name, listener) {
    const set = listeners.get(name) ?? new Set();
    set.add(listener); listeners.set(name, set);
    return () => set.delete(listener);
  },
  emit(name, detail) { for (const listener of [...(listeners.get(name) ?? [])]) listener(detail); },
};
// Filled in by app.js so feature modules can call profile-level operations without circular imports.
export const actions = {};

export const settings = createSettings(safeStorage);
settings.subscribe(() => bus.emit('settings'));

export const profileById = (id) => state.profiles.find((profile) => profile.id === id);
export const selected = () => profileById(state.selectedId);
export const activeTab = () => state.tabs.find((tab) => tab.id === state.activeTab);
export const endpoint = (profile, action) => `/api/connections/${encodeURIComponent(profile.id)}/${action}`;
export const environment = (profile) => profile.environment || 'development';
export const capability = (profile, key) => state.capabilities[profile.engine]?.[key] === true;
export function targetText(target) {
  return [target.profile.name, target.database || target.profile.settings?.file || target.profile.settings?.database, target.schema, target.table].filter(Boolean).join(' / ');
}

// ---- network -----------------------------------------------------------------------------------------------
export async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-ui-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

export function workspaceRequest(target, task, requestId = crypto.randomUUID()) {
  const requestTask = { ...task };
  for (const key of ['database', 'schema', 'table', 'sortColumn', 'filterColumn']) {
    if (requestTask[key] === '') delete requestTask[key];
  }
  return api('/api/workspace', { profileId: target.profile.id, revision: target.profile.revision, requestId, task: requestTask });
}

// At most 6 browser requests at once (the server allows 16 running); an owner (a tab, the tree) can be cancelled as a unit.
const MAX_CLIENT_REQUESTS = 6;
let activeRequests = 0;
const queued = [];
const runningByOwner = new Map();
function pump() { while (activeRequests < MAX_CLIENT_REQUESTS && queued.length) queued.shift().start(); }
export function runRequest(owner, target, task, requestId = crypto.randomUUID()) {
  return new Promise((resolve, reject) => {
    queued.push({
      owner, reject,
      start() {
        activeRequests++;
        if (!runningByOwner.has(owner)) runningByOwner.set(owner, new Set());
        runningByOwner.get(owner).add(requestId);
        workspaceRequest(target, task, requestId).then(resolve, reject).finally(() => {
          runningByOwner.get(owner)?.delete(requestId);
          activeRequests--;
          pump();
        });
      },
    });
    pump();
  });
}
export function cancelOwner(owner) {
  for (let index = queued.length - 1; index >= 0; index--) {
    if (queued[index].owner === owner) queued.splice(index, 1)[0].reject(new Error('Request cancelled.'));
  }
  for (const requestId of runningByOwner.get(owner) ?? []) api('/api/workspace/cancel', { requestId }).catch(() => {});
}

// ---- notices, logs, last run -------------------------------------------------------------------------------
export function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'error' : '';
}
export function log(message, error = false) {
  const row = el('div', error ? 'error' : '', `${new Date().toLocaleTimeString()} · ${message}`);
  $('logConsole').prepend(row);
  while ($('logConsole').children.length > 200) $('logConsole').lastChild.remove();
  if (error) { state.errors++; $('errorCount').textContent = `(${state.errors})`; }
}
export function fail(error, context) {
  notice(`${context}: ${error.message}`, true);
  log(`${context}: ${error.message}`, true);
}
export function recordRun(ok, ms, label) {
  state.lastRun = { ok, ms, label };
  bus.emit('status');
}

// ---- popover (menus, filter form, export menu) -------------------------------------------------------------
let openPopover = null;
// `anchor` is an element or { getBoundingClientRect() } for pointer-positioned menus.
export function popover(anchor, content, { onClose, align = 'start' } = {}) {
  openPopover?.close(false);
  const element = el('div', 'popover');
  element.append(content);
  document.body.append(element);
  anchor.setAttribute?.('aria-expanded', 'true');
  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const left = align === 'end' ? rect.right - element.offsetWidth : rect.left;
    element.style.left = `${Math.max(8, Math.min(left, innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - element.offsetHeight - 8))}px`;
  };
  place();
  const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); handle.close(true); } };
  const onDown = (event) => { if (!element.contains(event.target) && !anchor.contains?.(event.target)) handle.close(false); };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  const handle = {
    element,
    close(refocus = false) {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      element.remove();
      anchor.setAttribute?.('aria-expanded', 'false');
      if (openPopover === handle) openPopover = null;
      if (refocus) anchor.focus?.();
      onClose?.();
    },
  };
  openPopover = handle;
  return handle;
}

// ---- SQL history (session-only unless the user opts in; secrets are never stored) --------------------------
const HISTORY_KEY = 'database-toolkit-query-history-v1';
const HISTORY_OPT_IN = 'database-toolkit-history-enabled';
state.persistHistory = safeStorage.get(HISTORY_OPT_IN, false) === true;
if (state.persistHistory) {
  const stored = safeStorage.get(HISTORY_KEY, []);
  if (Array.isArray(stored)) state.history = stored.filter((item) => item && typeof item.sql === 'string' && typeof item.profileId === 'string').slice(0, 100);
}
export function saveHistory() {
  const saved = safeStorage.set(HISTORY_OPT_IN, state.persistHistory)
    && (state.persistHistory ? safeStorage.set(HISTORY_KEY, state.history) : (safeStorage.remove(HISTORY_KEY), true));
  if (!saved) { notice('Browser storage is unavailable. Query history is retained for this session only.'); state.persistHistory = false; }
}
export function recordHistory(tab) {
  // Never retain URL credentials or password-setting statements in SQL history.
  if (/:\/\/[^\s]*@|\b(password|identified\s+by|secret|token)\b/i.test(tab.sql)) return;
  state.history.unshift({ profileId: tab.profile.id, database: tab.database, schema: tab.schema, sql: tab.sql, at: new Date().toISOString() });
  state.history = state.history.slice(0, 100);
  saveHistory();
}
export function clearHistory() { state.history = []; saveHistory(); }
