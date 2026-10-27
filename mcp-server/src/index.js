#!/usr/bin/env node
// Zero-dependency MCP server (stdio transport, newline-delimited JSON-RPC 2.0).
import { createInterface } from 'node:readline';
import { MetaClient } from './meta.js';
import { buildTools, validate } from './tools.js';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const meta = new MetaClient();
const tools = buildTools(meta);
const byName = new Map(tools.map(t => [t.name, t]));

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const log = (...a) => process.stderr.write(meta.redact(a.join(' ')) + '\n');

async function handle(m) {
  const { id, method, params } = m;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
        return send({ id, result: { protocolVersion: v, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'social-media-manager-mcp', version: '1.0.0' },
          instructions: 'Tools for the official Meta Graph API (Instagram/Facebook) plus a local content calendar. Start with meta_connection_status. Write tools are disabled unless the operator sets META_ALLOW_WRITES=true; always get the user\'s approval before publishing, replying or sending DMs. Do not attempt bulk or unsolicited messaging.' } });
      }
      case 'ping': return send({ id, result: {} });
      case 'tools/list':
        return send({ id, result: { tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) } });
      case 'tools/call': {
        const t = byName.get(params?.name);
        if (!t) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
        try {
          validate(t.inputSchema, params.arguments || {});
          const out = await t.handler(params.arguments || {});
          return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
        } catch (e) {
          log('tool error', t.name, e.message);
          return send({ id, result: { isError: true, content: [{ type: 'text', text: meta.redact(e.message) }] } });
        }
      }
      default:
        if (isRequest) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    log('internal error', e.stack || e.message);
    if (isRequest) send({ id, error: { code: -32603, message: 'Internal error' } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  Array.isArray(m) ? m.forEach(handle) : handle(m);
});
rl.on('close', () => process.exit(0));
log(`social-media-manager-mcp ready (writes ${meta.allowWrites ? 'ENABLED' : 'disabled'})`);
