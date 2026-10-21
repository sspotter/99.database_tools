import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnectionStore, normalizeConnectionInput, redactError } from '../lib/connections.js';
async function temporary(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'db-profiles-')); t.after(() => rm(directory, {recursive:true,force:true})); return directory; }
const serverProfile = { name:'Fixture', engine:'postgres', credentialMode:'session', settings:{host:'localhost',user:'tester',database:'fixture',password:'fake-secret-123'} };

test('normalizes URL credentials and SSL without retaining the URL', () => {
  assert.equal(typeof normalizeConnectionInput, 'function');
  const profile = normalizeConnectionInput({name:'Fixture',url:'postgresql://alice:p%40ss@localhost:5433/demo?sslmode=verify-full',credentialMode:'session'});
  assert.equal(profile.engine,'postgres'); assert.equal(profile.settings.password,'p@ss'); assert.equal(profile.settings.port,5433); assert.equal(profile.settings.sslMode,'verify-full'); assert.equal(profile.url,undefined);
  assert.equal(normalizeConnectionInput({name:'File',engine:'sqlite',settings:{file:'fixture.db'}},{cwd:'C:/fixtures'}).settings.file,path.resolve('C:/fixtures','fixture.db'));
});
test('rejects ambiguous URLs, unsupported options and bounded malformed fields without echoing secrets', () => {
  assert.equal(typeof normalizeConnectionInput, 'function');
  for (const input of [
    {url:'http://user:secret@localhost/db'}, {url:'postgres://u:secret@localhost/db?application_name=x'},
    {url:'postgres://u:secret@localhost/db?sslmode=require&sslmode=disable'},
    {engine:'mysql',settings:{host:'a/b',database:'db'}}, {engine:'mysql',settings:{host:'localhost',port:0}},
    {engine:'mysql',settings:{host:'localhost',sslMode:'insecure'}}, {engine:'sqlite',settings:{file:''}},
    {engine:'mysql',name:'x'.repeat(201),settings:{host:'localhost'}}
  ]) assert.throws(() => normalizeConnectionInput({name:'Fixture',...input}), error => !error.message.includes('secret'));
});
test('persists public metadata, protects revision edits and deletion', async t => {
  assert.equal(typeof createConnectionStore,'function'); const directory=await temporary(t); const store=await createConnectionStore({directory});
  const first=await store.save(serverProfile); assert.equal(first.revision,1); assert.equal(first.settings.password,undefined); assert.equal(first.credentialStatus,'ready');
  assert.equal((await store.get(first.id,{includeSecrets:true})).settings.password,'fake-secret-123');
  const disk=await readFile(path.join(directory,'connections.json'),'utf8'); assert.ok(!disk.includes('fake-secret-123')); assert.ok(!disk.includes('postgres://'));
  const changed=await store.save({id:first.id,revision:1,name:'Renamed'}); assert.equal(changed.revision,2); assert.equal((await store.get(first.id,{includeSecrets:true})).settings.password,'fake-secret-123');
  await assert.rejects(store.save({id:first.id,revision:1,name:'Stale'}), /changed|revision/i); await assert.rejects(store.remove(first.id,1), /changed|revision/i);
  await store.remove(first.id,2); assert.deepEqual(await store.list(),[]); await assert.rejects(store.get(first.id), /not found/i);
});
test('clears session credentials without changing revision and never resurrects them on restart', async t => {
  assert.equal(typeof createConnectionStore,'function'); const directory=await temporary(t); const store=await createConnectionStore({directory}); const profile=await store.save(serverProfile);
  await store.clearSessionSecrets(profile.id); const cleared=await store.get(profile.id); assert.equal(cleared.revision,1); assert.equal(cleared.credentialStatus,'required');
  await assert.rejects(store.get(profile.id,{includeSecrets:true}), /credentials/i);
  const reopened=await createConnectionStore({directory}); assert.equal((await reopened.get(profile.id)).credentialStatus,'required');
});
test('encrypts saved credentials with Windows DPAPI and fails closed on corruption', {skip:process.platform!=='win32'}, async t => {
  assert.equal(typeof createConnectionStore,'function'); const directory=await temporary(t); let store=await createConnectionStore({directory}); const profile=await store.save({...serverProfile,credentialMode:'saved'});
  const entries=await readdir(directory); for(const entry of entries) assert.ok(!(await readFile(path.join(directory,entry),'utf8')).includes('fake-secret-123'));
  store=await createConnectionStore({directory}); assert.equal((await store.get(profile.id,{includeSecrets:true})).settings.password,'fake-secret-123');
  const secret=entries.find(entry=>entry.endsWith('.dpapi')); assert.ok(secret); await writeFile(path.join(directory,secret),'broken');
  assert.equal((await store.get(profile.id)).credentialStatus,'unavailable'); await assert.rejects(store.get(profile.id,{includeSecrets:true}), /credentials/i);
  assert.equal((await store.save({id:profile.id,revision:1,name:'Still present'})).name,'Still present');
});
test('serializes concurrent edits so stale revisions cannot overwrite newer settings', async t => {
  assert.equal(typeof createConnectionStore,'function'); const directory=await temporary(t); const first=await createConnectionStore({directory}); const second=await createConnectionStore({directory}); const profile=await first.save({name:'File',engine:'sqlite',settings:{file:'fixture.db'}});
  const results=await Promise.allSettled([first.save({id:profile.id,revision:1,name:'A'}),second.save({id:profile.id,revision:1,name:'B'})]); assert.equal(results.filter(result=>result.status==='fulfilled').length,1); assert.equal((await first.get(profile.id)).revision,2);
});
test('redacts arbitrary errors fail closed, including edited passwords and nested URLs', () => {
  assert.equal(typeof redactError,'function'); for(const value of [new Error('password=fake-secret-123 postgres://u:other@host/db'),new Error('Login failed for fake-secret-123'),{message:'arbitrary private user data',code:'ECONNREFUSED'}]) { const text=redactError(value); assert.equal(typeof text,'string'); assert.ok(!/fake-secret|other|private user data/.test(text)); }
});

test('rejects nondecimal ports rather than coercing input', () => {
  for (const port of [true, [], {}, '0x1538', '5e3']) assert.throws(() => normalizeConnectionInput({...serverProfile,settings:{...serverProfile.settings,port}}));
});
test('rejects tampered metadata instead of returning unknown plaintext fields', async t => {
  const directory=await temporary(t); const store=await createConnectionStore({directory}); const profile=await store.save(serverProfile);
  const filename=path.join(directory,'connections.json'); const document=JSON.parse(await readFile(filename,'utf8')); document.profiles[0].password='leaked-top-level'; await writeFile(filename,JSON.stringify(document));
  await assert.rejects(store.list(), /metadata/i);
});
test('replaces and explicitly forgets credentials without exposing them publicly', async t => {
  const directory=await temporary(t); const store=await createConnectionStore({directory}); const profile=await store.save(serverProfile);
  const edited=await store.save({id:profile.id,revision:1,settings:{password:'replacement'}}); assert.equal((await store.get(profile.id,{includeSecrets:true})).settings.password,'replacement'); assert.ok(!JSON.stringify(edited).includes('replacement'));
  await store.save({id:profile.id,revision:2,settings:{password:''}}); await assert.rejects(store.get(profile.id,{includeSecrets:true}), /credentials/i);
});


test('resolves certificate paths against the profile working directory', () => {
  const profile=normalizeConnectionInput({...serverProfile,settings:{...serverProfile.settings,sslCa:'certs/root.pem'}},{cwd:'C:/fixtures'});
  assert.equal(profile.settings.sslCa,path.resolve('C:/fixtures','certs/root.pem'));
});

test('an oversized save preserves the previous readable connection library', async t => {
  const directory = await temporary(t);
  const store = await createConnectionStore({ directory });
  await store.save({ ...serverProfile, credentialMode: 'none', settings: {
    ...serverProfile.settings, sslCa: path.resolve('C:/fixtures', 'a'.repeat(4000))
  } });
  const filename = path.join(directory, 'connections.json');
  const document = JSON.parse(await readFile(filename, 'utf8'));
  const template = document.profiles[0];
  const maximum = 2 * 1024 * 1024;
  const copies = Array.from({ length: 1000 }, () => ({ ...template, id: crypto.randomUUID() }));
  let low = 1;
  let high = 1000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const size = Buffer.byteLength(JSON.stringify({ version: 1, profiles: copies.slice(0, middle) }, null, 2));
    if (size <= maximum) low = middle; else high = middle - 1;
  }
  document.profiles = copies.slice(0, low);
  const previous = JSON.stringify(document, null, 2);
  await writeFile(filename, previous);
  await assert.rejects(store.save({ ...serverProfile, credentialMode: 'none', settings: template.settings }), /limit|large|size/i);
  assert.equal(await readFile(filename, 'utf8'), previous);
  assert.equal((await store.list()).length, low);
});

test('disconnecting an old revision never clears replacement session credentials', async t => {
  const directory = await temporary(t);
  const store = await createConnectionStore({ directory });
  const original = await store.save(serverProfile);
  const updated = await store.save({ id: original.id, revision: original.revision, settings: { password: 'new-session-secret' } });
  await store.clearSessionSecrets(original.id, original.revision);
  assert.equal((await store.get(updated.id, { includeSecrets: true })).settings.password, 'new-session-secret');
  await store.clearSessionSecrets(updated.id, updated.revision);
  assert.equal((await store.get(updated.id)).credentialStatus, 'required');
});

test('a killed lock holder releases profile mutations without manual recovery', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-profile-lock-'));
  const store = await createConnectionStore({ directory });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const lock = new DatabaseSync(process.argv[1]);
    lock.exec('BEGIN EXCLUSIVE');
    process.send('locked');
    setInterval(() => {}, 1000);
  `, path.join(directory, 'connections-lock.sqlite')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; await rm(directory, { recursive: true, force: true }); });
  const ready = await Promise.race([
    once(child, 'message'),
    exited.then(() => { throw new Error('Lock holder exited before acquiring its lock.'); }),
  ]);
  assert.deepEqual(ready, ['locked', undefined]);
  await assert.rejects(store.save(serverProfile), { code: 'REVISION_CONFLICT' });
  child.kill();
  await exited;
  const saved = await store.save(serverProfile);
  assert.equal((await store.get(saved.id)).name, serverProfile.name);
});
