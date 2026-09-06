// 완료 잡 PNG + 사이드카 저장. 히스토리가 사라졌으면(404) 자동 저장 원본(file_path) 복사로 폴백.
import path from 'node:path';
import { NaiaHttpError } from './client.mjs';

export function safeTarget(outDir, key, ext, fs) {
  const base = path.resolve(outDir);
  const target = path.resolve(base, `${key}${ext}`);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`out_dir 밖으로 나가는 키: ${key}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) return target;
  for (let n = 2; ; n++) { const cand = path.resolve(base, `${key}_${n}${ext}`); if (!fs.existsSync(cand)) return cand; }
}

export async function fetchImages({ client, fs, batch, outDir, keys, now = () => new Date() }) {
  if (!path.isAbsolute(String(outDir || ''))) throw new Error('out_dir 는 절대경로여야 합니다');
  const wanted = keys && keys.length ? new Set(keys) : null;
  const saved = [], failed = [];
  for (const job of batch.jobs || []) {
    if (job.status !== 'done' || (wanted && !wanted.has(job.key))) continue;
    let bytes = null, source = '';
    if (job.history_id) {
      try { bytes = await client.getBytes(`/api/history/image/${encodeURIComponent(job.history_id)}`); source = 'history'; }
      catch (e) { if (!(e instanceof NaiaHttpError && e.status === 404)) { failed.push({ key: job.key, error: e.message }); continue; } }
    }
    if (!bytes && job.file_path && fs.existsSync(job.file_path)) { bytes = fs.readFileSync(job.file_path); source = 'file_path'; }
    if (!bytes) { failed.push({ key: job.key, error: job.history_id ? '히스토리에 없고 자동 저장 원본도 없음(NAIA 재시작 후?)' : '결과 없음' }); continue; }
    let target;
    try { target = safeTarget(outDir, job.key, '.png', fs); } catch (e) { failed.push({ key: job.key, error: e.message }); continue; }
    fs.writeFileSync(target, bytes);
    const sidecar = target.replace(/\.png$/, '.naia.json');
    fs.writeFileSync(sidecar, JSON.stringify({ key: job.key, job_id: job.job_id, batch_id: batch.batch_id, history_id: job.history_id, file_path: job.file_path, source,
      final: job.final ?? null, verdict: job.verdict ?? null, agent_review: job.agent_review ?? null, fetched_at: now().toISOString() }, null, 2) + '\n', 'utf8');
    saved.push({ key: job.key, path: target, sidecar, source });
  }
  return { saved, failed };
}
