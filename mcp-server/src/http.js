#!/usr/bin/env node
// Remote MCP server: Streamable HTTP transport + single-owner OAuth 2.1 (PKCE, dynamic client registration).
// Lets claude.ai, ChatGPT (developer mode), Gemini Enterprise etc. connect to YOUR Meta account through YOUR server.
// Stateless: all codes/tokens are HMAC-signed, so there is no database. Rotate MCP_SIGNING_SECRET to revoke everything.
import http from 'node:http';
import { createHmac, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { MetaClient } from './meta.js';
import { buildTools } from './tools.js';
import { createMcp } from './core.js';

const env = process.env;
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/+$/, '');
const SECRET = env.MCP_SIGNING_SECRET || '';
const ADMIN_PW = env.MCP_ADMIN_PASSWORD || '';
const STATIC_BEARER = env.MCP_BEARER_TOKEN || '';
const PORT = Number(env.PORT || 8787);
const die = m => { console.error(`Config error: ${m}`); process.exit(1); };
if (!/^https?:\/\//.test(PUBLIC_URL)) die('PUBLIC_URL must be the public https URL of this server, e.g. https://my-mcp.onrender.com');
if (!PUBLIC_URL.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(PUBLIC_URL)) die('PUBLIC_URL must be https:// (http only allowed for localhost)');
if (SECRET.length < 32) die('MCP_SIGNING_SECRET must be at least 32 random characters (e.g. `openssl rand -hex 32`)');
if (ADMIN_PW.length < 12) die('MCP_ADMIN_PASSWORD must be at least 12 characters; you type it on the consent page when connecting an AI app');

const meta = new MetaClient();
const log = (...a) => console.error(meta.redact(a.join(' ')));
const handle = createMcp({ meta, tools: buildTools(meta), log });

// ---------- signed tokens ----------
const b64 = b => Buffer.from(b).toString('base64url');
const mac = s => createHmac('sha256', SECRET).update(s).digest();
const sign = o => { const p = b64(JSON.stringify(o)); return `${p}.${b64(mac(p))}`; };
function verify(tok, type) {
  if (typeof tok !== 'string') return null;
  const [p, s] = tok.split('.'); if (!p || !s) return null;
  const a = Buffer.from(s, 'base64url'), b = mac(p);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let o; try { o = JSON.parse(Buffer.from(p, 'base64url')); } catch { return null; }
  if (o.t !== type || (o.exp && o.exp < Date.now() / 1000)) return null;
  return o;
}
const safeEq = (x, y) => { const a = createHash('sha256').update(String(x)).digest(), b = createHash('sha256').update(String(y)).digest(); return timingSafeEqual(a, b); };
const now = () => Math.floor(Date.now() / 1000);
const usedCodes = new Set();

// ---------- helpers ----------
const MAX_BODY = 1_000_000;
const readBody = req => new Promise((res, rej) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > MAX_BODY) { rej(new Error('too large')); req.destroy(); } else c.push(d); }); req.on('end', () => res(Buffer.concat(c).toString('utf8'))); req.on('error', rej); });
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'" }); res.end(body); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseForm = t => Object.fromEntries(new URLSearchParams(t));
const redirectOk = u => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname)); } catch { return false; } };

const fails = new Map(); // ip -> {n, until}
function locked(ip) { const f = fails.get(ip); return f && f.until > Date.now() && f.n >= 5; }
function noteFail(ip) { const f = fails.get(ip) || { n: 0 }; f.n += 1; f.until = Date.now() + 15 * 60_000; fails.set(ip, f); }

const wwwAuth = `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`;
const resourceMeta = { resource: `${PUBLIC_URL}/mcp`, authorization_servers: [PUBLIC_URL], bearer_methods_supported: ['header'], scopes_supported: ['mcp'] };
const asMeta = { issuer: PUBLIC_URL, authorization_endpoint: `${PUBLIC_URL}/authorize`, token_endpoint: `${PUBLIC_URL}/token`, registration_endpoint: `${PUBLIC_URL}/register`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'] };

function authorized(req) {
  const h = req.headers.authorization || ''; const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok) return false;
  if (STATIC_BEARER && safeEq(tok, STATIC_BEARER)) return true;
  const o = verify(tok, 'at'); return !!o && o.aud === `${PUBLIC_URL}/mcp`;
}

function consentPage(p, error) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'scope', 'response_type'].map(k => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect AI to your Meta account</title>
<style>body{font:16px system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1rem;color:#111}input[type=password]{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box;margin:.4rem 0 1rem}button{padding:.7rem 1.2rem;font-size:1rem;cursor:pointer}.e{color:#b00020}.c{background:#f4f4f5;padding:.8rem;border-radius:.5rem}</style></head><body>
<h1>Connect an AI app</h1><p><b>${esc(p.client_name || 'An AI app')}</b> wants to use the Social Media Manager tools: read your Instagram/Facebook data${meta.allowWrites ? ' <b>and publish, reply and send messages</b>' : ''}.</p>
<p class="c">Only continue if you started this connection. Enter the owner password you set on your server.</p>${error ? `<p class="e">${esc(error)}</p>` : ''}
<form method="post" action="/authorize">${hidden}<label>Owner password<input type="password" name="password" autocomplete="current-password" required autofocus></label><button type="submit">Allow access</button></form></body></html>`;
}

async function oauth(req, res, url, ip) {
  const p = url.pathname;
  if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, resourceMeta), true;
  if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration') return json(res, 200, asMeta), true;

  if (p === '/register' && req.method === 'POST') {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid_client_metadata' }), true; }
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(redirectOk)) return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or localhost) URLs' }), true;
    const name = String(b.client_name || 'AI app').slice(0, 80);
    return json(res, 201, { client_id: sign({ t: 'client', ru: uris, n: name }), client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }), true;
  }

  if (p === '/authorize') {
    const q = req.method === 'POST' ? parseForm(await readBody(req)) : Object.fromEntries(url.searchParams);
    const client = verify(q.client_id, 'client');
    if (!client || !client.ru.includes(q.redirect_uri)) return html(res, 400, '<p>Invalid client or redirect_uri.</p>'), true; // never redirect to an unverified URI
    const back = (params) => { const u = new URL(q.redirect_uri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' }); res.end(); };
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type', ...(q.state && { state: q.state }) }), true;
    if (!q.code_challenge || (q.code_challenge_method && q.code_challenge_method !== 'S256')) return back({ error: 'invalid_request', error_description: 'PKCE S256 required', ...(q.state && { state: q.state }) }), true;
    const view = { ...q, client_name: client.n };
    if (req.method === 'GET') return html(res, 200, consentPage(view)), true;
    if (locked(ip)) return html(res, 429, consentPage(view, 'Too many wrong passwords. Try again in 15 minutes.')), true;
    if (!safeEq(q.password || '', ADMIN_PW)) { noteFail(ip); return html(res, 401, consentPage(view, 'Wrong password.')), true; }
    fails.delete(ip);
    const code = sign({ t: 'code', cid: q.client_id, ru: q.redirect_uri, cc: q.code_challenge, exp: now() + 300, jti: randomUUID() });
    return back({ code, ...(q.state && { state: q.state }) }), true;
  }

  if (p === '/token' && req.method === 'POST') {
    const raw = await readBody(req); let b; try { b = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : parseForm(raw); } catch { b = {}; }
    const bad = (error, d) => json(res, 400, { error, error_description: d });
    const issue = cid => json(res, 200, { access_token: sign({ t: 'at', aud: `${PUBLIC_URL}/mcp`, exp: now() + 3600 }), token_type: 'Bearer', expires_in: 3600, refresh_token: sign({ t: 'rt', cid, exp: now() + 30 * 86400 }), scope: 'mcp' });
    if (b.grant_type === 'authorization_code') {
      const c = verify(b.code, 'code');
      if (!c || usedCodes.has(c.jti) || c.cid !== b.client_id || c.ru !== b.redirect_uri) return bad('invalid_grant', 'Bad or expired code'), true;
      const challenge = createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
      if (!b.code_verifier || !safeEq(challenge, c.cc)) return bad('invalid_grant', 'PKCE verification failed'), true;
      usedCodes.add(c.jti); setTimeout(() => usedCodes.delete(c.jti), 600_000).unref();
      return issue(c.cid), true;
    }
    if (b.grant_type === 'refresh_token') {
      const r = verify(b.refresh_token, 'rt'); if (!r || (b.client_id && b.client_id !== r.cid)) return bad('invalid_grant', 'Bad or expired refresh token'), true;
      return issue(r.cid), true;
    }
    return bad('unsupported_grant_type'), true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',').pop().trim() || req.socket.remoteAddress || 'unknown';
  try {
    const url = new URL(req.url, PUBLIC_URL);
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, writes_enabled: meta.allowWrites });
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,mcp-protocol-version,mcp-session-id', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS' }); return res.end(); }
    if (await oauth(req, res, url, ip)) return;
    if (url.pathname === '/mcp') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': wwwAuth });
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' }, { allow: 'POST' });
      let msg; try { msg = JSON.parse(await readBody(req)); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const batch = Array.isArray(msg); const out = [];
      for (const m of batch ? msg : [msg]) { const r = await handle(m); if (r) out.push(r); }
      if (!out.length) { res.writeHead(202); return res.end(); }
      return json(res, 200, batch ? out : out[0]);
    }
    if (url.pathname === '/') return html(res, 200, '<p>Social Media Manager MCP server. Add <code>/mcp</code> to this URL in your AI app.</p>');
    json(res, 404, { error: 'not_found' });
  } catch (e) { log('http error', e.message); if (!res.headersSent) json(res, 500, { error: 'server_error' }); }
});
server.listen(PORT, () => log(`MCP HTTP server on :${PORT}  MCP URL: ${PUBLIC_URL}/mcp  (writes ${meta.allowWrites ? 'ENABLED' : 'disabled'})`));
