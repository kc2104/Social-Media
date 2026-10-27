import { MetaError } from './meta.js';
import { CalendarStore, STATUSES } from './store.js';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const httpsUrl = (u, label) => { try { if (new URL(u).protocol !== 'https:') throw 0; } catch { throw new MetaError(`${label} must be a public https:// URL that Meta can fetch.`); } };
const lim = (n, d = 10, max = 50) => Math.min(Math.max(Number(n) || d, 1), max);

export function buildTools(meta, store = new CalendarStore(process.env.CALENDAR_FILE)) {
  const WRITE = '[WRITE – requires META_ALLOW_WRITES=true] ';
  const tools = [];
  const def = (name, description, inputSchema, handler, annotations = {}) => tools.push({ name, description, inputSchema, handler, annotations });

  // ---------- connection ----------
  def('meta_connection_status', 'Check that the Meta token works, which permissions it has, whether writes are enabled, and current API usage. Run this first.', obj(), async () => {
    meta.requireToken();
    const out = { writes_enabled: meta.allowWrites, graph: `${meta.base}/${meta.version}` };
    try { out.me = await meta.get('me', { fields: 'id,name' }); } catch (e) { out.me_error = e.message; }
    try { out.permissions = (await meta.get('me/permissions')).data?.filter(p => p.status === 'granted').map(p => p.permission); } catch { /* not available for all token types */ }
    try { out.instagram_user_id = await meta.igId(); } catch (e) { out.instagram_error = e.message; }
    out.app_usage = meta.usage; out.paused_until = meta.cooldownUntil > Date.now() ? new Date(meta.cooldownUntil).toISOString() : null;
    return out;
  }, { readOnlyHint: true });

  def('fb_list_pages', 'List Facebook Pages the token can manage, with their linked Instagram professional accounts.', obj(), async () => {
    const pages = await meta.pages();
    return pages.map(({ access_token, ...p }) => p);
  }, { readOnlyHint: true });

  // ---------- instagram read ----------
  def('ig_get_profile', 'Get the Instagram professional account profile: username, bio, followers, media count.', obj(), async () => {
    const id = await meta.igId();
    return meta.get(id, { fields: 'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url' });
  }, { readOnlyHint: true });

  def('ig_list_media', 'List recent Instagram posts/Reels with caption, permalink, like and comment counts.', obj({
    limit: int('How many items (1-50, default 10)'), after: str('Pagination cursor from a previous call')
  }), async ({ limit, after }) => {
    const id = await meta.igId();
    return meta.get(`${id}/media`, { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url', limit: lim(limit), after });
  }, { readOnlyHint: true });

  def('ig_get_media_insights', 'Get insights (reach, saves, shares, interactions…) for one post or Reel.', obj({
    media_id: str('Instagram media ID'), metrics: str('Comma-separated metrics. Default: reach,saved,shares,likes,comments,total_interactions')
  }, ['media_id']), ({ media_id, metrics }) =>
    meta.get(`${media_id}/insights`, { metric: metrics || 'reach,saved,shares,likes,comments,total_interactions' }), { readOnlyHint: true });

  def('ig_get_account_insights', 'Get account-level insights over a period (default: last 7 days totals).', obj({
    metrics: str('Comma-separated metrics. Default: reach,profile_views,accounts_engaged,total_interactions'),
    period: str('day (default)', { enum: ['day'] }), since: str('Start date YYYY-MM-DD'), until: str('End date YYYY-MM-DD')
  }), async ({ metrics, period, since, until }) => {
    const id = await meta.igId();
    return meta.get(`${id}/insights`, { metric: metrics || 'reach,profile_views,accounts_engaged,total_interactions', period: period || 'day', metric_type: 'total_value', since, until });
  }, { readOnlyHint: true });

  def('ig_list_comments', 'List comments on a post.', obj({ media_id: str('Instagram media ID'), limit: int('1-50, default 20'), after: str('Pagination cursor') }, ['media_id']),
    ({ media_id, limit, after }) => meta.get(`${media_id}/comments`, { fields: 'id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp}', limit: lim(limit, 20), after }), { readOnlyHint: true });

  def('ig_list_conversations', 'List recent Instagram DM conversations (inbox). Needs instagram_manage_messages.', obj({ limit: int('1-50, default 15'), after: str('Pagination cursor') }),
    async ({ limit, after }) => meta.get('me/conversations', { platform: 'instagram', fields: 'id,updated_time,participants', limit: lim(limit, 15), after }, await meta.messagingToken()), { readOnlyHint: true });

  def('ig_get_conversation_messages', 'Read the latest messages in one DM conversation.', obj({ conversation_id: str('Conversation ID'), limit: int('1-50, default 20') }, ['conversation_id']),
    async ({ conversation_id, limit }) => meta.get(`${conversation_id}`, { fields: `messages.limit(${lim(limit, 20)}){id,message,from,to,created_time}` }, await meta.messagingToken()), { readOnlyHint: true });

  def('ig_publishing_limit', 'Check how many API posts the account may still publish in the rolling 24h window.', obj(), async () => {
    const id = await meta.igId();
    return meta.get(`${id}/content_publishing_limit`, { fields: 'quota_usage,config' });
  }, { readOnlyHint: true });

  // ---------- instagram write ----------
  def('ig_reply_to_comment', WRITE + 'Publicly reply to a comment on your own post.', obj({ comment_id: str('Comment ID'), message: str('Reply text') }, ['comment_id', 'message']), async ({ comment_id, message }) => {
    meta.assertWriteAllowed('ig_reply_to_comment');
    const r = await meta.post(`${comment_id}/replies`, { message }); meta.noteWrite(); return r;
  }, { destructiveHint: false });

  def('ig_hide_comment', WRITE + 'Hide (or unhide) a comment on your own post.', obj({ comment_id: str('Comment ID'), hide: { type: 'boolean', description: 'true to hide (default), false to unhide' } }, ['comment_id']), async ({ comment_id, hide }) => {
    meta.assertWriteAllowed('ig_hide_comment');
    const r = await meta.post(comment_id, { hide: hide !== false }); meta.noteWrite(); return r;
  });

  def('ig_send_dm', WRITE + 'Reply to a person who has messaged you. Meta only allows this within 24 hours of THEIR last message (7 days with the human-agent tag); cold outreach is not possible through the API and this tool does not try to bypass that.',
    obj({ recipient_id: str('Instagram-scoped user ID of the person (from a conversation)'), text: str('Message text (max 1000 chars)', { maxLength: 1000 }) }, ['recipient_id', 'text']), async ({ recipient_id, text }) => {
      meta.assertWriteAllowed('ig_send_dm');
      const r = await meta.post('me/messages', { recipient: { id: recipient_id }, message: { text } }, await meta.messagingToken()); meta.noteWrite(); return r;
    });

  def('ig_private_reply_to_comment', WRITE + 'Send ONE private DM reply to a commenter (allowed within 7 days of the comment, one per comment).',
    obj({ comment_id: str('Comment ID'), text: str('Message text', { maxLength: 1000 }) }, ['comment_id', 'text']), async ({ comment_id, text }) => {
      meta.assertWriteAllowed('ig_private_reply_to_comment');
      const r = await meta.post('me/messages', { recipient: { comment_id }, message: { text } }, await meta.messagingToken()); meta.noteWrite(); return r;
    });

  def('ig_publish_media', WRITE + 'Publish an image or Reel to the Instagram professional account via the official Content Publishing API. Media must be at a public https URL. Without confirm=true it only previews what would be posted.', obj({
    type: str('IMAGE or REELS', { enum: ['IMAGE', 'REELS'] }), media_url: str('Public https URL of the image or video'),
    caption: str('Caption incl. hashtags (max 2200 chars)', { maxLength: 2200 }), share_to_feed: { type: 'boolean', description: 'Reels only: also show on the main grid (default true)' },
    confirm: { type: 'boolean', description: 'Must be true to actually publish' }
  }, ['type', 'media_url']), async ({ type, media_url, caption, share_to_feed, confirm }) => {
    httpsUrl(media_url, 'media_url');
    if (confirm !== true) return { dry_run: true, message: 'Not published. Call again with confirm=true after the user approves.', would_publish: { type, media_url, caption } };
    meta.assertWriteAllowed('ig_publish_media');
    const id = await meta.igId();
    const body = type === 'REELS' ? { media_type: 'REELS', video_url: media_url, caption, share_to_feed: share_to_feed !== false } : { image_url: media_url, caption };
    const container = await meta.post(`${id}/media`, body);
    const deadline = Date.now() + 5 * 60_000; let status = 'IN_PROGRESS';
    while (Date.now() < deadline) {
      const s = await meta.get(container.id, { fields: 'status_code,status' }); status = s.status_code;
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new MetaError(`Media processing failed: ${s.status || status}`);
      await new Promise(r => setTimeout(r, type === 'REELS' ? 5000 : 1500));
    }
    if (status !== 'FINISHED') return { published: false, creation_id: container.id, status, note: 'Still processing; call ig_publish_status later.' };
    const pub = await meta.post(`${id}/media_publish`, { creation_id: container.id }); meta.noteWrite();
    let permalink; try { permalink = (await meta.get(pub.id, { fields: 'permalink' })).permalink; } catch { /* optional */ }
    return { published: true, media_id: pub.id, permalink };
  });

  // ---------- local content calendar ----------
  const postProps = {
    title: str('Content title'), platform: str('Instagram, Facebook, LinkedIn…'), format: str('Reel, Post, Carousel, Story…'),
    date: str('Planned date YYYY-MM-DD'), status: str('Workflow status', { enum: STATUSES }), notes: str('Caption / script / notes')
  };
  def('calendar_list', 'List items in the local content calendar (the toolkit\'s Draft → Published workflow).', obj({ status: str('Filter by status', { enum: STATUSES }), from: str('From date'), to: str('To date') }), a => store.list(a), { readOnlyHint: true });
  def('calendar_add', 'Add a content item to the local content calendar.', obj(postProps, ['title', 'date']), a => store.add(a));
  def('calendar_update', 'Update a calendar item (e.g. move it to Approved or Published).', obj({ id: str('Item id'), ...postProps }, ['id']), ({ id, ...patch }) => store.update(id, patch));

  return tools;
}

export function validate(schema, args = {}) {
  for (const k of schema.required || []) if (args[k] === undefined || args[k] === null || args[k] === '') throw new MetaError(`Missing required argument: ${k}`);
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties?.[k];
    if (!p) throw new MetaError(`Unknown argument: ${k}`);
    if (p.type === 'string' && typeof v !== 'string') throw new MetaError(`${k} must be a string`);
    if (p.type === 'integer' && !Number.isInteger(v)) throw new MetaError(`${k} must be an integer`);
    if (p.type === 'boolean' && typeof v !== 'boolean') throw new MetaError(`${k} must be a boolean`);
    if (p.enum && !p.enum.includes(v)) throw new MetaError(`${k} must be one of: ${p.enum.join(', ')}`);
    if (p.maxLength && typeof v === 'string' && v.length > p.maxLength) throw new MetaError(`${k} is longer than ${p.maxLength} characters`);
  }
}
