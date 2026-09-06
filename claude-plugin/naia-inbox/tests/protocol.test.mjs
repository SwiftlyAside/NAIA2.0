import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineParser, encode, result, error, notification, E_METHOD } from '../server/lib/protocol.mjs';

test('two messages in one chunk, one message split across chunks, blank lines ignored', () => {
  const p = createLineParser();
  const a = p.feed('{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n{"jsonrpc":"2.0","id":2,"met');
  assert.deepEqual(a.map(m => m.id), [1]);
  const b = p.feed(Buffer.from('hod":"ping"}\n'));
  assert.deepEqual(b.map(m => m.id), [2]);
  assert.deepEqual(p.feed(''), []);
});

test('malformed line yields a parse-error marker instead of throwing', () => {
  const p = createLineParser();
  const [m] = p.feed('{not json}\n');
  assert.ok(m.__parseError);
  assert.equal(m.raw, '{not json}');
});

test('encode emits single-line JSON ending with newline', () => {
  const s = encode({ a: 'x\ny', b: 1 });
  assert.equal(s.endsWith('\n'), true);
  assert.equal(s.slice(0, -1).includes('\n'), false);
  assert.deepEqual(JSON.parse(s), { a: 'x\ny', b: 1 });
});

test('result / error / notification shapes', () => {
  assert.deepEqual(result(3, { ok: true }), { jsonrpc: '2.0', id: 3, result: { ok: true } });
  assert.deepEqual(error(4, E_METHOD, 'nope', { m: 'x' }), { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'nope', data: { m: 'x' } } });
  assert.deepEqual(notification('notifications/progress', { progressToken: 't', progress: 1, total: 2 }),
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 't', progress: 1, total: 2 } });
});
