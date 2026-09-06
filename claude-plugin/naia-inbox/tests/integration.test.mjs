import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLineParser, encode } from '../server/lib/protocol.mjs';

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'naia-inbox-mcp.mjs');

function fakeNaiaServer() {
  const batches = {};
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname === '/api/status') return send(200, { api_mode: 'NAI', is_generating: false });
      if (req.method === 'POST' && u.pathname === '/api/agent-inbox/batches') { const b = JSON.parse(body); const id = 'b' + (Object.keys(batches).length + 1); batches[id] = { batch_id: id, status: 'pending', title: b.title, jobs: b.jobs.map((j, i) => ({ ...j, job_id: 'j' + i, status: 'pending' })) }; return send(200, { ok: true, batch_id: id, job_count: b.jobs.length, warnings: [] }); }
      if (req.method === 'GET' && u.pathname === '/api/agent-inbox/batches') return send(200, { batches: Object.values(batches) });
      const m = u.pathname.match(/^\/api\/agent-inbox\/batches\/([^/]+)(\/results)?$/);
      if (req.method === 'GET' && m && batches[m[1]]) { const b = batches[m[1]]; b.status = 'done'; b.jobs.forEach(j => { j.status = 'done'; j.history_id = 'h' + j.job_id; }); return send(200, m[2] ? { ...b, jobs: b.jobs.map(j => ({ ...j, image_url: `/api/history/image/${j.history_id}` })) } : b); }
      if (req.method === 'POST' && u.pathname === '/api/generate') return send(500, { error: 'must never be called' });
      send(404, { error: 'nope' });
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

test('real stdio server: initialize → tools/list → status → submit → await (progress) against a fake NAIA', async () => {
  const { srv, port } = await fakeNaiaServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-int-'));
  const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, NAIA_INBOX_DATA: dataDir, NAIA_BASE_URL: `http://127.0.0.1:${port}`, NAIA_ROOT: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const parser = createLineParser(); const inbox = []; const waiters = [];
  child.stdout.on('data', c => { for (const m of parser.feed(c)) { inbox.push(m); waiters.splice(0).forEach(w => w()); } });
  const send = m => child.stdin.write(encode(m));
  const waitFor = pred => new Promise(resolve => { const check = () => { const m = inbox.find(pred); if (m) resolve(m); else waiters.push(check); }; check(); });
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } } });
    assert.equal((await waitFor(m => m.id === 1)).result.serverInfo.name, 'naia-inbox');
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal((await waitFor(m => m.id === 2)).result.tools.length, 10);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'naia_status', arguments: {} } });
    assert.match((await waitFor(m => m.id === 3)).result.content[0].text, /reachable": true/);
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'naia_submit_batch', arguments: { title: 'T', jobs: [{ key: 'A', prompt: 'p', params: { width: 832, height: 1216, steps: 28 } }] } } });
    const sub = await waitFor(m => m.id === 4); assert.match(sub.result.content[0].text, /"batch_id": "b1"/);
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'naia_await_batch', arguments: { batch_id: 'b1', poll_sec: 0.1, max_wait_sec: 10 }, _meta: { progressToken: 'pt' } } });
    const done = await waitFor(m => m.id === 5);
    assert.match(done.result.content[0].text, /"status": "done"/);
    assert.equal(inbox.some(m => m.method === 'notifications/progress' && m.params.progressToken === 'pt'), true);
  } finally { child.kill(); srv.close(); }
});
