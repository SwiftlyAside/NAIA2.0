import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch, isFreeTier, BatchValidationError } from '../server/lib/validate.mjs';

const job = (key, params = {}) => ({ key, prompt: 'p', negative: 'n', params: { seed: 1, width: 832, height: 1216, steps: 28, ...params } });

test('normalizes and warns on paid jobs', () => {
  const { batch, warnings } = validateBatch({ title: 't', jobs: [job('H1'), job('H2', { steps: 30 })] }, { maxJobs: 9 });
  assert.equal(batch.jobs.length, 2); assert.equal(batch.jobs[0].params.width, 832);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /^H2/);
  assert.equal(isFreeTier({ steps: 28, width: 1024, height: 1024 }), true);
  assert.equal(isFreeTier({ steps: 28, width: 1024, height: 1216 }), false);
});

test('rejects empty jobs, bad key, duplicate key, over limit, non-integer geometry, missing prompt', () => {
  const bad = [
    { title: 't', jobs: [] }, { title: 't', jobs: [job('../x')] }, { title: 't', jobs: [job('A'), job('A')] },
    { title: 't', jobs: Array.from({ length: 10 }, (_, i) => job(`J${i}`)) },
    { title: 't', jobs: [job('A', { width: 'big' })] }, { title: 't', jobs: [{ key: 'A', prompt: '', params: { width: 1, height: 1, steps: 1 } }] },
  ];
  for (const p of bad) assert.throws(() => validateBatch(p, { maxJobs: 9 }), BatchValidationError);
});
