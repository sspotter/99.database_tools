import { el, button, icon, state, actions, capability, clearHistory } from './core.js';
import { exportButton } from './grid.js';

const supported = (tab) => capability(tab.profile, 'query') && (!tab.profile.readOnly || capability(tab.profile, 'readOnlyQuery'));

export function renderQueryTools(tab, root, blocked) {
  root.replaceChildren();
  const run = el('button', 'primary tool-run');
  run.type = 'button';
  run.disabled = blocked || !supported(tab) || tab.busy;
  run.append(icon('chevron'), document.createTextNode('Run SQL'));
  run.addEventListener('click', () => actions.executeTab(tab));
  root.append(run, button('Cancel', () => actions.cancelTab(tab), '', !tab.busy),
    el('span', 'hint', 'Ctrl / Cmd + Enter · One statement · No shared transaction'), el('span', 'toolbar-spacer'), exportButton(tab));
}

export function renderQuery(tab, root, blocked) {
  if (tab.profile.engine === 'mssql') {
    root.append(el('p', 'hint', 'SQL Server uses your login’s default schema for unqualified names. Use [schema].[table] to target the schema shown in the header.'));
  }
  if (!supported(tab)) root.append(el('p', 'hint', 'Arbitrary SQL is unavailable for this engine or its read-only mode. Table browsing remains available.'));
  const editor = el('textarea', 'sql-editor');
  editor.value = tab.sql;
  editor.placeholder = 'Write one SQL statement…';
  editor.spellcheck = false;
  editor.setAttribute('aria-label', 'SQL statement');
  editor.addEventListener('input', () => { tab.sql = editor.value; });
  editor.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!tab.busy && !blocked && supported(tab) && tab.sql.trim()) actions.executeTab(tab);
    }
  });
  root.append(editor, el('div', 'tab-toolbar'), el('div', 'tab-region'), el('div', 'tab-footer'));

  const section = el('details', 'history');
  section.append(el('summary', '', 'Query history'));
  section.append(el('p', 'hint', 'Session-only unless enabled in Settings. SQL may contain sensitive values; password statements and credential URLs are never stored. Up to 100 entries.'));
  const list = el('div');
  const draw = () => {
    list.replaceChildren();
    const entries = state.history.filter((item) => item.profileId === tab.profile.id && item.database === tab.database);
    if (!entries.length) list.append(el('p', 'hint', 'No history for this connection and database.'));
    for (const item of entries.slice(0, 20)) {
      const line = el('div', 'history-row');
      line.append(button(item.sql, () => { tab.sql = item.sql; editor.value = item.sql; editor.focus(); }), el('span', 'hint', new Date(item.at).toLocaleString()));
      list.append(line);
    }
  };
  section.append(button('Clear all history', () => { clearHistory(); draw(); }, 'small'), list);
  section.addEventListener('toggle', () => { if (section.open) draw(); });
  root.append(section);
}
