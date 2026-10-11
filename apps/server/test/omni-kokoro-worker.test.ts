import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { KokoroWorker, validateKokoroWav } from '../src/omni/kokoro-worker.js';

function wav(): Buffer {
  const b = Buffer.alloc(46);
  b.write('RIFF'); b.writeUInt32LE(38, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(2, 40); return b;
}
async function fixture(mode: string): Promise<{worker: KokoroWorker; cleanup: () => Promise<void>}> {
  const root = await mkdtemp(join(tmpdir(), 'kokoro-supervisor-'));
  const executable = join(root, 'worker');
  await writeFile(executable, `#!${process.execPath}\nconst readline = require('node:readline');
if (process.env.KOKORO_TEST_SECRET) process.exit(9);
if (${JSON.stringify(mode)} !== 'startup-hang') console.log(JSON.stringify({id:'',status:'ready',ready:true}));
if (${JSON.stringify(mode)} === 'ignore-term') process.on('SIGTERM', () => {});
readline.createInterface({input:process.stdin}).on('line', line => {
 const {id,text}=JSON.parse(line);
 if (['hang','ignore-term'].includes(${JSON.stringify(mode)})) return;
 if (${JSON.stringify(mode)}==='crash') return process.exit(3);
 if (${JSON.stringify(mode)}==='oversize') return process.stdout.write('x'.repeat(2000000));
 console.log(JSON.stringify({id:${mode === 'wrong-id' ? "'wrong'" : 'id'},status:'ok',wavBase64:${JSON.stringify(wav().toString('base64'))},sampleRate:24000,frames:1}));
});\n`);
  await chmod(executable, 0o700);
  const worker = new KokoroWorker({ executable, cache: root, startupMs: 500, renderMs: mode === 'ignore-term' ? 5000 : 500, restartMs: 1, idleMs: 2000 });
  return { worker, cleanup: async () => { await worker.close(); await rm(root, {recursive:true, force:true}); } };
}
async function ready(worker: KokoroWorker): Promise<void> {
  for (let n = 0; n < 100; n++) { if (await worker.available()) return; await delay(10); }
  assert.fail('fixture not ready');
}
test('WAV validation rejects noncanonical base64, frames and headers', () => {
  assert.deepEqual(validateKokoroWav(wav().toString('base64'), 1, 24000), wav());
  for (const [data,frames,rate] of [[wav().toString('base64')+'\n',1,24000], ['AAAA',1,24000], [wav().toString('base64'),720001,24000], [wav().toString('base64'),1,48000]]) {
    assert.throws(() => validateKokoroWav(data,frames,rate));
  }
});
test('warmup is nonblocking, secrets are excluded and valid WAV returned', async () => {
  process.env.KOKORO_TEST_SECRET = 'sensitive';
  const f = await fixture('ok');
  try { assert.equal(await f.worker.available(), false); await ready(f.worker); assert.deepEqual(await f.worker.synthesize('Hello'), wav()); }
  finally { delete process.env.KOKORO_TEST_SECRET; await f.cleanup(); }
});
test('cancellation kills worker before rejection and permits new warmup', async () => {
  const f = await fixture('hang');
  try {
    await ready(f.worker);
    const controller = new AbortController();
    const pending = f.worker.synthesize('Hello', controller.signal);
    await assert.rejects(f.worker.synthesize('Busy'), {code:'busy'});
    controller.abort();
    await assert.rejects(pending, {code:'aborted'});
    await ready(f.worker);
  } finally { await f.cleanup(); }
});
for (const mode of ['crash', 'oversize', 'wrong-id']) test(`rejects ${mode} and restarts safely`, async () => {
  const f = await fixture(mode);
  try { await ready(f.worker); await assert.rejects(f.worker.synthesize('Hello'), {code:'failed'}); await ready(f.worker); }
  finally { await f.cleanup(); }
});
test('invalid admin config and oversized input fail without process launch', async () => {
  const worker = new KokoroWorker({executable:'relative',cache:'/tmp'});
  assert.equal(await worker.available(), false);
  await assert.rejects(worker.synthesize('a'.repeat(161)), {code:'invalid_text'});
  await worker.close();
});

test('render timeout terminates a hung native process', async () => {
  const f = await fixture('hang');
  try { await ready(f.worker); await assert.rejects(f.worker.synthesize('Hello'), {code:'failed'}); await ready(f.worker); }
  finally { await f.cleanup(); }
});
test('startup timeout keeps unready process unavailable', async () => {
  const f = await fixture('startup-hang');
  try { assert.equal(await f.worker.available(), false); await delay(600); assert.equal(await f.worker.available(), false); }
  finally { await f.cleanup(); }
});
test('cancellation escalates when the native process ignores termination', async () => {
  const f = await fixture('ignore-term');
  try {
    await ready(f.worker);
    const controller = new AbortController();
    const pending = f.worker.synthesize('Hello', controller.signal);
    controller.abort();
    await assert.rejects(pending, {code:'aborted'});
    await ready(f.worker);
  } finally { await f.cleanup(); }
});
