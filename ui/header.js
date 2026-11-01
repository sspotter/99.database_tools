import { $, el, option, label, engineBadge, state, bus, actions, activeTab, profileById, selected, environment } from './core.js';
import { levelsFor, catalogKey } from './models.js';
import { chooseDatabase, chooseSchema } from './nav.js';
import { baseName } from './format.js';

let scheduled = false;

function selectControl(name, values, value, onChange, disabled) {
  const select = el('select');
  select.setAttribute('aria-label', name);
  for (const item of values) select.append(option(item));
  if (!values.includes(value) && value) select.append(option(value));
  select.value = value;
  select.disabled = disabled;
  select.addEventListener('change', () => onChange(select.value));
  return label(name, select);
}

export function renderHeader() {
  const root = $('workspaceHeader');
  root.replaceChildren();
  const target = state.target;
  const profile = profileById(target?.profileId) ?? selected();
  if (!profile) { root.append(el('p', 'header-empty', 'No connection selected. Choose one in the tree, or add a connection.')); return; }
  const connected = state.connected.has(profile.id);
  const levels = levelsFor(profile.engine);
  const own = target && target.profileId === profile.id ? target : null;
  const tab = activeTab();
  const showTable = Boolean(own && tab?.kind === 'table' && tab.profile.id === profile.id && tab.database === own.database && tab.schema === own.schema);

  const parts = [profile.name];
  if (own) {
    if (levels.database) parts.push(own.database);
    else if (profile.engine === 'sqlite') parts.push(baseName(profile.settings.file));
    if (levels.schema && own.schema) parts.push(own.schema);
  }
  if (showTable) parts.push(tab.table);
  const crumbs = el('nav', 'crumbs');
  crumbs.setAttribute('aria-label', 'Current location');
  crumbs.append(engineBadge(profile.engine));
  parts.forEach((part, index) => {
    if (index) crumbs.append(el('span', 'crumb-sep', '/'));
    const last = index === parts.length - 1;
    crumbs.append(el(last ? 'strong' : 'span', `crumb${last ? ' current' : ''}${index === 0 && environment(profile) === 'production' ? ' environment-production' : ''}`, part));
  });

  const status = el('div', 'header-status');
  const state_ = el('span', `conn-status${connected ? ' on' : ''}`);
  state_.append(el('span', `tree-dot${connected ? ' on' : ''}`), el('span', '', connected ? 'Connected' : 'Disconnected'));
  status.append(state_);
  if (environment(profile) !== 'development') status.append(el('span', `badge${environment(profile) === 'production' ? ' environment-production' : ''}`, environment(profile)));
  status.append(el('span', `badge${profile.readOnly ? '' : ' writable'}`, profile.readOnly ? 'Read-only' : 'Writable SQL'));
  if (!connected) {
    const connect = el('button', 'primary small', state.pendingConnections.has(profile.id) ? 'Working…' : 'Connect');
    connect.type = 'button';
    connect.disabled = state.pendingConnections.has(profile.id);
    connect.addEventListener('click', () => actions.toggleConnection(profile));
    status.append(connect);
  }
  const line = el('div', 'header-line');
  line.append(crumbs, status);
  root.append(line);

  if (!connected || !own || (!levels.database && !levels.schema)) return;
  const selectors = el('div', 'header-selectors');
  if (levels.database) {
    selectors.append(selectControl('Database', state.databasesByProfile[profile.id] ?? [], own.database, (value) => chooseDatabase(profile, value), false));
  }
  if (levels.schema) {
    const catalog = state.catalogs[catalogKey(profile.id, own.database)];
    const names = catalog?.status === 'ready' ? catalog.schemas.map((schema) => schema.name) : [];
    selectors.append(selectControl('Schema', names, own.schema, (value) => chooseSchema(profile, own.database, value), !names.length));
  }
  root.append(selectors);
}

export function initHeader() {
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; renderHeader(); });
  };
  for (const name of ['target', 'profiles', 'tabs', 'tree']) bus.on(name, schedule);
  renderHeader();
}
