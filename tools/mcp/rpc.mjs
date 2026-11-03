// JSON-RPC 2.0 as MCP's stdio transport carries it: one message per line, each way.
export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isObject = x => typeof x === 'object' && x !== null && !Array.isArray(x);

// handle(method, params) answers a request; notifications are ignored, and the server sends no requests, so a response
// that comes in is dropped too; anything else with an id and no method name is an invalid request. Resolves once the input ends and every request in hand is answered.
export function listen({ input, output, handle }) {
  const send = msg => { if (!output.destroyed) output.write(`${JSON.stringify(msg)}\n`); };
  // A client that hangs up mid-answer is no reason to crash; the input ending stops the server.
  output.on?.('error', () => {});
  const pending = new Set();

  async function answer(msg) {
    if (!isObject(msg) || msg.jsonrpc !== '2.0') return send({ jsonrpc: '2.0', id: isObject(msg) ? msg.id ?? null : null, error: { code: -32600, message: 'Invalid Request' } });
    if (!('id' in msg) || (!('method' in msg) && ('result' in msg || 'error' in msg))) return;
    if (typeof msg.method !== 'string') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid Request' } });
    try {
      send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg.method, isObject(msg.params) ? msg.params : {}) });
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: e instanceof RpcError ? e.code : -32603, message: String(e?.message ?? e) } });
    }
  }

  function take(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const p = answer(msg).finally(() => pending.delete(p));
    pending.add(p);
  }

  return new Promise((resolve, reject) => {
    let buf = '';
    input.setEncoding('utf8');
    input.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        take(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    });
    input.on('error', reject);
    input.on('end', () => {
      take(buf);
      Promise.all(pending).then(() => resolve());
    });
  });
}

export const notify = (output, method, params) => {
  if (!output.destroyed) output.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
};
