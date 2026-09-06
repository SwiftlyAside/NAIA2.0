import test from 'node:test';
import assert from 'node:assert/strict';
import {
  progressOf, jobStatusLabel, verdictClass, reviewChips, costLine, isFreeTierJob,
} from '../../../app/web/remote/js/features/agentInboxModel.mjs';

const job = (status, extra = {}) => ({ job_id: status, key: 'E1', status, params: { seed: 1, width: 832, height: 1216, steps: 28 }, ...extra });

test('progressOf counts and finished', () => {
  const p = progressOf({ jobs: [job('done'), job('failed'), job('queued'), job('generating'), job('pending'), job('skipped')] });
  assert.deepEqual(p, { done: 1, failed: 1, skipped: 1, generating: 1, queued: 1, pending: 1, total: 6, finished: 3 });
});

test('jobStatusLabel maps every status', () => {
  for (const s of ['pending', 'queued', 'generating', 'done', 'failed', 'skipped']) assert.equal(typeof jobStatusLabel(s), 'string');
  assert.equal(jobStatusLabel('bogus'), 'bogus');
});

test('verdictClass', () => {
  assert.equal(verdictClass(job('done')), '');
  assert.equal(verdictClass(job('done', { verdict: { decision: 'accept' } })), 'accepted');
  assert.equal(verdictClass(job('done', { verdict: { decision: 'redo' } })), 'redo');
});

test('reviewChips fills six keys with na default', () => {
  const chips = reviewChips(job('done', { agent_review: { safety: 'pass', style: 'fail' } }));
  assert.equal(chips.length, 6);
  assert.deepEqual(chips.slice(0, 2).map(c => c.value), ['pass', 'fail']);
  assert.equal(chips[5].value, 'na');
});

test('costLine and free tier', () => {
  assert.equal(isFreeTierJob({ steps: 28, width: 832, height: 1216 }), true);
  assert.equal(isFreeTierJob({ steps: 29, width: 832, height: 1216 }), false);
  const b = { jobs: [job('pending'), job('pending', { params: { steps: 30, width: 832, height: 1216 } })] };
  assert.match(costLine(b, { available: true, anlas: 100 }), /2장/);
  assert.match(costLine(b, { available: true, anlas: 100 }), /1장 과금/);
  assert.match(costLine(b, { available: true, anlas: 100 }), /Anlas 100/);
  assert.doesNotMatch(costLine({ jobs: [job('pending')] }, null), /과금/);
});
