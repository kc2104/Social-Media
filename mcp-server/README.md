# Social Media Manager MCP server

Lets an AI assistant (Claude Desktop, Claude Code, Cursor, any MCP client) work with your Instagram / Facebook
Page through **Meta's official Graph API**, plus your toolkit's content calendar.

- Zero dependencies, Node 18+ (no `npm install`).
- Runs on your machine over stdio. Your token never goes to the AI, only to graph.facebook.com.

## Why this won't get you blocked
Meta blocks **automation that pretends to be a person** (scraped logins, headless browsers, unofficial APIs,
cookie/session reuse). This server does none of that:

| Does | Doesn't |
|---|---|
| Uses a token from **your own Meta app** (official OAuth) | Log in with your password or cookies |
| Calls only documented Graph API endpoints | Scrape or drive instagram.com |
| Spaces requests, stops for 15 min on any rate-limit signal | Retry in a loop or rotate IPs/accounts |
| Caps writes (default 30/hour), writes OFF by default | Send bulk or cold DMs (the API itself forbids it) |
| Publishes only after an explicit `confirm=true` | Hide that it is automated |

Staying compliant is still on you: keep to Meta's Platform Terms, don't spam, and only message people who
contacted you.

## One-time Meta setup
1. Convert the Instagram account to **Professional** (Business/Creator) and link it to a **Facebook Page**.
2. At developers.facebook.com create an app (type **Business**), add **Instagram** + **Facebook Login for Business**
   (or "Instagram API with Instagram Login").
3. Generate a token for your own account in the app's Graph API Explorer with the permissions you need:
   - read: `instagram_basic`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`
   - comments: `instagram_manage_comments`
   - DMs: `instagram_manage_messages`, `pages_messaging`
   - publish: `instagram_content_publish`
4. Exchange it for a **long-lived** token (60 days) and refresh before it expires.
5. While the app is in **Development mode** you can use all of this on accounts that have a role on the app,
   no App Review needed. App Review is only required to serve *other people's* accounts.

## Connect it to your AI
Claude Desktop (`claude_desktop_config.json`) / Cursor (`mcp.json`):
```json
{
  "mcpServers": {
    "social-media-manager": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/social-media-manager-toolkit/mcp-server/src/index.js"],
      "env": {
        "META_ACCESS_TOKEN": "paste-your-token",
        "META_ALLOW_WRITES": "false",
        "CALENDAR_FILE": "/ABSOLUTE/PATH/social-media-manager-toolkit/mcp-server/data/calendar.json"
      }
    }
  }
}
```
Claude Code: `claude mcp add social-media-manager -e META_ACCESS_TOKEN=... -- node /ABSOLUTE/PATH/mcp-server/src/index.js`

Start read-only. When you trust it, set `META_ALLOW_WRITES` to `true`. All options are in `.env.example`.

## Tools
| Tool | Type |
|---|---|
| `meta_connection_status`, `fb_list_pages` | read |
| `ig_get_profile`, `ig_list_media`, `ig_get_media_insights`, `ig_get_account_insights`, `ig_publishing_limit` | read |
| `ig_list_comments`, `ig_list_conversations`, `ig_get_conversation_messages` | read |
| `ig_reply_to_comment`, `ig_hide_comment` | write |
| `ig_send_dm` (reply within Meta's 24 h window), `ig_private_reply_to_comment` (one per comment, 7 days) | write |
| `ig_publish_media` (image / Reel, dry-run unless `confirm=true`) | write |
| `calendar_list`, `calendar_add`, `calendar_update` | local file |

Example prompts: "Summarise how my last 10 posts performed", "Draft replies to unanswered comments on my latest Reel
and show me before sending", "Add 3 Reel ideas for next week to the calendar as Draft".

## Test
`npm test` runs 15 end-to-end checks (real stdio server vs. a mock Graph API): write guard, dry-run publish,
rate-limit pause, write cap, token redaction, calendar.

## Notes
- Meta changes metric names and API versions; set `META_GRAPH_VERSION` and pass `metrics` explicitly if a metric is rejected.
- Not yet covered: carousels, Stories, Facebook Page posting, hashtag search.
