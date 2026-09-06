// 1/3 스펙 §4.1 과 같은 규칙을 제출 전에 로컬에서 적용한다(서버가 400 을 내기 전에 원인을 바로 말해 주기 위해).
export class BatchValidationError extends Error { constructor(m) { super(m); this.name = 'BatchValidationError'; } }
export const KEY_RE = /^(calib\/)?[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const FREE_MAX_STEPS = 28, FREE_MAX_PIXELS = 1048576;

export function isFreeTier(p) {
  const steps = Number(p?.steps || 0), px = Number(p?.width || 0) * Number(p?.height || 0);
  return steps <= FREE_MAX_STEPS && px <= FREE_MAX_PIXELS;
}

const int = (v, what) => {
  if (typeof v === 'boolean' || !(Number.isInteger(v) || (typeof v === 'string' && /^-?\d+$/.test(v.trim())))) throw new BatchValidationError(`${what} 는 정수여야 합니다: ${JSON.stringify(v)}`);
  return Number(v);
};

export function validateBatch(payload, { maxJobs }) {
  if (!payload || typeof payload !== 'object') throw new BatchValidationError('batch 는 객체여야 합니다');
  const jobs = payload.jobs;
  if (!Array.isArray(jobs) || !jobs.length) throw new BatchValidationError('jobs 는 비어 있지 않은 배열이어야 합니다');
  const limit = Math.min(Number(maxJobs) || 9, 32);
  if (jobs.length > limit) throw new BatchValidationError(`잡이 너무 많습니다: ${jobs.length} > ${limit}`);
  const seen = new Set(); const warnings = []; const out = [];
  for (const raw of jobs) {
    const key = String(raw?.key || '');
    if (!KEY_RE.test(key)) throw new BatchValidationError(`잡 key 형식이 아닙니다: ${JSON.stringify(key)}`);
    if (seen.has(key)) throw new BatchValidationError(`잡 key 중복: ${key}`); seen.add(key);
    const prompt = String(raw.prompt || '').trim();
    if (!prompt) throw new BatchValidationError(`${key}: prompt 가 비었습니다`);
    const p = raw.params && typeof raw.params === 'object' ? { ...raw.params } : null;
    if (!p) throw new BatchValidationError(`${key}: params 가 객체여야 합니다`);
    for (const k of ['width', 'height', 'steps']) { if (!(k in p)) throw new BatchValidationError(`${key}: params.${k} 가 필요합니다`); p[k] = int(p[k], `${key}: params.${k}`); }
    if ('seed' in p) p.seed = int(p.seed, `${key}: params.seed`);
    for (const k of Object.keys(p)) if (k === 'credential' || k.startsWith('_')) delete p[k];
    if (!isFreeTier(p)) warnings.push(`${key}: 무료 조건 밖(steps>${FREE_MAX_STEPS} 또는 픽셀>${FREE_MAX_PIXELS}) — Anlas 과금`);
    out.push({ key, prompt, negative: String(raw.negative || ''), params: p, expect: raw.expect && typeof raw.expect === 'object' ? raw.expect : {} });
  }
  return { batch: { source: payload.source, project: payload.project, title: payload.title, note: payload.note, jobs: out }, warnings };
}
