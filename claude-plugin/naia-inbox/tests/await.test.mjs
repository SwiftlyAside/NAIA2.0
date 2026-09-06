import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitBatch, isSatisfied, summarize } from '../server/lib/await.mjs';
import { NaiaUnreachableError } from '../server/lib/client.mjs';

const b = (status, jobs) => ({ batch_id: 'b1', title: 'T', status, jobs: jobs.map(([key, s, v]) => ({ key, status: s, verdict: v ? { decision: v } : null })) });
const seqClient = (seq) => { let i = 0; return { getJson: async () => { const v = seq[Math.min(i++, seq.length - 1)]; if (v instanceof Error) throw v; return v; } }; };
const clock = () => { let t = 0; return { now: () => t, sleep: async ms => { t += ms; } }; };

test('isSatisfied: done vs verdicts', () => {
  assert.equal(isSatisfied(b('generating', [['A', 'done']]), 'done'), false);
  assert.equal(isSatisfied(b('done', [['A', 'done']]), 'done'), true);
  assert.equal(isSatisfied(b('cancelled', [['A', 'skipped']]), 'done'), true);
  assert.equal(isSatisfied(b('done', [['A', 'done'], ['B', 'failed']]), 'verdicts'), false);
  assert.equal(isSatisfied(b('done', [['A', 'done', 'accept'], ['B', 'failed']]), 'verdicts'), true);
});

test('awaitBatch polls, emits progress only on change, returns final batch', async () => {
  const seq = [b('pending', [['A', 'pending'], ['B', 'pending']]), b('approved', [['A', 'queued'], ['B', 'queued']]), b('generating', [['A', 'generating'], ['B', 'queued']]),
    b('generating', [['A', 'generating'], ['B', 'queued']]), b('generating', [['A', 'done'], ['B', 'generating']]), b('done', [['A', 'done'], ['B', 'done']])];
  const c = clock(); const prog = [];
  const r = await awaitBatch({ client: seqClient(seq), batchId: 'b1', until: 'done', maxWaitSec: 60, pollSec: 2, sleep: c.sleep, now: c.now, progress: (p, t, m) => prog.push([p, t, m]) });
  assert.equal(r.status, 'done'); assert.equal(r.batch.status, 'done');
  assert.equal(prog.length, 5); // 6 폴링 중 동일 스냅샷 1회는 알림 없음
  assert.deepEqual(prog.at(-1).slice(0, 2), [2, 2]); assert.match(prog.at(-1)[2], /A done · B done/);
});

test('awaitBatch times out with snapshot; unreachable propagates', async () => {
  const c = clock();
  const r = await awaitBatch({ client: seqClient([b('approved', [['A', 'queued']])]), batchId: 'b1', until: 'done', maxWaitSec: 5, pollSec: 2, sleep: c.sleep, now: c.now, progress: () => {} });
  assert.equal(r.status, 'timeout'); assert.equal(r.batch.status, 'approved');
  await assert.rejects(awaitBatch({ client: seqClient([new NaiaUnreachableError('down')]), batchId: 'b1', until: 'done', maxWaitSec: 5, pollSec: 1, sleep: c.sleep, now: c.now, progress: () => {} }), NaiaUnreachableError);
});

test('summarize lists key:status compactly', () => {
  assert.equal(summarize(b('generating', [['A', 'done'], ['B', 'generating']])), 'A done · B generating');
});
