// 배치 완료·판정 대기 — 폴링 + 변화 시에만 진행 알림. 승인은 사용자 클릭이라 여기서는 기다릴 뿐이다.
const TERMINAL = new Set(['done', 'cancelled', 'rejected']);

export function summarize(batch) { return (batch.jobs || []).map(j => `${j.key} ${j.status}`).join(' · '); }

export function isSatisfied(batch, until) {
  if (!TERMINAL.has(batch.status)) return false;
  if (until !== 'verdicts') return true;
  return (batch.jobs || []).filter(j => j.status === 'done').every(j => j.verdict && j.verdict.decision);
}

export async function awaitBatch({ client, batchId, until = 'done', maxWaitSec = 86400, pollSec = 2, sleep, now = Date.now, progress = () => {} }) {
  const start = now(); let lastSig = '';
  for (;;) {
    const batch = await client.getJson(`/api/agent-inbox/batches/${encodeURIComponent(batchId)}`);
    const jobs = batch.jobs || [];
    const finished = jobs.filter(j => ['done', 'failed', 'skipped'].includes(j.status)).length;
    const verdicts = jobs.filter(j => j.verdict?.decision).length;
    const sig = `${batch.status}|${summarize(batch)}|${verdicts}`;
    if (sig !== lastSig) { lastSig = sig; progress(finished, jobs.length, `${batch.status}: ${summarize(batch)}${until === 'verdicts' ? ` · 판정 ${verdicts}` : ''}`); }
    if (isSatisfied(batch, until)) return { status: 'done', batch };
    if (now() - start >= maxWaitSec * 1000) return { status: 'timeout', batch };
    await sleep(pollSec * 1000);
  }
}
