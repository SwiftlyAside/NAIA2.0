import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchImages, safeTarget } from '../server/lib/images.mjs';
import { NaiaHttpError } from '../server/lib/client.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'naia-img-'));
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('safeTarget: numbered on collision, rejects escaping keys', () => {
  const dir = tmp();
  assert.equal(safeTarget(dir, 'A', '.png', fs), path.join(dir, 'A.png'));
  fs.writeFileSync(path.join(dir, 'A.png'), 'x');
  assert.equal(safeTarget(dir, 'A', '.png', fs), path.join(dir, 'A_2.png'));
  assert.equal(safeTarget(dir, 'calib/H1', '.png', fs), path.join(dir, 'calib', 'H1.png'));
  assert.throws(() => safeTarget(dir, '../x', '.png', fs), /out_dir/);
});

test('fetchImages: downloads done jobs, writes sidecars, falls back to file_path on 404, reports failures', async () => {
  const dir = tmp(); const src = path.join(tmp(), 'orig.png'); fs.writeFileSync(src, PNG);
  const batch = { batch_id: 'b1', jobs: [
    { key: 'A', status: 'done', history_id: 'h1', file_path: '', final: { prompt: 'p' }, verdict: { decision: 'accept' }, agent_review: null },
    { key: 'B', status: 'done', history_id: 'h2', file_path: src, final: null },
    { key: 'C', status: 'done', history_id: '', file_path: '', final: null },
    { key: 'D', status: 'failed', history_id: '', file_path: '' } ] };
  const client = { getBytes: async p => { if (p.endsWith('/h1')) return PNG; throw new NaiaHttpError(404, { error: 'History item not found' }, p); } };
  const r = await fetchImages({ client, fs, batch, outDir: dir, now: () => new Date('2026-09-06T10:00:00Z') });
  assert.deepEqual(r.saved.map(s => s.key), ['A', 'B']);
  assert.equal(fs.readFileSync(path.join(dir, 'A.png'))[0], 137);
  const side = JSON.parse(fs.readFileSync(path.join(dir, 'A.naia.json'), 'utf8'));
  assert.equal(side.history_id, 'h1'); assert.equal(side.verdict.decision, 'accept'); assert.equal(side.fetched_at, '2026-09-06T10:00:00.000Z');
  assert.equal(fs.readFileSync(path.join(dir, 'B.png')).equals(PNG), true);
  assert.deepEqual(r.failed.map(f => f.key), ['C']);
  const only = await fetchImages({ client, fs, batch, outDir: dir, keys: ['B'], now: () => new Date() });
  assert.deepEqual(only.saved.map(s => s.key), ['B']); assert.equal(path.basename(only.saved[0].path), 'B_2.png');
});

test('fetchImages rejects relative out_dir', async () => {
  await assert.rejects(fetchImages({ client: {}, fs, batch: { jobs: [] }, outDir: 'relative/dir', now: () => new Date() }), /절대경로/);
});
