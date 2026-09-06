import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULTS, mergeConfig } from '../server/lib/config.mjs';
import { launchNaia, waitReady, ensureRunning } from '../server/lib/launch.mjs';

const fakeSpawn = (calls) => (command, args, opts) => { calls.push({ command, args, opts }); return { pid: 4242, unref() { calls.push('unref'); } }; };
const clock = () => { let t = 0; return { now: () => t, sleep: async ms => { t += ms; } }; };

test('launchNaia spawns detached in naia_root/launch.cwd with merged env; exe path uses its own dir', () => {
  const calls = [];
  const cfg = mergeConfig(DEFAULTS, { naia_root: 'F:/ai/NAIA2.0', launch: { env: { REQUESTS_CA_BUNDLE: 'c.pem' } } });
  const r = launchNaia({ config: cfg, spawn: fakeSpawn(calls), platform: 'win32', env: { PATH: 'p' } });
  assert.equal(r.pid, 4242);
  assert.equal(calls[0].command, 'npm'); assert.deepEqual(calls[0].args, ['start']);
  assert.equal(calls[0].opts.cwd, path.join('F:/ai/NAIA2.0', 'app/electron'));
  assert.equal(calls[0].opts.detached, true); assert.equal(calls[0].opts.shell, true);
  assert.equal(calls[0].opts.env.REQUESTS_CA_BUNDLE, 'c.pem'); assert.equal(calls[0].opts.env.PATH, 'p');
  assert.equal(calls[1], 'unref');
  const calls2 = [];
  launchNaia({ config: mergeConfig(cfg, { launch: { command: 'F:/ai/NAIA-Portable/NAIA.exe', args: [] } }), spawn: fakeSpawn(calls2), platform: 'win32', env: {} });
  assert.equal(calls2[0].opts.cwd, 'F:/ai/NAIA-Portable'); assert.equal(calls2[0].opts.shell, false);
});

test('waitReady polls until status returns, reports elapsed; times out', async () => {
  let n = 0;
  const client = { status: async () => (++n >= 3 ? { api_mode: 'NAI' } : null) };
  const c = clock();
  const r = await waitReady({ client, timeoutSec: 10, pollSec: 2, sleep: c.sleep, now: c.now });
  assert.deepEqual(r, { reachable: true, elapsed_sec: 4 });
  const c2 = clock();
  const r2 = await waitReady({ client: { status: async () => null }, timeoutSec: 5, pollSec: 2, sleep: c2.sleep, now: c2.now });
  assert.equal(r2.reachable, false); assert.equal(r2.elapsed_sec >= 5, true);
});

test('ensureRunning: no-op when reachable, launches otherwise', async () => {
  const up = await ensureRunning({ client: { status: async () => ({}) }, config: DEFAULTS, spawn: () => { throw new Error('must not spawn'); }, sleep: async () => {}, now: () => 0 });
  assert.deepEqual(up, { launched: false, reachable: true, elapsed_sec: 0 });
  const calls = []; let n = 0; const c = clock();
  const down = await ensureRunning({ client: { status: async () => (++n >= 2 ? {} : null) }, config: DEFAULTS, spawn: fakeSpawn(calls), sleep: c.sleep, now: c.now, platform: 'win32', env: {} });
  assert.equal(down.launched, true); assert.equal(down.reachable, true); assert.equal(down.pid, 4242);
});
