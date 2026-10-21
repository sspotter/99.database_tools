import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dbtk process '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { runProcess } = await import('../lib/process-runner.js');
  return { directory, runProcess, outputFile: path.join(directory, 'dump with spaces.sql') };
}

test('large native output streams completely and keeps the event loop responsive', async (t) => {
  const { directory, runProcess, outputFile } = await fixture(t);
  let responsive = false;
  setImmediate(() => { responsive = true; });
  await runProcess(process.execPath, ['-e', 'const b=Buffer.alloc(1024*1024,97); for(let i=0;i<61;i++)require("fs").writeSync(1,b)'], { outputFile });
  assert.equal((await fs.stat(outputFile)).size, 61 * 1024 * 1024);
  assert.equal(responsive, true);
  assert.deepEqual(await fs.readdir(directory), [path.basename(outputFile)]);
});

for (const [scenario, script, options, expected] of [
  ['nonzero exit', 'process.stdout.write("partial");process.stderr.write(process.env.PGPASSWORD);process.exit(7)', {}, /exit code 7/],
  ['timeout', 'setInterval(()=>{},1000)', { timeoutMs: 100 }, /timed out/],
  ['bounded stderr', 'process.stderr.write("x".repeat(200000)+process.env.PGPASSWORD);process.exit(2)', {}, /exit code 2/],
]) {
  test(`${scenario} rejects and removes only its partial output`, async (t) => {
    const { directory, runProcess, outputFile } = await fixture(t);
    const unrelated = path.join(directory, 'keep.partial');
    await fs.writeFile(unrelated, 'keep');
    await assert.rejects(runProcess(process.execPath, ['-e', script], {
      outputFile, env: { ...process.env, PGPASSWORD: 'secret-sentinel' }, ...options,
    }), (error) => {
      assert.match(error.message, expected);
      assert.equal(error.message.includes('secret-sentinel'), false);
      assert.ok(error.message.length < 66000);
      return true;
    });
    assert.deepEqual(await fs.readdir(directory), ['keep.partial']);
  });
}

test('missing binary fails without publishing output', async (t) => {
  const { directory, runProcess, outputFile } = await fixture(t);
  await assert.rejects(runProcess('dbtk-missing-binary-sentinel', [], { outputFile }), /ENOENT/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('existing destinations and concurrent publication never overwrite bytes', async (t) => {
  const { runProcess, outputFile } = await fixture(t);
  const child = ['-e', 'process.stdout.write("new")'];
  const outcomes = await Promise.allSettled([runProcess(process.execPath, child, { outputFile }), runProcess(process.execPath, child, { outputFile })]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  await fs.writeFile(outputFile, 'original');
  await assert.rejects(runProcess(process.execPath, child, { outputFile }));
  assert.equal(await fs.readFile(outputFile, 'utf8'), 'original');
});

test('stdin streams bytes and missing input does not publish a backup', async (t) => {
  const { directory, runProcess, outputFile } = await fixture(t);
  const inputFile = path.join(directory, 'input.sql');
  await fs.writeFile(inputFile, 'null\tquote\'\nmultiline\n');
  await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { inputFile, outputFile });
  assert.equal(await fs.readFile(outputFile, 'utf8'), await fs.readFile(inputFile, 'utf8'));
  await fs.unlink(outputFile);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { inputFile: inputFile + '.missing', outputFile }));
  assert.deepEqual(await fs.readdir(directory), ['input.sql']);
});

test('abort terminates a running child and cleans the stage', async (t) => {
  const { directory, runProcess, outputFile } = await fixture(t);
  const controller = new AbortController();
  const operation = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { outputFile, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(operation, /aborted/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('destination created while dumping remains intact after publication failure', async (t) => {
  const { directory, runProcess, outputFile } = await fixture(t);
  const operation = runProcess(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("dump"),200)'], { outputFile });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.writeFile(outputFile, 'new owner', { flag: 'wx' });
  await assert.rejects(operation, /EEXIST/);
  assert.equal(await fs.readFile(outputFile, 'utf8'), 'new owner');
  assert.deepEqual(await fs.readdir(directory), [path.basename(outputFile)]);
});

test('unwritable output path preserves an existing parent file', async (t) => {
  const { directory, runProcess } = await fixture(t);
  const parentFile = path.join(directory, 'keep');
  await fs.writeFile(parentFile, 'existing bytes');
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("dump")'], { outputFile: path.join(parentFile, 'backup.sql') }));
  assert.equal(await fs.readFile(parentFile, 'utf8'), 'existing bytes');
  assert.deepEqual(await fs.readdir(directory), ['keep']);
});

test('diagnostics redact URI credentials, explicit secrets, and a secret split at capture limit', async (t) => {
  const { runProcess } = await fixture(t);
  const script = 'process.stderr.write("postgres://u:uri-password@localhost/db explicit-secret " + "x".repeat(65536-56) + "secret-sentinel");process.exit(1)';
  await assert.rejects(runProcess(process.execPath, ['-e', script], {
    env: { ...process.env, PGPASSWORD: 'secret-sentinel' }, redact: ['explicit-secret'],
  }), (error) => {
    assert.equal(error.message.includes('uri-password'), false);
    assert.equal(error.message.includes('explicit-secret'), false);
    assert.equal(error.message.includes('secret-sentinel'), false);
    assert.match(error.message, /REDACTED/);
    return true;
  });
});

test('multibyte credentials split across stderr chunks remain redacted', async (t) => {
  const { runProcess } = await fixture(t);
  const script = 'const b=Buffer.from(process.env.PGPASSWORD);require("fs").writeSync(2,b.subarray(0,2));setTimeout(()=>{require("fs").writeSync(2,b.subarray(2));process.exit(1)},50)';
  await assert.rejects(runProcess(process.execPath, ['-e', script], { env: { ...process.env, PGPASSWORD: 'sëcret🙂sentinel' } }), (error) => {
    assert.equal(error.message.includes('sentinel'), false);
    assert.match(error.message, /REDACTED/);
    return true;
  });
});
