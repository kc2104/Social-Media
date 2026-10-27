#!/usr/bin/env node
// stdio transport (Claude Desktop, Claude Code, Cursor...). For hosted/remote use see http.js.
import { createInterface } from 'node:readline';
import { MetaClient } from './meta.js';
import { buildTools } from './tools.js';
import { createMcp } from './core.js';

const meta = new MetaClient();
const log = (...a) => process.stderr.write(meta.redact(a.join(' ')) + '\n');
const handle = createMcp({ meta, tools: buildTools(meta), log });
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

const rl = createInterface({ input: process.stdin });
rl.on('line', async line => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  for (const x of Array.isArray(m) ? m : [m]) { const r = await handle(x); if (r) send(r); }
});
rl.on('close', () => process.exit(0));
log(`social-media-manager-mcp ready (writes ${meta.allowWrites ? 'ENABLED' : 'disabled'})`);
