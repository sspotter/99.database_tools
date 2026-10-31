import { $, el, state, bus, actions, icon, popover, menuItem, menuKeys, safeStorage, activeTab, selected, profileById, engineBadge } from './core.js';
import { serverLabel, formatMs, baseName, engineMeta } from './format.js';
import { renderDashboard, renderSettings } from './views.js';

const VIEWS = ['workspace', 'dashboard', 'logs', 'settings'];
const COLLAPSED_KEY = 'database-toolkit-sidebar-collapsed';

export function showView(view) {
  state.view = view;
  for (const name of VIEWS) {
    $(name + 'View').hidden = name !== view;
    const nav = $(name + 'Nav');
    nav.classList.toggle('active', name === view);
    if (name === view) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  if (view === 'dashboard') renderDashboard();
  if (view === 'settings') renderSettings();
  if (view === 'logs') { state.errors = 0; $('errorCount').textContent = ''; }
  bus.emit('view');
}

function contextProfile() {
  const tab = activeTab();
  if (tab && state.connected.has(tab.profile.id)) return profileById(tab.profile.id) ?? null;
  const chosen = selected();
  return chosen && state.connected.has(chosen.id) ? chosen : null;
}
function endpointText(profile) {
  if (profile.engine === 'sqlite') return baseName(profile.settings.file);
  return [profile.settings.host || 'localhost', profile.settings.port].filter(Boolean).join(':');
}

export function renderStatusBar() {
  const root = $('statusBar');
  root.replaceChildren();
  const count = state.connected.size;
  const left = el('div', 'status-item');
  left.append(el('span', `dot${count ? ' ok' : ''}`), el('span', '', count ? `${count} connection${count === 1 ? '' : 's'} active` : 'No active connections'));
  const middle = el('div', 'status-item status-server');
  const profile = contextProfile();
  if (profile) {
    middle.append(engineBadge(profile.engine), el('span', '', serverLabel(state.serverInfo[profile.id]) || engineMeta(profile.engine).name),
      el('span', 'sep', '•'), el('span', '', endpointText(profile)));
  }
  const right = el('div', 'status-item status-run');
  right.setAttribute('aria-live', 'polite');
  const run = state.lastRun;
  if (run) {
    const text = run.ok ? `${run.label} in ${formatMs(run.ms)}` : `${run.label} failed`;
    right.append(icon(run.ok ? 'check-circle' : 'alert', run.ok ? 'ok' : 'bad'), el('span', run.ok ? 'ok' : 'bad', text));
  }
  root.append(left, middle, right);
}

export function initShell() {
  for (const name of VIEWS) $(name + 'Nav').addEventListener('click', () => showView(name));
  const shell = $('appShell');
  const toggle = $('sidebarToggle');
  const compact = () => matchMedia('(max-width:680px)').matches;
  const setCollapsed = (collapsed) => {
    shell.classList.toggle('sidebar-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    safeStorage.set(COLLAPSED_KEY, collapsed);
  };
  if (!compact()) setCollapsed(safeStorage.get(COLLAPSED_KEY, false) === true);
  toggle.addEventListener('click', () => {
    if (compact()) {
      const open = $('sidebar').classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    } else setCollapsed(!shell.classList.contains('sidebar-collapsed'));
  });
  $('collapseSidebar').addEventListener('click', () => (compact() ? toggle.click() : setCollapsed(true)));

  const more = $('moreMenu');
  more.addEventListener('click', () => {
    const menu = el('div', 'menu');
    menu.setAttribute('role', 'menu');
    menu.append(
      menuItem('Refresh connections', 'refresh', () => { handle.close(true); actions.refreshProfiles(); }),
      menuItem('Add current configuration', 'plug', () => { handle.close(true); actions.importCurrent(); }),
    );
    menuKeys(menu);
    const handle = popover(more, menu, { align: 'end' });
    menu.querySelector('button').focus();
  });

  for (const name of ['status', 'profiles', 'tabs', 'target', 'view']) bus.on(name, renderStatusBar);
  renderStatusBar();
}
