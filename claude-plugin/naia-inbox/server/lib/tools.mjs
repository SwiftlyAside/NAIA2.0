// 도구 레지스트리. 모든 I/O 는 deps 로 주입 — 테스트는 네트워크·프로세스 없이 돈다.
import { loadConfig, validateConfig, mergeConfig, saveConfig, resolveDataDir } from './config.mjs';
import { createClient, NaiaHttpError, NaiaUnreachableError, NaiaGuardError } from './client.mjs';
import { ensureRunning } from './launch.mjs';
import { validateBatch, BatchValidationError } from './validate.mjs';
import { awaitBatch } from './await.mjs';
import { fetchImages } from './images.mjs';

export const ok = (summary, data) => ({ content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data, null, 2)}` }] });
export const fail = (code, message, detail, hint) => ({ isError: true, content: [{ type: 'text', text: `${message}\n${JSON.stringify({ code, detail: detail ?? null, hint: hint ?? null }, null, 2)}` }] });

export function errorToResult(e) {
  if (e instanceof NaiaUnreachableError) return fail('unreachable', e.message, null, 'naia_launch 를 호출하거나 NAIA 를 켜세요');
  if (e instanceof NaiaHttpError) {
    const detail = e.body?.error || e.body;
    const hint = /CERTIFICATE_VERIFY_FAILED|SSL/.test(JSON.stringify(detail || '')) ? 'NAIA 백엔드 TLS 실패 — launch.env 의 REQUESTS_CA_BUNDLE 을 확인하세요' : undefined;
    return fail(e.status >= 500 ? 'http_5xx' : 'http_4xx', `NAIA 응답 ${e.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, { status: e.status, path: e.path }, hint);
  }
  if (e instanceof NaiaGuardError) return fail('guard', e.message);
  if (e instanceof BatchValidationError) return fail('bad_args', e.message);
  return fail('internal', e?.message || String(e));
}

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const REVIEW = { type: 'string', enum: ['pass', 'fail', 'na'] };
const JOB = S({ key: { type: 'string' }, prompt: { type: 'string' }, negative: { type: 'string' },
  params: { type: 'object', properties: { seed: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, steps: { type: 'integer' }, cfg_scale: { type: 'number' }, cfg_rescale: { type: 'number' }, sampler: { type: 'string' }, scheduler: { type: 'string' }, model: { type: 'string' } }, required: ['width', 'height', 'steps'] },
  expect: { type: 'object', properties: { label: { type: 'string' }, character: { type: 'string' }, emotion: { type: 'string' }, note: { type: 'string' } } } }, ['key', 'prompt', 'params']);

export const DEFINITIONS = [
  { name: 'naia_configure', description: '플러그인 설정 조회·변경 (base_url, naia_root, launch, max_jobs). set 은 얕은 병합.', inputSchema: S({ set: { type: 'object' } }) },
  { name: 'naia_status', description: 'NAIA 접속 여부·모드·미승인 배치 수·진행 중 배치 요약. 미접속이어도 오류가 아니다.', inputSchema: S({}) },
  { name: 'naia_launch', description: 'NAIA 가 꺼져 있으면 기동하고 준비될 때까지 기다린다. 생성을 개시하지 않는다.', inputSchema: S({ wait: { type: 'boolean', default: true } }) },
  { name: 'naia_submit_batch', description: '생성 배치를 Agent Inbox 에 제출한다(미기동이면 기동). jobs 를 인라인으로 주거나 batch_file(절대경로 JSON: {title, source, project, note, jobs}) 을 준다 — 인라인 필드가 파일 값을 덮는다. 생성은 사용자가 NAIA 화면에서 "생성 시작"을 눌러야 시작된다.', inputSchema: S({ batch_file: { type: 'string' }, title: { type: 'string' }, jobs: { type: 'array', items: JOB, minItems: 1 }, source: { type: 'string' }, project: { type: 'string' }, note: { type: 'string' }, launch: { type: 'boolean', default: true } }) },
  { name: 'naia_await_batch', description: '배치가 끝날 때까지(until=done) 또는 모든 완료 잡에 사용자 판정이 붙을 때까지(until=verdicts) 블로킹 대기하고 results 를 돌려준다.', inputSchema: S({ batch_id: { type: 'string' }, until: { type: 'string', enum: ['done', 'verdicts'], default: 'done' }, max_wait_sec: { type: 'integer', default: 86400 }, poll_sec: { type: 'number', default: 2 } }, ['batch_id']) },
  { name: 'naia_list_batches', description: '배치 요약 목록.', inputSchema: S({ status: { type: 'string' }, source: { type: 'string' }, limit: { type: 'integer', default: 20 } }) },
  { name: 'naia_results', description: '배치의 잡별 결과(히스토리 ID·파일 경로·최종 프롬프트·판정·검수).', inputSchema: S({ batch_id: { type: 'string' } }, ['batch_id']) },
  { name: 'naia_fetch_images', description: '완료 잡의 PNG 와 사이드카 JSON 을 out_dir(절대경로)에 저장한다.', inputSchema: S({ batch_id: { type: 'string' }, out_dir: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } }, ['batch_id', 'out_dir']) },
  { name: 'naia_review_job', description: '에이전트 검수 결과(안전·화풍·텍스트·해부·speckle·해상도: pass/fail/na + note)를 잡 카드에 기록한다. 사용자 판정(verdict)은 쓰지 않는다.', inputSchema: S({ job_id: { type: 'string' }, safety: REVIEW, style: REVIEW, text: REVIEW, anatomy: REVIEW, speckle: REVIEW, resolution: REVIEW, note: { type: 'string' } }, ['job_id']) },
  { name: 'naia_cancel_batch', description: '승인 대기 중인 배치를 취소한다(승인된 뒤에는 409).', inputSchema: S({ batch_id: { type: 'string' } }, ['batch_id']) },
];

export function createTools(deps) {
  const { env = process.env, fs, homedir, fetch: fetchFn = globalThis.fetch, spawn, sleep, now = Date.now, platform = process.platform } = deps;
  const dataDir = resolveDataDir(env, homedir);
  const cfg = () => loadConfig({ env, fs, dataDir });
  const client = () => createClient({ baseUrl: cfg().config.base_url, fetch: fetchFn });
  const absUrl = (base, p) => (p && p.startsWith('/') ? String(base).replace(/\/+$/, '') + p : p || '');

  const handlers = {
    async naia_configure({ set }) {
      const cur = cfg();
      if (!set) return ok('현재 설정', { config: cur.config, sources: cur.sources, file: cur.file, errors: cur.errors, validation: validateConfig(cur.config, { fs }) });
      const merged = mergeConfig(cur.config, set);
      const errs = validateConfig(merged, { fs });
      if (errs.length) return fail('config_invalid', `설정 검증 실패: ${errs.join(' / ')}`, errs);
      const file = saveConfig({ fs, dataDir }, merged);
      return ok('설정 저장', { config: merged, file });
    },
    async naia_status() {
      const c = client(); const st = await c.status();
      if (!st) return ok('NAIA 미접속', { reachable: false, base_url: cfg().config.base_url });
      const list = await c.getJson('/api/agent-inbox/batches?limit=50');
      const batches = list.batches || [];
      const active = batches.find(b => ['approved', 'generating'].includes(b.status)) || null;
      return ok(`NAIA 접속됨 · 미승인 ${batches.filter(b => b.status === 'pending').length}`, { reachable: true, api_mode: st.api_mode, is_generating: !!st.is_generating,
        pending_batches: batches.filter(b => b.status === 'pending').length, active: active && { batch_id: active.batch_id, title: active.title, status: active.status, counts: active.counts } });
    },
    async naia_launch({ wait = true } = {}) {
      const c = client(); const { config } = cfg();
      if (await c.status()) return ok('이미 실행 중', { launched: false, reachable: true, elapsed_sec: 0 });
      const r = await ensureRunning({ client: c, config, spawn, sleep, now, platform, env });
      if (wait && !r.reachable) return fail('launch_timeout', `NAIA 를 띄웠지만 ${config.launch.ready_timeout_sec}초 안에 응답하지 않았습니다`, r, '포트·launch 설정을 naia_configure 로 확인하세요');
      return ok(r.launched ? 'NAIA 기동' : '이미 실행 중', r);
    },
    async naia_submit_batch(args) {
      const { config } = cfg();
      // batch_file: 브리지(예: Genit naia-bridge batch)가 쓴 배치 JSON — 인라인 인자가 있으면 그 필드가 파일 값을 덮는다.
      const batchFile = args.batch_file ? String(args.batch_file) : null;
      let merged = { ...args };
      if (args.batch_file) {
        let fromFile;
        try { fromFile = JSON.parse(fs.readFileSync(String(args.batch_file), 'utf8')); }
        catch (e) { return fail('bad_args', `batch_file 을 읽을 수 없습니다: ${e.message}`, { batch_file: args.batch_file }); }
        if (!fromFile || typeof fromFile !== 'object') return fail('bad_args', 'batch_file 의 내용이 객체가 아닙니다');
        merged = { ...fromFile, ...Object.fromEntries(Object.entries(args).filter(([k, v]) => k !== 'batch_file' && v !== undefined)) };
      }
      if (!merged.title) return fail('bad_args', 'title 이 필요합니다(인라인 또는 batch_file)');
      let validated;
      try { validated = validateBatch(merged, { maxJobs: config.max_jobs }); } catch (e) { return errorToResult(e); }
      args = merged;
      const c = client(); let launched = false;
      if (!(await c.status())) {
        if (args.launch === false) return fail('unreachable', 'NAIA 미접속(launch=false)', null, 'naia_launch 를 먼저 호출하세요');
        const r = await ensureRunning({ client: c, config, spawn, sleep, now, platform, env });
        if (!r.reachable) return fail('launch_timeout', `NAIA 를 띄웠지만 ${config.launch.ready_timeout_sec}초 안에 응답하지 않았습니다`, r);
        launched = r.launched;
      }
      const body = { ...validated.batch, source: validated.batch.source || config.default_source };
      const res = await c.postJson('/api/agent-inbox/batches', body);
      return ok(`배치 제출 ${res.batch_id} (${res.job_count}장)`, { ...res, warnings: [...validated.warnings, ...(res.warnings || [])], launched, batch_file: batchFile, user_action: 'NAIA 화면의 Agent Inbox 에서 "생성 시작"을 눌러야 생성됩니다' });
    },
    async naia_await_batch({ batch_id, until = 'done', max_wait_sec = 86400, poll_sec = 2 }, ctx = {}) {
      const c = client(); const { config } = cfg();
      const r = await awaitBatch({ client: c, batchId: batch_id, until, maxWaitSec: max_wait_sec, pollSec: poll_sec, sleep, now, progress: ctx.progress || (() => {}) });
      const results = await c.getJson(`/api/agent-inbox/batches/${encodeURIComponent(batch_id)}/results`);
      results.jobs = (results.jobs || []).map(j => ({ ...j, image_url: absUrl(config.base_url, j.image_url) }));
      if (r.status === 'timeout') return fail('await_timeout', `${max_wait_sec}초 안에 조건(${until})에 도달하지 못했습니다`, results, '다시 naia_await_batch 를 호출하면 이어서 기다립니다');
      return ok(`배치 ${batch_id} ${r.batch.status} (${until})`, results);
    },
    async naia_list_batches({ status, source, limit = 20 } = {}) {
      const q = new URLSearchParams(); if (status) q.set('status', status); if (source) q.set('source', source); q.set('limit', String(limit));
      return ok('배치 목록', await client().getJson(`/api/agent-inbox/batches?${q}`));
    },
    async naia_results({ batch_id }) {
      const { config } = cfg();
      const r = await client().getJson(`/api/agent-inbox/batches/${encodeURIComponent(batch_id)}/results`);
      r.jobs = (r.jobs || []).map(j => ({ ...j, image_url: absUrl(config.base_url, j.image_url), thumb_url: j.history_id ? absUrl(config.base_url, `/api/history/thumb/${j.history_id}`) : '' }));
      return ok(`배치 ${r.batch_id} ${r.status}`, r);
    },
    async naia_fetch_images({ batch_id, out_dir, keys }) {
      const c = client();
      const results = await c.getJson(`/api/agent-inbox/batches/${encodeURIComponent(batch_id)}/results`);
      const r = await fetchImages({ client: c, fs, batch: results, outDir: out_dir, keys, now: () => new Date(now()) });
      return ok(`이미지 ${r.saved.length}장 저장, 실패 ${r.failed.length}`, r);
    },
    async naia_review_job({ job_id, ...review }) {
      return ok('검수 기록', await client().postJson(`/api/agent-inbox/jobs/${encodeURIComponent(job_id)}/agent-review`, review));
    },
    async naia_cancel_batch({ batch_id }) {
      return ok('배치 취소', await client().postJson(`/api/agent-inbox/batches/${encodeURIComponent(batch_id)}/cancel`, {}));
    },
  };

  return {
    definitions: DEFINITIONS,
    async call(name, args = {}, ctx = {}) {
      const h = handlers[name];
      if (!h) return fail('bad_args', `알 수 없는 도구: ${name}`);
      try { return await h(args || {}, ctx); } catch (e) { return errorToResult(e); }
    },
    _internals: { cfg, client, dataDir, absUrl },
  };
}
