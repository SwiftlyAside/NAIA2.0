import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../server/lib/tools.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'naia-tools-'));
const parse = r => ({ isError: !!r.isError, text: r.content[0].text, json: JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf('\n') + 1)) });

// 가짜 NAIA: 경로별 응답 함수. reachable=false 면 fetch 가 던진다.
function fakeNaia(routes, state = { reachable: true }) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    if (!state.reachable) throw new TypeError('fetch failed');
    const u = new URL(url); const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined, search: u.search });
    const h = routes[key] || routes[Object.keys(routes).find(k => new RegExp('^' + k.replace(/\{id\}/g, '[^/]+') + '$').test(key))];
    if (!h) return { ok: false, status: 404, json: async () => ({ error: 'no route ' + key }), text: async () => '' };
    const [status, body] = h(calls.at(-1));
    return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
  };
  return { fetch, calls, state };
}

function deps(over = {}) {
  const dataDir = tmp(); const root = tmp();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ naia_root: root, launch: { ready_timeout_sec: 4 } }));
  const spawned = [];
  return { env: { NAIA_INBOX_DATA: dataDir }, fs, homedir: os.homedir(), spawn: (c, a, o) => { spawned.push({ c, a, o }); return { pid: 7, unref() {} }; },
    sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1000); })(), platform: 'win32', spawned, dataDir, root, ...over };
}

test('definitions list the ten tools with input schemas', () => {
  const t = createTools(deps({ fetch: async () => { throw new Error('unused'); } }));
  const names = t.definitions.map(d => d.name);
  assert.deepEqual(names, ['naia_configure', 'naia_status', 'naia_launch', 'naia_submit_batch', 'naia_await_batch', 'naia_list_batches', 'naia_results', 'naia_fetch_images', 'naia_review_job', 'naia_cancel_batch']);
  for (const d of t.definitions) { assert.equal(d.inputSchema.type, 'object'); assert.equal(typeof d.description, 'string'); }
});

test('naia_configure reads with sources and validates sets; forbidden env key rejected', async () => {
  const d = deps({ fetch: async () => { throw new Error('unused'); } });
  const t = createTools(d);
  const r = parse(await t.call('naia_configure', {}));
  assert.equal(r.isError, false); assert.equal(r.json.config.naia_root, d.root); assert.equal(r.json.sources.naia_root, 'config');
  const set = parse(await t.call('naia_configure', { set: { max_jobs: 3 } }));
  assert.equal(set.json.config.max_jobs, 3); assert.equal(JSON.parse(fs.readFileSync(path.join(d.dataDir, 'config.json'), 'utf8')).max_jobs, 3);
  const bad = parse(await t.call('naia_configure', { set: { launch: { env: { NOVELAI_TOKEN: 'x' } } } }));
  assert.equal(bad.isError, true); assert.equal(bad.json.code, 'config_invalid');
});

test('naia_status: reachable summary vs unreachable (not an error)', async () => {
  const naia = fakeNaia({ 'GET /api/status': () => [200, { api_mode: 'NAI', is_generating: false }],
    'GET /api/agent-inbox/batches': () => [200, { batches: [{ batch_id: 'b1', status: 'pending', title: 't', counts: {} },
      { batch_id: 'b2', status: 'done', title: 'judged', source: 'genit', verdicts_done: true, verdicts_pending: 0 },
      { batch_id: 'b3', status: 'done', title: 'waiting', verdicts_done: false, verdicts_pending: 2 }] }] });
  const t = createTools(deps({ fetch: naia.fetch }));
  const r = parse(await t.call('naia_status', {}));
  assert.equal(r.json.reachable, true); assert.equal(r.json.pending_batches, 1);
  assert.deepEqual(r.json.judged_batches.map(b => b.batch_id), ['b2']); assert.deepEqual(r.json.awaiting_verdicts.map(b => [b.batch_id, b.verdicts_pending]), [['b3', 2]]);
  naia.state.reachable = false;
  const r2 = parse(await t.call('naia_status', {}));
  assert.equal(r2.isError, false); assert.equal(r2.json.reachable, false);
});

test('naia_submit_batch validates locally, launches when down, posts, returns warnings + user_action', async () => {
  const naia = fakeNaia({ 'GET /api/status': () => [200, {}], 'POST /api/agent-inbox/batches': ({ body }) => [200, { ok: true, batch_id: 'b9', job_count: body.jobs.length, warnings: [] }] }, { reachable: false });
  const d = deps({ fetch: naia.fetch });
  // NAIA 가 꺼진 상태로 시작 — spawn 이 불리면 "떠서" 이후 status 가 성공하게 한다
  const spawned = [];
  d.spawn = (c, a, o) => { naia.state.reachable = true; spawned.push({ c, a, o }); return { pid: 1, unref() {} }; };
  const t = createTools(d);
  const r = parse(await t.call('naia_submit_batch', { title: 'T', jobs: [{ key: 'A', prompt: 'p', params: { width: 832, height: 1216, steps: 28 } }] }));
  assert.equal(r.isError, false); assert.equal(r.json.batch_id, 'b9'); assert.equal(r.json.launched, true); assert.match(r.json.user_action, /생성 시작/);
  assert.equal(spawned.length, 1);
  const post = naia.calls.find(c => c.key === 'POST /api/agent-inbox/batches');
  assert.equal(post.body.source, 'claude-code'); assert.equal(post.body.jobs[0].params.width, 832);
  const bad = parse(await t.call('naia_submit_batch', { title: 'T', jobs: [] }));
  assert.equal(bad.isError, true); assert.equal(bad.json.code, 'bad_args');
});

test('naia_submit_batch reads batch_file, inline fields override, missing file -> bad_args', async () => {
  const naia = fakeNaia({ 'GET /api/status': () => [200, {}], 'POST /api/agent-inbox/batches': ({ body }) => [200, { ok: true, batch_id: 'bf', job_count: body.jobs.length, warnings: [] }] });
  const d = deps({ fetch: naia.fetch });
  const file = path.join(d.dataDir, 'batch.json');
  fs.writeFileSync(file, JSON.stringify({ title: '파일 제목', source: 'genit', project: 'p', jobs: [{ key: 'A', prompt: 'p', params: { width: 832, height: 1216, steps: 28 } }] }));
  const t = createTools(d);
  const r = parse(await t.call('naia_submit_batch', { batch_file: file, title: '인라인 제목' }));
  assert.equal(r.isError, false); assert.equal(r.json.batch_id, 'bf'); assert.equal(r.json.batch_file, file);
  const post = naia.calls.find(c => c.key === 'POST /api/agent-inbox/batches');
  assert.equal(post.body.title, '인라인 제목'); assert.equal(post.body.source, 'genit'); assert.equal(post.body.jobs[0].key, 'A');
  const missing = parse(await t.call('naia_submit_batch', { batch_file: path.join(d.dataDir, 'nope.json') }));
  assert.equal(missing.isError, true); assert.equal(missing.json.code, 'bad_args');
  const noTitle = parse(await t.call('naia_submit_batch', { jobs: [{ key: 'A', prompt: 'p', params: { width: 832, height: 1216, steps: 28 } }] }));
  assert.equal(noTitle.isError, true); assert.equal(noTitle.json.code, 'bad_args');
});

test('naia_list_batches / naia_results / naia_review_job / naia_cancel_batch pass through; 409 -> http_4xx', async () => {
  const naia = fakeNaia({
    'GET /api/agent-inbox/batches': ({ search }) => [200, { batches: [{ batch_id: 'b1', status: 'done' }], search }],
    'GET /api/agent-inbox/batches/{id}/results': () => [200, { batch_id: 'b1', status: 'done', jobs: [{ job_id: 'j1', key: 'A', status: 'done', history_id: 'h1', image_url: '/api/history/image/h1' }] }],
    'POST /api/agent-inbox/jobs/{id}/agent-review': ({ body }) => [200, { ok: true, job_id: 'j1', agent_review: body }],
    'POST /api/agent-inbox/batches/{id}/cancel': () => [409, { ok: false, error: 'batch is approved' }],
  });
  const t = createTools(deps({ fetch: naia.fetch }));
  assert.equal(parse(await t.call('naia_list_batches', { status: 'done' })).json.batches.length, 1);
  assert.equal(naia.calls[0].search, '?status=done&limit=20');
  const res = parse(await t.call('naia_results', { batch_id: 'b1' }));
  assert.equal(res.json.jobs[0].image_url, 'http://127.0.0.1:7243/api/history/image/h1');
  assert.equal(parse(await t.call('naia_review_job', { job_id: 'j1', safety: 'pass', note: 'ok' })).json.agent_review.safety, 'pass');
  const c = parse(await t.call('naia_cancel_batch', { batch_id: 'b1' }));
  assert.equal(c.isError, true); assert.equal(c.json.code, 'http_4xx'); assert.match(c.text, /approved/);
});

test('naia_launch: no-op when up, launch_timeout when it never comes up', async () => {
  const naia = fakeNaia({ 'GET /api/status': () => [200, {}] });
  const t = createTools(deps({ fetch: naia.fetch }));
  assert.equal(parse(await t.call('naia_launch', {})).json.launched, false);
  const down = fakeNaia({}, { reachable: false });
  const r = parse(await createTools(deps({ fetch: down.fetch })).call('naia_launch', {}));
  assert.equal(r.isError, true); assert.equal(r.json.code, 'launch_timeout');
});

test('unknown tool -> bad_args error result', async () => {
  const t = createTools(deps({ fetch: async () => { throw new Error('unused'); } }));
  const r = parse(await t.call('naia_nope', {}));
  assert.equal(r.isError, true); assert.equal(r.json.code, 'bad_args');
});

test('naia_await_batch forwards progress and returns results; naia_fetch_images writes files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-out-'));
  let polls = 0;
  const naia = fakeNaia({
    'GET /api/agent-inbox/batches/{id}': () => [200, { batch_id: 'b1', status: ++polls >= 2 ? 'done' : 'generating', jobs: [{ key: 'A', status: polls >= 2 ? 'done' : 'generating', history_id: 'h1' }] }],
    'GET /api/agent-inbox/batches/{id}/results': () => [200, { batch_id: 'b1', status: 'done', jobs: [{ job_id: 'j1', key: 'A', status: 'done', history_id: 'h1', file_path: '', image_url: '/api/history/image/h1' }] }],
    'GET /api/history/image/{id}': () => [200, {}],
  });
  const t = createTools(deps({ fetch: naia.fetch }));
  const prog = [];
  const r = parse(await t.call('naia_await_batch', { batch_id: 'b1', max_wait_sec: 30, poll_sec: 1 }, { progress: (p, tot, m) => prog.push([p, tot, m]) }));
  assert.equal(r.isError, false); assert.equal(r.json.status, 'done'); assert.equal(prog.length, 2);
  const f = parse(await t.call('naia_fetch_images', { batch_id: 'b1', out_dir: dir }));
  assert.equal(f.json.saved.length, 1); assert.equal(fs.existsSync(path.join(dir, 'A.naia.json')), true);
});
