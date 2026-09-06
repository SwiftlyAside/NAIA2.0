import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, NaiaGuardError, NaiaHttpError, NaiaUnreachableError, assertAllowed } from '../server/lib/client.mjs';

const fakeFetch = (handler) => async (url, init = {}) => handler(new URL(url), init);
const jsonRes = (status, body) => ({ ok: status < 400, status, headers: { get: () => 'application/json' },
  json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer });

test('whitelist accepts inbox/status/history reads and rejects everything else', () => {
  for (const [m, p] of [['GET', '/api/status'], ['GET', '/api/agent-inbox/batches?status=pending'], ['GET', '/api/agent-inbox/batches/abc/results'],
    ['POST', '/api/agent-inbox/batches'], ['POST', '/api/agent-inbox/batches/abc/cancel'], ['POST', '/api/agent-inbox/jobs/j1/agent-review'],
    ['GET', '/api/history/image/h1'], ['GET', '/api/history/thumb/h1'], ['GET', '/api/history/meta/h1']]) assertAllowed(m, p);
  for (const [m, p] of [['POST', '/api/generate'], ['POST', '/api/random'], ['POST', '/api/queue/action'], ['GET', '/api/queue/state'],
    ['POST', '/api/agent-inbox/batches/abc/approve'], ['DELETE', '/api/agent-inbox/batches/abc'], ['GET', '/api/history/list'], ['GET', '/ws']]) {
    assert.throws(() => assertAllowed(m, p), NaiaGuardError, `${m} ${p}`);
  }
});

test('getJson/postJson hit base_url and parse; 4xx/5xx become NaiaHttpError with body', async () => {
  const calls = [];
  const c = createClient({ baseUrl: 'http://127.0.0.1:7243/', fetch: fakeFetch((u, init) => {
    calls.push([init.method || 'GET', u.pathname + u.search, init.body]);
    if (u.pathname.endsWith('/cancel')) return jsonRes(409, { ok: false, error: 'batch is approved' });
    return jsonRes(200, { ok: true, path: u.pathname });
  }) });
  assert.deepEqual(await c.getJson('/api/agent-inbox/batches?status=pending'), { ok: true, path: '/api/agent-inbox/batches' });
  await c.postJson('/api/agent-inbox/batches', { title: 't' });
  assert.equal(calls[1][0], 'POST'); assert.equal(JSON.parse(calls[1][2]).title, 't');
  await assert.rejects(c.postJson('/api/agent-inbox/batches/x/cancel', {}), e => e instanceof NaiaHttpError && e.status === 409 && /approved/.test(e.body.error));
});

test('network failure -> NaiaUnreachableError; status() returns null instead of throwing', async () => {
  const c = createClient({ baseUrl: 'http://127.0.0.1:1', fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(c.getJson('/api/status'), NaiaUnreachableError);
  assert.equal(await c.status(), null);
});

test('getBytes returns a Buffer', async () => {
  const c = createClient({ baseUrl: 'http://127.0.0.1:7243', fetch: fakeFetch(() => ({ ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => Uint8Array.from([137, 80]).buffer })) });
  const b = await c.getBytes('/api/history/image/h1');
  assert.equal(Buffer.isBuffer(b), true); assert.equal(b[0], 137);
});
