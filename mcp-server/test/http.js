// End-to-end test of the hosted server: full OAuth (DCR + PKCE) flow, then MCP over Streamable HTTP.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const PORT = 18000 + Math.floor(Math.random() * 1000), BASE = `http://127.0.0.1:${PORT}`, PW = 'correct horse battery', REDIR = 'https://claude.ai/api/mcp/auth_callback';
const dir = mkdtempSync(join(tmpdir(), 'smm-http-'));
const srv = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '../src/http.js')], {
  env: { PATH: process.env.PATH, PORT, PUBLIC_URL: BASE, MCP_SIGNING_SECRET: 'x'.repeat(40), MCP_ADMIN_PASSWORD: PW, MCP_BEARER_TOKEN: 'static-bearer-for-cli', META_ACCESS_TOKEN: 'tok', CALENDAR_FILE: join(dir, 'c.json') }, stdio: ['ignore', 'ignore', 'pipe'] });
let err = ''; srv.stderr.on('data', d => err += d);
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { await new Promise(r => setTimeout(r, 100)); } }

let pass = 0; const ok = async (n, f) => { try { await f(); pass++; console.log('PASS', n); } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };
const post = (path, body, headers = {}, form) => fetch(BASE + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
let clientId, code, access, refresh;

await ok('unauthenticated /mcp → 401 with resource_metadata pointer', async () => {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }); assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /resource_metadata="[^"]+oauth-protected-resource"/);
});
await ok('discovery documents', async () => {
  const pr = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json(); assert.equal(pr.resource, `${BASE}/mcp`);
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json(); assert.deepEqual(as.code_challenge_methods_supported, ['S256']); assert.ok(as.registration_endpoint);
});
await ok('dynamic client registration; rejects non-https redirect', async () => {
  assert.equal((await post('/register', { redirect_uris: ['http://evil.example/cb'] })).status, 400);
  const r = await post('/register', { client_name: 'Claude', redirect_uris: [REDIR] }); assert.equal(r.status, 201); clientId = (await r.json()).client_id; assert.ok(clientId);
});
const authParams = { response_type: 'code', client_id: () => clientId, redirect_uri: REDIR, code_challenge: challenge, code_challenge_method: 'S256', state: 'st123' };
const ap = extra => ({ ...Object.fromEntries(Object.entries(authParams).map(([k, v]) => [k, typeof v === 'function' ? v() : v])), ...extra });
await ok('consent page renders; unknown redirect_uri is NOT redirected', async () => {
  const q = new URLSearchParams(ap()); const g = await fetch(`${BASE}/authorize?${q}`); assert.equal(g.status, 200); assert.match(await g.text(), /Owner password/);
  const bad = await fetch(`${BASE}/authorize?${new URLSearchParams(ap({ redirect_uri: 'https://evil.example/cb' }))}`, { redirect: 'manual' }); assert.equal(bad.status, 400);
});
await ok('wrong password rejected; lockout after 5 tries', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post('/authorize', ap({ password: 'nope' + i }), {}, true)).status, 401);
  assert.equal((await post('/authorize', ap({ password: PW }), {}, true)).status, 429); // locked even with right password
});
await ok('right password (from another IP) → redirect with code + state', async () => { /* handled below by new IP header */
  const r = await post('/authorize', ap({ password: PW }), { 'x-forwarded-for': '9.9.9.9' }, true); assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location')); assert.equal(loc.origin + loc.pathname, REDIR); assert.equal(loc.searchParams.get('state'), 'st123'); code = loc.searchParams.get('code'); assert.ok(code);
});
await ok('token: wrong PKCE verifier fails; right one works; code is single-use', async () => {
  const t = b => post('/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIR, ...b }, {}, true);
  assert.equal((await t({ code_verifier: 'wrong' + verifier })).status, 400);
  const r = await t({ code_verifier: verifier }); assert.equal(r.status, 200); const j = await r.json(); access = j.access_token; refresh = j.refresh_token; assert.equal(j.token_type, 'Bearer');
  assert.equal((await t({ code_verifier: verifier })).status, 400);
});
const rpc = (method, params, tok = access, id = 1) => fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
await ok('MCP over HTTP with OAuth token: initialize, tools/list, tools/call', async () => {
  const i = await (await rpc('initialize', { protocolVersion: '2025-06-18' })).json(); assert.equal(i.result.serverInfo.name, 'social-media-manager-mcp');
  assert.ok((await (await rpc('tools/list')).json()).result.tools.length >= 17);
  const c = await (await rpc('tools/call', { name: 'calendar_add', arguments: { title: 'x', date: '2026-11-02' } })).json(); assert.equal(JSON.parse(c.result.content[0].text).status, 'Draft');
});
await ok('notification → 202; GET /mcp → 405', async () => {
  const n = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }); assert.equal(n.status, 202);
  assert.equal((await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${access}` } })).status, 405);
});
await ok('refresh token grant gives a working access token', async () => {
  const r = await post('/token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }, {}, true); assert.equal(r.status, 200);
  assert.equal((await rpc('ping', {}, (await r.json()).access_token)).status, 200);
});
await ok('forged / tampered / refresh-as-access tokens rejected', async () => {
  assert.equal((await rpc('ping', {}, access.slice(0, -2) + 'xx')).status, 401);
  assert.equal((await rpc('ping', {}, refresh)).status, 401);
  assert.equal((await rpc('ping', {}, 'garbage')).status, 401);
});
await ok('static bearer works for header-based clients (CLI)', async () => assert.equal((await rpc('ping', {}, 'static-bearer-for-cli')).status, 200));
await ok('write tools disabled over HTTP by default', async () => {
  const r = await (await rpc('tools/call', { name: 'ig_send_dm', arguments: { recipient_id: '1', text: 'x' } })).json(); assert.ok(r.result.isError); assert.match(r.result.content[0].text, /writes are disabled/);
});
srv.kill(); rmSync(dir, { recursive: true, force: true });
if (/tok\b.*leak/.test(err)) process.exitCode = 1;
console.log(`${pass} passed`);
