import { $, el, icon, engineBadge, state, bus, actions, notice, profileById, recentIds } from './core.js';
import { buildSearchIndex, searchIndex, levelsFor, nodeKey } from './models.js';
import { loadCatalog, chooseDatabase, chooseSchema, selectConnection, defaultDatabase } from './nav.js';
import { showView } from './shell.js';

let index = [];
let dirty = true;
let results = [];
let active = 0;

function currentIndex() {
  if (dirty) {
    index = buildSearchIndex({ profiles: state.profiles, connected: state.connected, databasesByProfile: state.databasesByProfile, catalogs: state.catalogs });
    dirty = false;
  }
  return index;
}

function highlight(text, query) {
  const node = el('span', 'search-label');
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) { node.textContent = text; return node; }
  node.append(document.createTextNode(text.slice(0, at)), Object.assign(el('mark'), { textContent: text.slice(at, at + query.length) }), document.createTextNode(text.slice(at + query.length)));
  return node;
}

function iconFor(entry) {
  if (entry.kind === 'connection') return engineBadge(entry.engine);
  return icon({ database: 'database', schema: 'schema', table: 'table', view: 'view' }[entry.kind]);
}

function loadedDatabaseCount() {
  return Object.values(state.catalogs).filter((catalog) => catalog.status === 'ready').length;
}

function render() {
  const input = $('globalSearch');
  const box = $('searchResults');
  const query = input.value.trim();
  box.replaceChildren();
  if (!query) {
    results = recentIds().map((id) => profileById(id)).filter(Boolean)
      .map((profile) => ({ kind: 'connection', label: profile.name, detail: [profile.engine, profile.group, profile.environment].filter(Boolean).join(' · '), profileId: profile.id, engine: profile.engine }));
    if (results.length) box.append(el('div', 'search-title', 'Recent connections'));
    else box.append(el('div', 'search-note', 'Type to search connections, databases, schemas, tables and views.'));
  } else {
    results = searchIndex(currentIndex(), query);
    if (!results.length) box.append(el('div', 'search-note', `No matches for “${query}”.`));
  }
  active = Math.min(active, Math.max(0, results.length - 1));
  results.forEach((entry, position) => {
    const option = el('div', 'search-option');
    option.id = `search-option-${position}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(position === active));
    option.append(iconFor(entry), highlight(entry.label, query), el('span', 'search-detail', entry.detail), el('span', 'search-kind', entry.kind));
    option.addEventListener('mousedown', (event) => { event.preventDefault(); choose(entry); });
    option.addEventListener('mousemove', () => { if (active !== position) { active = position; mark(); } });
    box.append(option);
  });
  if (query) box.append(el('div', 'search-note', `Searched ${state.profiles.length} connection${state.profiles.length === 1 ? '' : 's'} and ${loadedDatabaseCount()} loaded database${loadedDatabaseCount() === 1 ? '' : 's'}. Expand a database in the tree to include it.`));
  input.setAttribute('aria-activedescendant', results.length ? `search-option-${active}` : '');
}

function mark() {
  const input = $('globalSearch');
  [...$('searchResults').querySelectorAll('[role="option"]')].forEach((node, position) => {
    node.setAttribute('aria-selected', String(position === active));
    if (position === active) node.scrollIntoView({ block: 'nearest' });
  });
  input.setAttribute('aria-activedescendant', results.length ? `search-option-${active}` : '');
}

function open() {
  const input = $('globalSearch');
  $('searchResults').hidden = false;
  input.setAttribute('aria-expanded', 'true');
  // Make sure each connected connection's default database is searchable.
  for (const profile of state.profiles) if (state.connected.has(profile.id) && state.databasesByProfile[profile.id]) loadCatalog(profile, defaultDatabase(profile));
  render();
}
function close() {
  $('searchResults').hidden = true;
  $('globalSearch').setAttribute('aria-expanded', 'false');
}

function choose(entry) {
  const profile = profileById(entry.profileId);
  $('globalSearch').value = '';
  close();
  if (!profile) return;
  showView('workspace');
  if (entry.kind === 'connection') {
    selectConnection(profile.id);
    if (!state.connected.has(profile.id)) notice(`${profile.name} is not connected. Choose Connect to explore it.`);
  } else if (entry.kind === 'database') {
    state.expanded.add(nodeKey('c', profile.id)); state.expanded.add(nodeKey('d', profile.id, entry.database));
    chooseDatabase(profile, entry.database);
  } else if (entry.kind === 'schema') {
    state.expanded.add(nodeKey('c', profile.id));
    if (levelsFor(profile.engine).database) state.expanded.add(nodeKey('d', profile.id, entry.database));
    chooseSchema(profile, entry.database, entry.schema);
  } else {
    actions.openTable({ profileId: profile.id, database: entry.database, schema: entry.schema, name: entry.name, objectType: entry.objectType });
    $('workspace').focus();
  }
}

export function initSearch() {
  const input = $('globalSearch');
  $('searchHint').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
  input.addEventListener('focus', open);
  input.addEventListener('input', () => { active = 0; if ($('searchResults').hidden) open(); else render(); });
  input.addEventListener('blur', close);
  $('searchResults').addEventListener('mousedown', (event) => event.preventDefault());   // scrollbar/padding clicks must not blur the input
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if ($('searchResults').hidden) open();
      if (results.length) { active = (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; mark(); }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (results[active]) choose(results[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (input.value) { input.value = ''; render(); } else { close(); input.blur(); }
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); input.focus(); input.select(); }
  });
  const markDirty = () => { dirty = true; if (!$('searchResults').hidden) render(); };
  for (const name of ['tree', 'profiles']) bus.on(name, markDirty);
}
