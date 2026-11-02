import { $, option, api, state, bus, actions, notice, log, fail, selected, endpoint } from './core.js';
import { initShell, showView } from './shell.js';
import { initNav, syncProfiles, activateConnection } from './nav.js';
import { initTree } from './tree.js';
import { initHeader } from './header.js';
import { initTabs, renderTabs, renderTab, invalidateTabs, restoreTabLocations } from './tabs.js';
import { initSearch } from './search.js';

const form = $('connectionForm');
const fields = form.elements;

async function refreshProfiles() {
  const version = ++state.profilesVersion;
  try {
    const data = await api('/api/connections');
    if (version !== state.profilesVersion) return;
    state.profiles = data.profiles || [];
    state.capabilities = data.capabilities || {};
    state.persistence = data.credentialPersistence;
    state.connected = new Set(state.profiles.filter((profile) => profile.connected).map((profile) => profile.id));
    state.serverInfo = Object.fromEntries(state.profiles.filter((profile) => profile.serverInfo).map((profile) => [profile.id, profile.serverInfo]));
    restoreTabLocations();
    fields.credentialMode.querySelector('[value="saved"]').disabled = data.credentialPersistence !== 'windows-dpapi';
    if (state.selectedId && !selected()) state.selectedId = null;
    syncProfiles();
    invalidateTabs();
    bus.emit('profiles');
  } catch (error) { if (version === state.profilesVersion) fail(error, 'Could not load connections'); }
}
async function toggleConnection(profile) {
  if (state.pendingConnections.has(profile.id)) return;
  const disconnect = state.connected.has(profile.id);
  state.pendingConnections.add(profile.id);
  bus.emit('tree'); bus.emit('target');
  notice(`${disconnect ? 'Disconnecting' : 'Connecting'} ${profile.name}…`);
  try {
    const result = await api(endpoint(profile, disconnect ? 'disconnect' : 'connect'), { revision: profile.revision });
    if (disconnect) {
      state.connected.delete(profile.id);
      delete state.serverInfo[profile.id];
      invalidateTabs();
      syncProfiles();
      notice('Disconnected. Session-only credentials were cleared.');
    } else {
      state.connected.add(profile.id);
      if (result.serverInfo) state.serverInfo[profile.id] = result.serverInfo;
      showView('workspace');
      await activateConnection(profile, result.databases);
      notice(result.discoveryError || `Connected to ${profile.name}.`);
    }
    log(`${disconnect ? 'Disconnected from' : 'Connected to'} ${profile.name}.`);
  } catch (error) { fail(error, disconnect ? 'Disconnect failed' : 'Connection failed'); }
  finally { state.pendingConnections.delete(profile.id); renderTabs(); renderTab(); bus.emit('profiles'); bus.emit('tree'); bus.emit('target'); }
}
async function favorite(profile) {
  try { await api('/api/connections', { ...profile, favorite: !profile.favorite }); await refreshProfiles(); }
  catch (error) { fail(error, 'Could not update favorite'); }
}
async function deleteConnection(profile) {
  if (!confirm(`Delete "${profile.name}"? Its open tabs will be disabled. The database itself will not be deleted.`)) return;
  try {
    await api(`/api/connections/${encodeURIComponent(profile.id)}`, { revision: profile.revision }, 'DELETE');
    await refreshProfiles(); notice('Connection removed.'); log('Removed a connection profile.');
  } catch (error) { fail(error, 'Could not delete connection'); }
}
function openConnection(profile = null, duplicate = false) {
  form.reset();
  fields.credentialMode.value = state.persistence === 'windows-dpapi' ? 'saved' : 'session';
  state.editing = duplicate ? null : profile;
  $('connectionTitle').textContent = profile ? (duplicate ? 'Duplicate connection' : 'Edit connection') : 'Add connection';
  $('formMessage').textContent = duplicate ? 'The copy has no password. Enter credentials explicitly if it needs them.' : '';
  $('formMessage').className = '';
  for (const name of ['name', 'group', 'engine', 'environment', 'credentialMode']) {
    if (profile?.[name] !== undefined) fields[name].value = profile[name];
  }
  if (profile) {
    for (const name of ['host', 'port', 'user', 'database', 'file', 'sslMode', 'sslCa']) fields[name].value = profile.settings?.[name] ?? (name === 'sslMode' ? 'verify-full' : '');
    fields.readOnly.checked = profile.readOnly;
    fields.favorite.checked = profile.favorite;
  }
  if (profile && ![...fields.environment.options].some((entry) => entry.value === profile.environment)) {
    fields.environment.append(option(profile.environment)); fields.environment.value = profile.environment;
  }
  if (duplicate) { fields.name.value += ' copy'; fields.credentialMode.value = 'session'; fields.favorite.checked = false; }
  fields.password.type = 'password';
  $('showPassword').textContent = 'Show'; $('showPassword').setAttribute('aria-pressed', 'false');
  $('passwordStatus').textContent = state.editing ? `(${profile.credentialStatus || 'unknown'})` : '';
  syncConnectionForm();
  $('connectionDialog').showModal();
}
function syncConnectionForm() {
  const sqlite = fields.engine.value === 'sqlite';
  const url = fields.entryMode.value === 'url' && !sqlite;
  $('entryModeLabel').hidden = sqlite;
  $('urlFields').hidden = !url;
  $('sqliteFields').hidden = !sqlite;
  $('serverFields').hidden = sqlite || url;
  $('credentialFields').hidden = sqlite;
  $('passwordActionLabel').hidden = !state.editing || url;
  fields.password.disabled = !!state.editing && fields.passwordAction.value !== 'replace';
  if (fields.credentialMode.value === 'saved' && state.persistence !== 'windows-dpapi') fields.credentialMode.value = 'session';
}
function connectionInput() {
  const input = { ...(state.editing ? { id: state.editing.id, revision: state.editing.revision } : {}), name: fields.name.value.trim(), engine: fields.engine.value, group: fields.group.value.trim(), environment: fields.environment.value, favorite: fields.favorite.checked, readOnly: fields.readOnly.checked, credentialMode: fields.engine.value === 'sqlite' ? 'none' : fields.credentialMode.value };
  if (fields.entryMode.value === 'url' && input.engine !== 'sqlite') input.url = fields.url.value.trim();
  else if (input.engine === 'sqlite') input.settings = { file: fields.file.value.trim() };
  else {
    input.settings = {};
    for (const name of ['host', 'port', 'database', 'user', 'sslMode', 'sslCa']) if (fields[name].value) input.settings[name] = name === 'port' ? Number(fields[name].value) : fields[name].value.trim();
    if (!state.editing || fields.passwordAction.value === 'replace') input.settings.password = fields.password.value;
    if (state.editing && fields.passwordAction.value === 'clear') input.settings.password = '';
  }
  return input;
}
async function submitConnection(test) {
  if (!form.reportValidity()) return;
  const controls = [form.querySelector('[type="submit"]'), $('testConnection')];
  controls.forEach((control) => { control.disabled = true; });
  $('formMessage').className = '';
  $('formMessage').textContent = test ? 'Testing connection…' : 'Saving connection…';
  try {
    const input = connectionInput();
    await api(test ? '/api/connections/test' : '/api/connections', test ? { profile: input } : input);
    if (test) $('formMessage').textContent = 'Connection test succeeded. You can save this profile.';
    else {
      $('connectionDialog').close();
      fields.password.value = ''; fields.url.value = '';
      await refreshProfiles();
      notice('Connection saved. Choose Connect when ready.');
      log('Saved a connection profile.');
    }
  } catch (error) {
    $('formMessage').textContent = error.message;
    $('formMessage').className = 'error';
    // Form errors intentionally stay out of logs: unsaved values can include secrets.
  } finally { controls.forEach((control) => { control.disabled = false; }); }
}
$('closeConnection').addEventListener('click', () => $('connectionDialog').close());
$('connectionDialog').addEventListener('close', () => { fields.password.value = ''; fields.url.value = ''; });
$('clearLogs').addEventListener('click', () => { $('logConsole').replaceChildren(); state.errors = 0; $('errorCount').textContent = ''; });
for (const name of ['engine', 'entryMode', 'credentialMode', 'passwordAction']) fields[name].addEventListener('change', syncConnectionForm);
$('showPassword').addEventListener('click', () => { const show = fields.password.type === 'password'; fields.password.type = show ? 'text' : 'password'; $('showPassword').textContent = show ? 'Hide' : 'Show'; $('showPassword').setAttribute('aria-pressed', String(show)); });
$('testConnection').addEventListener('click', () => submitConnection(true));
form.addEventListener('submit', (event) => { event.preventDefault(); submitConnection(false); });
$('addConnection').addEventListener('click', () => openConnection());
$('addConnectionSmall').addEventListener('click', () => openConnection());
actions.refreshProfiles = refreshProfiles;
actions.openConnection = openConnection;
actions.toggleConnection = toggleConnection;
actions.favorite = favorite;
actions.deleteConnection = deleteConnection;
actions.importCurrent = async () => {
  if (!confirm('Add the project’s current configuration as a saved connection? This explicitly reads its configuration. It will not connect automatically.')) return;
  try { await api('/api/connections/import-current', {}); await refreshProfiles(); notice('Current configuration added. Select it and choose Connect when ready.'); }
  catch (error) { fail(error, 'Configuration import failed'); }
};
initShell(); initNav(); initTabs(); initTree(); initHeader(); initSearch();
renderTabs(); renderTab(); refreshProfiles();
