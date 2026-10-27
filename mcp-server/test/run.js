// End-to-end test: spawns the MCP server over stdio against a local mock of the Graph API.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const TOKEN = 'TEST_SECRET_TOKEN_123';
const seen = [];
let forceRateLimit = false;
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    seen.push({ method: req.method, path, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (![`Bearer ${TOKEN}`, 'Bearer PAGE_TOKEN'].includes(req.headers.authorization)) return send({ error: { message: `Invalid token ${TOKEN}`, code: 190 } }, 401);
    if (forceRateLimit) return send({ error: { message: 'Application request limit reached', code: 4 } }, 400);
    if (path === 'me') return send({ id: '1', name: 'Tester' });
    if (path === 'me/permissions') return send({ data: [{ permission: 'instagram_basic', status: 'granted' }, { permission: 'pages_show_list', status: 'declined' }] });
    if (path === 'me/accounts') return send({ data: [{ id: 'P1', name: 'Page', access_token: 'PAGE_TOKEN', instagram_business_account: { id: 'IG1', username: 'brand' } }] });
    if (path === 'IG1') return send({ id: 'IG1', username: 'brand', followers_count: 42 });
    if (path === 'IG1/media' && req.method === 'GET') return send({ data: [{ id: 'M1', caption: 'hi' }] });
    if (path === 'IG1/media' && req.method === 'POST') return send({ id: 'C1' });
    if (path === 'C1') return send({ status_code: 'FINISHED' });
    if (path === 'IG1/media_publish') return send({ id: 'M2' });
    if (path === 'M2') return send({ permalink: 'https://instagram.com/p/abc' });
    if (path === 'CM1/replies') return send({ id: 'R1' });
    if (path === 'me/messages') return send({ recipient_id: 'U1', message_id: 'mid' });
    if (path === 'me/conversations') return send({ data: [{ id: 'CV1' }] });
    send({ error: { message: `unmocked ${path}`, code: 100 } }, 400);
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'smm-'));

function start(env) {
  const p = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '../src/index.js')], {
    env: { PATH: process.env.PATH, META_ACCESS_TOKEN: TOKEN, META_GRAPH_BASE: base, META_MIN_INTERVAL_MS: '0', CALENDAR_FILE: join(dir, 'cal.json'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let n = 0; let stderr = '';
  p.stderr.on('data', d => stderr += d);
  createInterface({ input: p.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise(r => { const id = ++n; pending.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const r = (await rpc('tools/call', { name, arguments: args })).result; const t = r.content[0].text; return { isError: !!r.isError, text: t, json: r.isError ? null : JSON.parse(t) }; };
  return { p, rpc, call, notify: (method) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), stop: () => p.kill(), stderr: () => stderr };
}
let pass = 0; const ok = (name, fn) => fn().then(() => { pass++; console.log('PASS', name); }, e => { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; });

// --- read-only server ---
const ro = start({});
await ok('initialize negotiates protocol + tools capability', async () => {
  const r = (await ro.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })).result;
  assert.equal(r.protocolVersion, '2025-06-18'); assert.ok(r.capabilities.tools); ro.notify('notifications/initialized');
});
await ok('tools/list exposes all tools with schemas', async () => {
  const t = (await ro.rpc('tools/list')).result.tools; assert.ok(t.length >= 17);
  for (const x of t) assert.ok(x.name && x.description && x.inputSchema.type === 'object');
});
await ok('connection status discovers IG id and permissions', async () => {
  const r = await ro.call('meta_connection_status'); assert.equal(r.json.instagram_user_id, 'IG1'); assert.deepEqual(r.json.permissions, ['instagram_basic']); assert.equal(r.json.writes_enabled, false);
});
await ok('profile + media list work; token sent in header not URL', async () => {
  assert.equal((await ro.call('ig_get_profile')).json.followers_count, 42);
  assert.equal((await ro.call('ig_list_media', { limit: 5 })).json.data[0].id, 'M1');
  assert.ok(seen.every(s => !JSON.stringify(s.q).includes(TOKEN)));
});
await ok('DM inbox uses the Page token', async () => {
  seen.length = 0; assert.equal((await ro.call('ig_list_conversations')).json.data[0].id, 'CV1'); const s = seen.find(x => x.path === 'me/conversations'); assert.equal(s.auth, 'Bearer PAGE_TOKEN'); assert.equal(s.q.platform, 'instagram');
});
await ok('writes are blocked by default and never reach Meta', async () => {
  seen.length = 0;
  for (const [n, a] of [['ig_reply_to_comment', { comment_id: 'CM1', message: 'x' }], ['ig_send_dm', { recipient_id: 'U1', text: 'x' }], ['ig_hide_comment', { comment_id: 'CM1' }], ['ig_publish_media', { type: 'IMAGE', media_url: 'https://e.com/a.jpg', confirm: true }]]) {
    const r = await ro.call(n, a); assert.ok(r.isError && /writes are disabled/.test(r.text), n);
  }
  assert.equal(seen.filter(s => s.method === 'POST').length, 0);
});
await ok('validation errors are clean tool errors', async () => {
  assert.match((await ro.call('ig_list_comments', {})).text, /Missing required argument: media_id/);
  assert.match((await ro.call('ig_publish_media', { type: 'GIF', media_url: 'x' })).text, /must be one of/);
  assert.match((await ro.call('ig_send_dm', { recipient_id: 'U', text: 'x', bogus: 1 })).text, /Unknown argument/);
});
await ok('calendar add/list/update persists', async () => {
  const a = (await ro.call('calendar_add', { title: 'Kitchen reel', date: '2026-11-01' })).json; assert.equal(a.status, 'Draft');
  assert.equal((await ro.call('calendar_update', { id: a.id, status: 'Approved' })).json.status, 'Approved');
  assert.equal((await ro.call('calendar_list', { status: 'Approved' })).json.length, 1);
  assert.match((await ro.call('calendar_update', { id: 'nope', status: 'Draft' })).text, /No calendar item/);
});
await ok('errors never leak the token', async () => {
  ro.stop(); const bad = start({ META_ACCESS_TOKEN: TOKEN + 'x' }); const r = await bad.call('ig_get_profile'); assert.ok(r.isError); assert.ok(!r.text.includes(TOKEN + 'x')); bad.stop();
});

// --- writes enabled ---
const rw = start({ META_ALLOW_WRITES: 'true', META_MAX_WRITES_PER_HOUR: '3' });
await rw.rpc('initialize', { protocolVersion: '2025-06-18' });
await ok('publish without confirm is a dry run', async () => {
  seen.length = 0; const r = await rw.call('ig_publish_media', { type: 'IMAGE', media_url: 'https://e.com/a.jpg', caption: 'c' }); assert.equal(r.json.dry_run, true); assert.equal(seen.length, 0);
});
await ok('publish rejects non-https media', async () => assert.match((await rw.call('ig_publish_media', { type: 'IMAGE', media_url: 'http://e.com/a.jpg', confirm: true })).text, /https/));
await ok('publish with confirm runs container → publish → permalink', async () => {
  const r = await rw.call('ig_publish_media', { type: 'IMAGE', media_url: 'https://e.com/a.jpg', caption: 'c', confirm: true }); assert.equal(r.json.media_id, 'M2'); assert.match(r.json.permalink, /instagram/);
});
await ok('reply + DM + private reply work; DM payload correct', async () => {
  seen.length = 0;
  assert.equal((await rw.call('ig_reply_to_comment', { comment_id: 'CM1', message: 'thanks' })).json.id, 'R1');
  assert.equal((await rw.call('ig_send_dm', { recipient_id: 'U1', text: 'hello' })).json.message_id, 'mid');
  const dm = seen.find(s => s.path === 'me/messages'); assert.deepEqual(dm.body, { recipient: { id: 'U1' }, message: { text: 'hello' } }); assert.equal(dm.auth, 'Bearer PAGE_TOKEN');
});
await ok('hourly write cap enforced (3 per hour)', async () => {
  const r = await rw.call('ig_reply_to_comment', { comment_id: 'CM1', message: 'again' }); assert.ok(r.isError); assert.match(r.text, /safety cap/);
});
await ok('rate-limit signal from Meta pauses all further calls', async () => {
  forceRateLimit = true; const a = await rw.call('ig_list_media'); assert.match(a.text, /error 4/); forceRateLimit = false; seen.length = 0;
  const b = await rw.call('ig_list_media'); assert.match(b.text, /Paused to protect/); assert.equal(seen.length, 0);
});
rw.stop(); mock.close(); rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed`);
