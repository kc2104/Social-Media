// Minimal, polite client for Meta's official Graph API.
// Principles: official endpoints only, token in Authorization header, serialized requests,
// minimum spacing between calls, no retry storms, automatic cool-down on rate-limit signals.

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);

export class MetaError extends Error {
  constructor(message, { status, code, subcode, type, fbtrace } = {}) {
    super(message);
    this.name = 'MetaError';
    Object.assign(this, { status, code, subcode, type, fbtrace });
  }
}

export class MetaClient {
  constructor(env = process.env) {
    this.token = (env.META_ACCESS_TOKEN || '').trim();
    this.base = (env.META_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');
    this.version = env.META_GRAPH_VERSION || 'v23.0';
    this.igUserId = (env.META_IG_USER_ID || '').trim();
    this.pageId = (env.META_PAGE_ID || '').trim();
    this.allowWrites = env.META_ALLOW_WRITES === 'true';
    this.maxWritesPerHour = Number(env.META_MAX_WRITES_PER_HOUR || 30);
    this.minInterval = Number(env.META_MIN_INTERVAL_MS || 300);
    this.writeLog = [];
    this.cooldownUntil = 0;
    this.lastCall = 0;
    this.queue = Promise.resolve();
    this.usage = null;
    this._pages = null;
  }

  redact(s) {
    let out = String(s);
    if (this.token) out = out.split(this.token).join('***');
    return out;
  }

  requireToken() {
    if (!this.token) throw new MetaError('META_ACCESS_TOKEN is not set. Create a Meta app, generate an access token, and put it in the MCP server environment (see README).');
  }

  assertWriteAllowed(label) {
    if (!this.allowWrites) throw new MetaError(`"${label}" is a write action and writes are disabled. Set META_ALLOW_WRITES=true in the MCP server environment to enable.`);
    const cutoff = Date.now() - 3600_000;
    this.writeLog = this.writeLog.filter(t => t > cutoff);
    if (this.writeLog.length >= this.maxWritesPerHour) throw new MetaError(`Local safety cap reached: ${this.maxWritesPerHour} write actions in the last hour. Try again later or raise META_MAX_WRITES_PER_HOUR.`);
  }
  noteWrite() { this.writeLog.push(Date.now()); }

  // Serialize all calls and keep a minimum gap between them.
  request(method, path, { params = {}, body, token } = {}) {
    const run = async () => {
      this.requireToken();
      if (Date.now() < this.cooldownUntil) {
        const mins = Math.ceil((this.cooldownUntil - Date.now()) / 60000);
        throw new MetaError(`Paused to protect the account: Meta signalled rate limiting. Retry in about ${mins} min.`, { status: 429 });
      }
      const wait = this.lastCall + this.minInterval - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      const url = new URL(path.startsWith('http') ? path : `${this.base}/${this.version}/${path.replace(/^\/+/, '')}`);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      const headers = { Authorization: `Bearer ${token || this.token}`, Accept: 'application/json', 'User-Agent': 'social-media-manager-mcp/1.0' };
      const init = { method, headers, signal: AbortSignal.timeout(30000) };
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
      this.lastCall = Date.now();
      let res;
      try { res = await fetch(url, init); }
      catch (e) { throw new MetaError(this.redact(`Network error talking to Meta: ${e.message}`)); }
      this.trackUsage(res.headers);
      const text = await res.text();
      let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!res.ok || json.error) {
        const e = json.error || {};
        if (RATE_LIMIT_CODES.has(e.code) || res.status === 429) this.cooldownUntil = Date.now() + 15 * 60_000;
        throw new MetaError(this.redact(`Meta API error${e.code ? ` ${e.code}` : ''}: ${e.message || res.statusText}`), { status: res.status, code: e.code, subcode: e.error_subcode, type: e.type, fbtrace: e.fbtrace_id });
      }
      return json;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  trackUsage(h) {
    const raw = h.get('x-app-usage') || h.get('x-business-use-case-usage');
    if (!raw) return;
    try {
      this.usage = JSON.parse(raw);
      const flat = JSON.stringify(this.usage);
      const nums = [...flat.matchAll(/"(call_count|total_time|total_cputime)":(\d+)/g)].map(m => Number(m[2]));
      if (nums.some(n => n >= 85)) this.cooldownUntil = Date.now() + 10 * 60_000; // back off before Meta has to ask
    } catch { /* ignore */ }
  }

  get(path, params, token) { return this.request('GET', path, { params, token }); }
  post(path, body, token) { return this.request('POST', path, { body, token }); }

  async pages() {
    if (this._pages) return this._pages;
    try {
      const r = await this.get('me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 50 });
      this._pages = r.data || [];
    } catch { this._pages = []; } // Page tokens / Instagram-Login tokens cannot list pages
    return this._pages;
  }

  async pick() {
    const pages = await this.pages();
    if (this.pageId) return pages.find(p => p.id === this.pageId) || null;
    return pages.find(p => p.instagram_business_account) || pages[0] || null;
  }

  async igId() {
    if (this.igUserId) return this.igUserId;
    const p = await this.pick();
    const id = p?.instagram_business_account?.id;
    if (id) return (this.igUserId = id);
    try { const me = await this.get('me', { fields: 'id' }); if (me.id) return (this.igUserId = me.id); } catch { /* fallthrough */ }
    throw new MetaError('Could not determine the Instagram professional account ID. Set META_IG_USER_ID, or link the Instagram account to a Facebook Page your token can access.');
  }

  // Messaging endpoints need a Page token (Facebook Login) or the IG token itself (Instagram Login).
  async messagingToken() { const p = await this.pick(); return p?.access_token || this.token; }
}
