// JSON-RPC 디스패치. 요청마다 독립 실행 — naia_await_batch 가 블로킹돼도 ping·tools/list 는 응답한다.
import { result, error, notification, E_PARSE, E_METHOD, E_PARAMS, E_INTERNAL } from './protocol.mjs';

export const SERVER_INFO = { name: 'naia-inbox', version: '0.1.1' };

export function createServer({ tools, write, log = () => {} }) {
  async function handle(msg) {
    if (msg?.__parseError) { write(error(null, E_PARSE, `parse error: ${msg.__parseError}`)); return; }
    const { id, method, params = {} } = msg || {};
    if (method === undefined) return;
    const isNotification = id === undefined || id === null;
    try {
      if (method === 'initialize') { write(result(id, { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER_INFO })); return; }
      if (method === 'notifications/initialized' || method.startsWith('notifications/')) return;
      if (method === 'ping') { write(result(id, {})); return; }
      if (method === 'tools/list') { write(result(id, { tools: tools.definitions })); return; }
      if (method === 'tools/call') {
        if (!params.name) { write(error(id, E_PARAMS, 'params.name is required')); return; }
        const token = params._meta?.progressToken;
        const progress = token === undefined ? () => {} : (p, t, m) => write(notification('notifications/progress', { progressToken: token, progress: p, total: t, message: m }));
        const res = await tools.call(params.name, params.arguments || {}, { progress });
        write(result(id, res)); return;
      }
      if (!isNotification) write(error(id, E_METHOD, `method not found: ${method}`));
    } catch (e) {
      log(`handler error: ${e?.stack || e}`);
      if (!isNotification) write(error(id, E_INTERNAL, e?.message || String(e)));
    }
  }
  return { handle };
}
