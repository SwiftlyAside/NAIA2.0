import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/lib/server.mjs';

const fakeTools = () => ({
  definitions: [{ name: 'naia_status', description: 'd', inputSchema: { type: 'object', properties: {} } }],
  async call(name, args, ctx) {
    if (name === 'slow') { ctx.progress(1, 2, 'half'); await new Promise(r => setTimeout(r, 20)); return { content: [{ type: 'text', text: 'done' }] }; }
    return { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] };
  },
});

test('initialize echoes protocolVersion and advertises tools; ping; tools/list', async () => {
  const out = []; const s = createServer({ tools: fakeTools(), write: m => out.push(m), log: () => {} });
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude' } } });
  assert.equal(out[0].result.protocolVersion, '2025-06-18'); assert.deepEqual(out[0].result.capabilities, { tools: {} }); assert.equal(out[0].result.serverInfo.name, 'naia-inbox');
  await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await s.handle({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(out[1], { jsonrpc: '2.0', id: 2, result: {} });
  await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(out[2].result.tools[0].name, 'naia_status');
});

test('tools/call dispatches with args, forwards progress notifications when a token is given', async () => {
  const out = []; const s = createServer({ tools: fakeTools(), write: m => out.push(m), log: () => {} });
  await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'naia_status', arguments: { a: 1 } } });
  assert.equal(out[0].result.content[0].text, 'naia_status:{"a":1}');
  await s.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'slow', arguments: {}, _meta: { progressToken: 'tok' } } });
  assert.deepEqual(out[1], { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'tok', progress: 1, total: 2, message: 'half' } });
  assert.equal(out[2].id, 6);
});

test('unknown method -> -32601, parse error marker -> -32700, missing params -> -32602', async () => {
  const out = []; const s = createServer({ tools: fakeTools(), write: m => out.push(m), log: () => {} });
  await s.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.equal(out[0].error.code, -32601);
  await s.handle({ __parseError: 'x', raw: '{' });
  assert.equal(out[1].error.code, -32700);
  await s.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} });
  assert.equal(out[2].error.code, -32602);
});
