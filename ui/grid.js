import { el, button, option, label, icon, popover, menuItem, menuKeys, state, actions, settings, capability } from './core.js';
import { cellText, toCsv, pageModel, isNumericColumn, isPillColumn, pillTone } from './format.js';
import { PAGE_SIZES } from './settings.js';
import { inspectorVisible } from './inspector.js';

// ---- export (loaded rows only; the label says so) -----------------------------------------------------------
export function exportResult(tab, format) {
  const data = tab.data;
  if (!data?.columns) return;
  const content = format === 'json' ? JSON.stringify(data.rows || [], null, 2) : toCsv(data.columns, data.rows || []);
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
  const anchor = el('a');
  anchor.href = url;
  anchor.download = `loaded-${(tab.table || 'query').replace(/[^a-z0-9_-]/gi, '_')}.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openExport(tab, anchor) {
  const has = Boolean(tab.data?.rows?.length);
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  const run = (format) => () => { handle.close(true); exportResult(tab, format); };
  menu.append(menuItem('Export loaded rows as CSV', 'download', run('csv'), { disabled: !has }), menuItem('Export loaded rows as JSON', 'download', run('json'), { disabled: !has }));
  menuKeys(menu);
  const handle = popover(anchor, menu, { align: 'end' });
  menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
}

export function exportButton(tab) {
  const node = el('button', 'tool');
  node.type = 'button';
  node.setAttribute('aria-haspopup', 'menu');
  node.setAttribute('aria-expanded', 'false');
  node.disabled = !tab.data?.rows?.length;
  node.append(icon('download'), el('span', '', 'Export'), icon('chevron'));
  node.addEventListener('click', () => openExport(tab, node));
  return node;
}

// ---- filter popover -----------------------------------------------------------------------------------------
function openFilter(tab, anchor) {
  const columns = tab.data?.columns ?? tab.metadata?.columns.map((column) => column.name) ?? [];
  const form = el('form', 'filter-form');
  const column = el('select');
  column.setAttribute('aria-label', 'Filter column');
  for (const name of columns) column.append(option(name));
  column.value = columns.includes(tab.filterColumn) ? tab.filterColumn : columns[0] ?? '';
  const value = el('input');
  value.setAttribute('aria-label', 'Filter value');
  value.placeholder = 'Exact value';
  value.value = tab.filterValue;
  const isNull = el('input');
  isNull.type = 'checkbox';
  isNull.checked = tab.filterNull;
  value.disabled = isNull.checked;
  isNull.addEventListener('change', () => { value.disabled = isNull.checked; });
  const nullLabel = el('label', 'check');
  nullLabel.append(isNull, document.createTextNode('Match NULL'));
  const apply = el('button', 'primary small', 'Apply');
  apply.type = 'submit';
  const clear = button('Clear', () => { handle.close(true); actions.applyFilter(tab, '', '', false); }, 'small');
  const buttons = el('div', 'filter-actions');
  buttons.append(clear, apply);
  form.append(label('Column', column), label('Equals', value), nullLabel, buttons);
  form.addEventListener('submit', (event) => { event.preventDefault(); handle.close(true); actions.applyFilter(tab, column.value, value.value, isNull.checked); });
  const handle = popover(anchor, form);
  column.focus();
}

// ---- toolbar (table tabs) -----------------------------------------------------------------------------------
export function renderToolbar(tab, root, blocked) {
  root.replaceChildren();
  const segmented = el('div', 'segmented');
  segmented.setAttribute('role', 'group');
  segmented.setAttribute('aria-label', 'View');
  for (const [view, text, iconName] of [['data', 'Data', 'table'], ['structure', 'Structure', 'list']]) {
    const node = el('button', `seg${tab.view === view ? ' active' : ''}`);
    node.type = 'button';
    node.setAttribute('aria-pressed', String(tab.view === view));
    node.disabled = blocked || (view === 'structure' && !capability(tab.profile, 'inspect'));
    node.append(icon(iconName), el('span', '', text));
    node.addEventListener('click', () => actions.setView(tab, view));
    segmented.append(node);
  }
  const filtered = Boolean(tab.filterColumn);
  const filter = el('button', `tool${filtered ? ' active' : ''}`);
  filter.type = 'button';
  filter.setAttribute('aria-haspopup', 'dialog');
  filter.setAttribute('aria-expanded', 'false');
  filter.disabled = blocked || tab.view !== 'data';
  filter.append(icon('filter'), el('span', '', filtered ? `Filter: ${tab.filterColumn} ${tab.filterNull ? 'is NULL' : `= ${tab.filterValue}`}` : 'Filter rows'));
  filter.addEventListener('click', () => openFilter(tab, filter));
  const refresh = el('button', 'tool icon-only');
  refresh.type = 'button';
  refresh.setAttribute('aria-label', 'Refresh rows');
  refresh.title = 'Refresh rows';
  refresh.disabled = blocked || tab.busy;
  refresh.append(icon('refresh'));
  refresh.addEventListener('click', () => actions.refreshTab(tab));
  const panel = el('button', `tool icon-only${inspectorVisible() ? ' active' : ''}`);
  panel.type = 'button';
  panel.setAttribute('aria-label', 'Show table details');
  panel.setAttribute('aria-pressed', String(inspectorVisible()));
  panel.title = 'Table details';
  panel.append(icon('panel'));
  panel.addEventListener('click', () => actions.toggleInspector());
  root.append(segmented, el('span', 'toolbar-sep'), filter, refresh, el('span', 'toolbar-spacer'), exportButton(tab), panel);
}

// ---- grid ---------------------------------------------------------------------------------------------------
function emptyMessage(tab) {
  const wrap = el('div', 'hint loading');
  if (tab.kind === 'table' && tab.filterColumn) wrap.append(document.createTextNode('No rows match this filter. '), button('Clear filter', () => actions.applyFilter(tab, '', '', false), 'small'));
  else wrap.textContent = 'No rows returned.';
  return wrap;
}

export function renderGridRegion(tab, root) {
  const previous = root.querySelector('.data-table-wrap');
  const scroll = previous ? [previous.scrollTop, previous.scrollLeft] : null;
  root.replaceChildren();
  root.classList.toggle('is-busy', tab.busy);
  if (tab.error) root.append(el('p', 'error', tab.error));
  const data = tab.data;
  if (!data) {
    if (tab.busy) root.append(el('p', 'hint loading', tab.kind === 'query' ? 'Running… Cancellation terminates the database request.' : 'Loading rows…'));
    else if (!tab.error) {
      // Restored tabs come back without data: restoring a location must not re-run anything by itself.
      const note = el('div', 'hint loading');
      note.append(document.createTextNode(tab.kind === 'query' ? 'Run the statement to see results.' : 'Rows are not loaded yet. '));
      if (tab.kind === 'table') note.append(button('Load rows', () => actions.refreshTab(tab), 'small'));
      root.append(note);
    }
    return;
  }
  if (!data.columns?.length) { root.append(el('p', 'hint', `Statement completed.${data.rowCount !== undefined ? ` Affected rows: ${data.rowCount}.` : ''}`)); return; }
  if (!data.rows?.length) { root.append(emptyMessage(tab)); return; }

  const meta = new Map((tab.metadata?.columns ?? []).map((column) => [column.name, column]));
  const { alignNumbers, statusPills } = settings.get();
  const numeric = new Set(alignNumbers ? data.columns.filter((name) => isNumericColumn(name, data.rows, meta.get(name))) : []);
  const pills = new Set(statusPills ? data.columns.filter((name) => isPillColumn(name, data.rows, meta.get(name))) : []);

  const wrap = el('div', 'data-table-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', 'Result rows; scroll horizontally for more columns');
  const table = el('table', 'data-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const name of data.columns) {
    const cell = el('th', numeric.has(name) ? 'num' : '');
    cell.scope = 'col';
    if (tab.kind === 'table') {
      const sorted = tab.sortColumn === name;
      const sort = el('button', 'sort-button');
      sort.type = 'button';
      sort.disabled = tab.busy;
      sort.title = `Sort by ${name}`;
      sort.append(document.createTextNode(name), el('span', 'sort-ind', sorted ? (tab.sortDirection === 'asc' ? '▲' : '▼') : '↕'));
      sort.lastChild.setAttribute('aria-hidden', 'true');
      sort.addEventListener('click', () => actions.sortBy(tab, name));
      cell.append(sort);
      if (sorted) cell.setAttribute('aria-sort', tab.sortDirection === 'asc' ? 'ascending' : 'descending');
    } else cell.textContent = name;
    const info = meta.get(name);
    if (info?.primaryKey || info?.foreignKey) {
      const keys = el('span', 'th-keys');
      keys.title = info.primaryKey ? 'Primary key' : 'Foreign key';
      keys.append(icon(info.primaryKey ? 'key' : 'link'));
      cell.append(keys);
    }
    headRow.append(cell);
  }
  head.append(headRow);
  const body = el('tbody');
  data.rows.forEach((record, index) => {
    const tr = el('tr', index === tab.selectedRow ? 'selected' : '');
    for (const name of data.columns) {
      const value = record[name];
      const text = cellText(value);
      const shown = text.length > 1000 ? text.slice(0, 1000) + '…' : text;
      const nullish = value === null || value === undefined;
      const cell = el('td', [numeric.has(name) ? 'num' : '', nullish ? 'null-cell' : ''].filter(Boolean).join(' '));
      if (!nullish && pills.has(name)) cell.append(el('span', `pill ${pillTone(value)}`, shown));
      else cell.textContent = shown;
      cell.title = text.length > 1000 ? 'Display truncated to 1,000 characters. Export loaded JSON for the full returned value.' : text;
      tr.append(cell);
    }
    tr.addEventListener('click', () => {
      tab.selectedRow = tab.selectedRow === index ? -1 : index;
      [...body.children].forEach((node, position) => node.classList.toggle('selected', position === tab.selectedRow));
    });
    body.append(tr);
  });
  table.append(head, body);
  wrap.append(table);
  root.append(wrap);
  if (scroll) { wrap.scrollTop = scroll[0]; wrap.scrollLeft = scroll[1]; }
}

// ---- footer: totals, numbered pages, page size --------------------------------------------------------------
export function renderFooter(tab, root, blocked) {
  root.replaceChildren();
  const data = tab.data;
  if (tab.kind === 'table' && tab.view !== 'data') return;
  if (!data) return;
  const truncated = data.truncatedValues ? ` · ${data.truncatedValues} values truncated` : '';
  if (tab.kind === 'query') {
    root.append(el('span', '', `${data.rows?.length ?? 0} rows${data.durationMs !== undefined ? ` · ${data.durationMs} ms` : ''}${data.hasMore ? ' · more rows available (add LIMIT or narrow the query)' : ''}${truncated}`));
    return;
  }
  const model = pageModel({ offset: tab.offset, limit: tab.limit, rowCount: data.rows?.length ?? 0, total: tab.total, hasMore: Boolean(data.hasMore) });
  const counting = tab.countBusy && !model.exact && model.to > 0;
  root.append(el('span', '', `${counting ? `Showing ${model.from}–${model.to} · counting rows…` : model.label}${truncated}`));

  const pager = el('nav', 'pager');
  pager.setAttribute('aria-label', 'Pagination');
  const lock = blocked || tab.busy;
  const prev = button('‹', () => actions.goToPage(tab, model.page - 1), '', lock || !model.hasPrev);
  prev.setAttribute('aria-label', 'Previous page');
  const next = button('›', () => actions.goToPage(tab, model.page + 1), '', lock || !model.hasNext);
  next.setAttribute('aria-label', 'Next page');
  pager.append(prev);
  for (const item of model.items) {
    if (item === '…') { pager.append(el('span', 'gap', '…')); continue; }
    const page = button(String(item), () => actions.goToPage(tab, item), '', lock);
    page.setAttribute('aria-label', `Page ${item}`);
    if (item === model.page) page.setAttribute('aria-current', 'page');
    pager.append(page);
  }
  pager.append(next, el('span', 'pager-sep'));
  const size = el('select');
  size.setAttribute('aria-label', 'Rows per page');
  for (const count of PAGE_SIZES) size.append(option(String(count), `${count} rows`));
  size.value = String(tab.limit);
  size.disabled = lock;
  size.addEventListener('change', () => actions.setPageSize(tab, Number(size.value)));
  pager.append(size);
  root.append(pager);
}
