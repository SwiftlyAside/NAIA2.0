// Agent Inbox — 화면에 쓰는 순수 계산(DOM 없음). node --test 대상.
export const FREE_MAX_STEPS = 28;
export const FREE_MAX_PIXELS = 1048576;
const LABELS = { pending: '대기', queued: '큐', generating: '생성 중', done: '완료', failed: '실패', skipped: '제외' };
const REVIEW_KEYS = [['safety', '안전'], ['style', '화풍'], ['text', '텍스트'], ['anatomy', '해부'], ['speckle', 'speckle'], ['resolution', '해상도']];

export function isFreeTierJob(params) {
  const steps = Number(params?.steps || 0);
  const px = Number(params?.width || 0) * Number(params?.height || 0);
  return steps <= FREE_MAX_STEPS && px <= FREE_MAX_PIXELS;
}

export function progressOf(batch) {
  const jobs = Array.isArray(batch?.jobs) ? batch.jobs : [];
  const p = { done: 0, failed: 0, skipped: 0, generating: 0, queued: 0, pending: 0, total: jobs.length, finished: 0 };
  for (const j of jobs) if (j.status in p) p[j.status] += 1;
  p.finished = p.done + p.failed + p.skipped;
  return p;
}

export function jobStatusLabel(status) { return LABELS[status] || String(status || ''); }

export function verdictClass(job) {
  const d = job?.verdict?.decision;
  return d === 'accept' ? 'accepted' : d === 'reject' ? 'rejected' : d === 'redo' ? 'redo' : '';
}

export function reviewChips(job) {
  const r = job?.agent_review || {};
  return REVIEW_KEYS.map(([key, label]) => ({ key, label, value: r[key] === 'pass' || r[key] === 'fail' ? r[key] : 'na' }));
}

export function costLine(batch, anlas) {
  const jobs = (batch?.jobs || []).filter(j => j.status === 'pending');
  const paid = jobs.filter(j => !isFreeTierJob(j.params)).length;
  let line = `${jobs.length}장 생성`;
  if (paid) line += ` · ${paid}장 과금(무료 조건 밖)`;
  if (anlas && anlas.available) line += ` · Anlas ${Number(anlas.anlas || 0)}`;
  return line;
}
