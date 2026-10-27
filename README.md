# Social Media Manager Toolkit

A lightweight, local-first dashboard for social media managers. Built with plain HTML, CSS, and JavaScript—no build step or paid API required.

## Features
- Content calendar and post tracker
- Caption, hook, hashtag, carousel, and Reel-script prompt builder
- Approval workflow (Draft → In Review → Approved → Scheduled → Published)
- Performance metrics tracker
- CSV export for posts
- Local browser storage (data stays in this browser unless you export it)

## Run locally
Open `index.html` in a modern browser. For best results, use a local static server:
```bash
python -m http.server 8000
```
Then open http://localhost:8000.

## Important
- This starter does **not** publish directly to Instagram.
- Real Instagram publishing requires a suitable Instagram Professional account, Meta app, permissions, access token, and API-compliant media hosting.
- Do not commit API tokens, client passwords, or private customer data.
- AI prompt builder copies prompts; it does not call an AI API by itself.

## AI / MCP access to Meta
The `mcp-server/` folder is an MCP server that gives AI assistants access to your Instagram/Facebook account via Meta's official Graph API (token-based, rate-limited, writes off by default). Runs locally (Claude Desktop/Code/Cursor) or hosted for Claude chat, ChatGPT and Gemini. See `mcp-server/README.md`.

## Suggested next steps
1. Add your clients/brands and customize platform options.
2. Connect an AI provider through a secure backend if you want one-click generation.
3. Add Meta Graph API publishing after credentials and permissions are configured.
4. Add authentication and a database before deploying for multiple users.
