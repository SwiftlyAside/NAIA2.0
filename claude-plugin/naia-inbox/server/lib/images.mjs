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

// <key>.naia.json · <key>_2.naia.json … 중 같은 batch_id 인 것을 찾는다(PNG 가 옆에 있을 때만).
export function findExistingSidecar({ fs, outDir, key, batchId }) {
  const base = path.resolve(outDir);
  const candidates = [path.resolve(base, `${key}.naia.json`)];
  for (let n = 2; n <= 20; n++) candidates.push(path.resolve(base, `${key}_${n}.naia.json`));
  for (const sidecar of candidates) {
    if (!fs.existsSync(sidecar)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      const png = sidecar.replace(/\.naia\.json$/, '.png');
      if (data && data.batch_id === batchId && fs.existsSync(png)) return { sidecar, png, data };
    } catch { /* 깨진 사이드카는 무시하고 새로 쓴다 */ }
  }
  return null;
}

export async function fetchImages({ client, fs, batch, outDir, keys, now = () => new Date() }) {
  if (!path.isAbsolute(String(outDir || ''))) throw new Error('out_dir 는 절대경로여야 합니다');
  const wanted = keys && keys.length ? new Set(keys) : null;
  const saved = [], failed = [];
  for (const job of batch.jobs || []) {
    if (job.status !== 'done' || (wanted && !wanted.has(job.key))) continue;
    // 같은 배치의 사이드카가 이미 있으면(판정·검수가 뒤에 붙는 경우) PNG 는 다시 받지 않고 사이드카만 갱신한다 — _2 복제 방지.
    const existing = findExistingSidecar({ fs, outDir, key: job.key, batchId: batch.batch_id });
    if (existing) {
      const prev = existing.data;
      fs.writeFileSync(existing.sidecar, JSON.stringify({ ...prev, verdict: job.verdict ?? null, agent_review: job.agent_review ?? null, final: job.final ?? prev.final ?? null,
        file_path: job.file_path || prev.file_path || '', refreshed_at: now().toISOString() }, null, 2) + '\n', 'utf8');
      saved.push({ key: job.key, path: existing.png, sidecar: existing.sidecar, source: 'refresh' });
      continue;
    }
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
