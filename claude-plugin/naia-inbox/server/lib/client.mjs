// NAIA HTTP 클라이언트 — 화이트리스트 밖은 NaiaGuardError. 승인·생성·큐 경로는 여기 없다(ToS: human action).
export class NaiaGuardError extends Error { constructor(m) { super(m); this.name = 'NaiaGuardError'; } }
export class NaiaHttpError extends Error { constructor(status, body, path) { super(`HTTP ${status} ${path}`); this.name = 'NaiaHttpError'; this.status = status; this.body = body; this.path = path; } }
export class NaiaUnreachableError extends Error { constructor(m) { super(m); this.name = 'NaiaUnreachableError'; } }

const ID = '[A-Za-z0-9_-]+';
export const ALLOWED_ROUTES = Object.freeze([
  { method: 'GET', re: /^\/api\/status$/ },
  { method: 'GET', re: /^\/api\/agent-inbox\/(batches|settings)(\/[A-Za-z0-9_-]+(\/results)?)?$/ },
  { method: 'POST', re: /^\/api\/agent-inbox\/batches$/ },
  { method: 'POST', re: new RegExp(`^/api/agent-inbox/batches/${ID}/cancel$`) },
  { method: 'POST', re: new RegExp(`^/api/agent-inbox/jobs/${ID}/agent-review$`) },
  { method: 'GET', re: new RegExp(`^/api/history/(image|thumb|meta)/${ID}$`) },
]);

export function assertAllowed(method, path) {
  const clean = String(path).split('?')[0];
  const ok = ALLOWED_ROUTES.some(r => r.method === method && r.re.test(clean));
  if (!ok) throw new NaiaGuardError(`허용되지 않은 요청: ${method} ${clean}`);
}

export function createClient({ baseUrl, fetch: fetchFn = globalThis.fetch }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  async function request(method, path, body, as = 'json') {
    assertAllowed(method, path);
    let res;
    try {
      res = await fetchFn(base + path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) { throw new NaiaUnreachableError(`NAIA 에 접속할 수 없습니다 (${base}): ${e.message}`); }
    if (!res.ok) {
      let parsed; try { parsed = await res.json(); } catch { parsed = { error: await res.text().catch(() => '') }; }
      throw new NaiaHttpError(res.status, parsed, path);
    }
    if (as === 'bytes') return Buffer.from(await res.arrayBuffer());
    return res.json();
  }
  return {
    getJson: path => request('GET', path),
    postJson: (path, body) => request('POST', path, body ?? {}),
    getBytes: path => request('GET', path, undefined, 'bytes'),
    async status() { try { return await request('GET', '/api/status'); } catch { return null; } },
  };
}
