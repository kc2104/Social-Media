#!/usr/bin/env node
// One-command setup: registers this server in Claude Desktop's config (and prints the Claude Code / Cursor commands).
// Usage: node src/setup.js --token YOUR_TOKEN [--writes] [--ig-id 1784...] [--config /custom/path.json]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const token = opt('token') || process.env.META_ACCESS_TOKEN;
if (!token) { console.error('Missing token. Run: node src/setup.js --token YOUR_META_ACCESS_TOKEN  (add --writes to enable publishing/replies)'); process.exit(1); }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'index.js');
const home = process.env.HOME_OVERRIDE || homedir();
const defaults = { darwin: join(home, 'Library/Application Support/Claude/claude_desktop_config.json'), win32: join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'Claude/claude_desktop_config.json') };
const cfgPath = opt('config') || defaults[platform()] || join(home, '.config/Claude/claude_desktop_config.json');

const env = { META_ACCESS_TOKEN: token, META_ALLOW_WRITES: args.includes('--writes') ? 'true' : 'false', CALENDAR_FILE: join(root, 'data', 'calendar.json') };
if (opt('ig-id')) env.META_IG_USER_ID = opt('ig-id');

let cfg = {};
if (existsSync(cfgPath)) { try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8') || '{}'); } catch { console.error(`Could not parse ${cfgPath}; fix or remove it and retry.`); process.exit(1); } copyFileSync(cfgPath, `${cfgPath}.bak`); }
cfg.mcpServers = { ...(cfg.mcpServers || {}), 'social-media-manager': { command: process.execPath, args: [entry], env } };
mkdirSync(dirname(cfgPath), { recursive: true });
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

console.log(`Claude Desktop config updated: ${cfgPath}${existsSync(`${cfgPath}.bak`) ? ' (backup: .bak)' : ''}`);
console.log(`Writes are ${env.META_ALLOW_WRITES === 'true' ? 'ENABLED' : 'disabled (read-only)'}. Restart Claude Desktop, then ask: "Run meta_connection_status".`);
console.log('\nClaude Code (project already has .mcp.json; just export your token):\n  export META_ACCESS_TOKEN=...   # then run `claude` in the repo and approve the server');
console.log(`\nOr add it globally:\n  claude mcp add social-media-manager -e META_ACCESS_TOKEN=... -- node ${entry}`);
