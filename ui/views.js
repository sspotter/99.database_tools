import { $, el, option, state, settings, notice, clearHistory, saveHistory, engineBadge } from './core.js';
import { serverLabel, engineMeta } from './format.js';
import { PAGE_SIZES, COUNT_TIMEOUTS } from './settings.js';

export function renderDashboard() {
  const root = $('dashboardContent');
  root.replaceChildren();
  const rows = [
    ['Saved connections', state.profiles.length], ['Connected', state.connected.size], ['Open tabs', state.tabs.length],
    ['Credential storage', state.persistence === 'windows-dpapi' ? 'Windows account encryption' : 'Session only'],
  ];
  for (const [name, value] of rows) {
    const row = el('div', 'status-row');
    row.append(el('span', '', name), el('strong', '', value));
    root.append(row);
  }
  const active = state.profiles.filter((profile) => state.connected.has(profile.id));
  if (!active.length) return;
  root.append(el('h3', '', 'Active connections'));
  for (const profile of active) {
    const row = el('div', 'status-row');
    const name = el('span', 'engine-line');
    name.append(engineBadge(profile.engine), el('span', '', profile.name));
    row.append(name, el('strong', '', serverLabel(state.serverInfo[profile.id]) || engineMeta(profile.engine).name));
    root.append(row);
  }
}

function row(title, hint, control) {
  const wrap = el('div', 'settings-row');
  const text = el('div');
  const heading = el('label', '', title);
  heading.htmlFor = control.id;
  text.append(heading, el('p', 'hint', hint));
  wrap.append(text, control);
  return wrap;
}
function selectControl(key, values, format) {
  const select = el('select');
  select.id = `setting-${key}`;
  for (const value of values) select.append(option(String(value), format(value)));
  select.value = String(settings.get()[key]);
  select.addEventListener('change', () => settings.update({ [key]: Number(select.value) }));
  return select;
}
function checkControl(id, checked, onChange) {
  const input = el('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}
function group(title, ...rows) {
  const section = el('section', 'settings-group');
  section.append(el('h3', '', title), ...rows);
  return section;
}

export function renderSettings() {
  const root = $('settingsContent');
  root.replaceChildren();
  const current = settings.get();
  const flag = (key) => (checked) => settings.update({ [key]: checked });
  root.append(
    group('Table browsing',
      row('Rows per page', 'Default page size for newly opened tables.', selectControl('pageSize', PAGE_SIZES, String)),
      row('Row-count timeout', 'How long to wait for the exact total before showing “100+ rows”.', selectControl('countTimeoutMs', COUNT_TIMEOUTS, (value) => `${value / 1000} s`)),
      row('Show table details panel', 'Open the Table details panel beside table data by default.', checkControl('setting-inspectorOpen', current.inspectorOpen, flag('inspectorOpen'))),
      row('Right-align numbers', 'Right-align numeric columns (key columns stay left-aligned).', checkControl('setting-alignNumbers', current.alignNumbers, flag('alignNumbers'))),
      row('Status pills', 'Show short, repeated text values (like order status) as coloured pills.', checkControl('setting-statusPills', current.statusPills, flag('statusPills')))),
    group('SQL history',
      row('Remember SQL history in this browser', 'Session-only by default. SQL may contain sensitive values; password statements and credential URLs are never stored. Up to 100 entries.',
        checkControl('setting-history', state.persistHistory, (checked) => { state.persistHistory = checked; saveHistory(); renderSettings(); })),
      (() => {
        const clear = el('button', '', 'Clear all history');
        clear.id = 'setting-clear-history';
        clear.type = 'button';
        clear.addEventListener('click', () => { clearHistory(); notice('SQL history cleared.'); });
        return row('Clear history', 'Remove every saved and in-session SQL entry.', clear);
      })()),
    group('Credentials',
      (() => {
        const status = el('strong', '', state.persistence === 'windows-dpapi' ? 'Windows account encryption' : 'Session only');
        status.id = 'setting-credentials';
        return row('Credential storage', 'Remembered passwords are encrypted for your Windows account and never returned to the browser. This is set by the operating system and cannot be changed here.', status);
      })()),
    group('Defaults',
      (() => {
        const reset = el('button', '', 'Restore defaults');
        reset.id = 'setting-reset';
        reset.type = 'button';
        reset.addEventListener('click', () => { settings.reset(); renderSettings(); notice('Settings restored to defaults.'); });
        return row('Restore defaults', 'Reset every setting on this page (history choice is separate).', reset);
      })()),
  );
}
