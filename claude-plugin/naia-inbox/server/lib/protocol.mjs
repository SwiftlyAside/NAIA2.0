// MCP stdio = 개행 구분 JSON-RPC 2.0 (메시지 안에 개행 없음). 순수 모듈 — I/O 없음.
export const E_PARSE = -32700, E_INVALID = -32600, E_METHOD = -32601, E_PARAMS = -32602, E_INTERNAL = -32603;

export function createLineParser() {
  let rest = '';
  return {
    feed(chunk) {
      rest += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      const lines = rest.split('\n');
      rest = lines.pop();
      const out = [];
      for (const line of lines) {
        const raw = line.replace(/\r$/, '');
        if (!raw.trim()) continue;
        try { out.push(JSON.parse(raw)); } catch (e) { out.push({ __parseError: e.message, raw }); }
      }
      return out;
    },
  };
}

export function encode(obj) { return JSON.stringify(obj) + '\n'; }
export function result(id, res) { return { jsonrpc: '2.0', id, result: res }; }
export function error(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}
export function notification(method, params) { return { jsonrpc: '2.0', method, params }; }
