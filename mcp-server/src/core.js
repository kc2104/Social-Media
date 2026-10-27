// Transport-independent MCP request handling (used by stdio and HTTP).
import { validate } from './tools.js';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Tools for the official Meta Graph API (Instagram/Facebook) plus a local content calendar. Start with meta_connection_status. Write tools are disabled unless the operator sets META_ALLOW_WRITES=true; always get the user\'s approval before publishing, replying or sending DMs. Do not attempt bulk or unsolicited messaging.';

export function createMcp({ meta, tools, log = () => {} }) {
  const byName = new Map(tools.map(t => [t.name, t]));
  // Returns a JSON-RPC response object, or null for notifications.
  return async function handle(m) {
    const { id, method, params } = m || {};
    const isRequest = id !== undefined && id !== null;
    const ok = result => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    try {
      switch (method) {
        case 'initialize': {
          const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
          return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'social-media-manager-mcp', version: '1.1.0' }, instructions: INSTRUCTIONS });
        }
        case 'ping': return ok({});
        case 'tools/list': return ok({ tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
        case 'tools/call': {
          const t = byName.get(params?.name);
          if (!t) return err(-32602, `Unknown tool: ${params?.name}`);
          try {
            validate(t.inputSchema, params.arguments || {});
            const out = await t.handler(params.arguments || {});
            return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
          } catch (e) {
            log('tool error', t.name, e.message);
            return ok({ isError: true, content: [{ type: 'text', text: meta.redact(e.message) }] });
          }
        }
        default: return isRequest ? err(-32601, `Method not found: ${method}`) : null;
      }
    } catch (e) { log('internal error', e.stack || e.message); return isRequest ? err(-32603, 'Internal error') : null; }
  };
}
