# socialbridge-mcp

A remote **MCP (Model Context Protocol)** connector for [SocialBridge API](https://social-api-olive.vercel.app) — unified social-media data behind one `/v1` contract across nine networks (Instagram, TikTok, YouTube, Twitter/X, Reddit, Facebook, Pinterest, Snapchat, Threads; LinkedIn is registered but quarantined). Every network exposes the same four operations — `profile`, `posts`, `search`, `comments` — returning one flat schema (`Profile` / `Post` / `Comment`) tagged with `platform`, plus a cross-platform superset (`search_all`) and a few platform-specific extras.

**Live:** `https://socialbridge-mcp.vercel.app/mcp` — 10 tools. Since the upstream SocialBridge deployment is metered (RapidAPI/Apify) and gates every `/v1/*` route behind a RapidAPI proxy-secret guard, this connector authenticates its own outbound calls with that same secret (`SOCIALBRIDGE_MCP_PROXY_SECRET`, sent as the `X-RapidAPI-Proxy-Secret` header) and applies a soft per-IP rate limit (`SOCIALBRIDGE_MCP_RATE_LIMIT`, default 30 tool-calls/hour, in-memory) so the free MCP tier stays a discovery channel rather than an unmetered bypass of the paid listing — see `lib/ratelimit.js`.

## What this is, and why it's a separate connector

SocialBridge API is a plain REST API. Any HTTP client can already call it directly. This repo exists because **MCP clients (Claude, ChatGPT, and other MCP-aware agents) don't consume arbitrary REST APIs — they consume MCP tools.** `socialbridge-mcp` is a thin adapter layer that:

- Exposes each SocialBridge endpoint as a discoverable, typed MCP **tool** (name, description, zod input schema, annotations) that an LLM can reason about and call directly.
- Speaks the MCP **streamable-HTTP** transport at a single `/mcp` endpoint, so it registers as a connector in Claude, ChatGPT, or any other MCP client with one URL.
- Does nothing else. Every tool call is a pass-through `fetch` to SocialBridge, and the JSON response is handed back verbatim as the tool result.

## Authentication: None on the MCP side (deliberate)

SocialBridge's data has no per-user dimension — it's public social-media metadata (profiles, posts, search results, comments). There is nothing to gate per-caller, so this connector ships with no OAuth, no login, no Supabase, no billing, no demo-vs-real split — every caller gets the same real, live data. `api/mcp.js` builds a fresh, stateless `McpServer` per request.

> The connector still authenticates its own **outbound** calls to the metered upstream (see below) — that is a server-to-server detail invisible to MCP callers, not per-caller auth.

## Tools

One tool per real SocialBridge `/v1` route (from `social-api/openapi.yaml` + `src/routes.js`):

| Tool | SocialBridge endpoint | Description |
|---|---|---|
| `social_profile` | `GET /v1/{platform}/profile` | One account profile as the unified `Profile` schema. |
| `social_posts` | `GET /v1/{platform}/posts` | An account's recent posts as the unified `Post[]`. |
| `social_search` | `GET /v1/{platform}/search` | Search one network for posts (unified `Post[]`). |
| `social_comments` | `GET /v1/{platform}/comments` | Comments/replies on a post (unified `Comment[]`). |
| `search_all` | `GET /v1/search/all` | Fan one query across every network in parallel, merged. |
| `reddit_history` | `GET /v1/reddit/history` | Keyless Reddit full-history pull (Arctic Shift). |
| `facebook_ads` | `GET /v1/facebook/ads` | Meta Ad Library records as the unified `Ad[]` (gated). |
| `youtube_transcript` | `GET /v1/youtube/transcript` | Caption-language list / cue segments for a video. |
| `threads_post` | `GET /v1/threads/post` | A single thread by shortcode or URL, with replies. |
| `snapchat_spotlight` | `GET /v1/snapchat/spotlight` | A creator's public Spotlight feed (unified `Post[]`). |

`platform` is an enum of `instagram, tiktok, youtube, twitter, reddit, facebook, pinterest, snapchat, threads, linkedin`. Keyless platforms return real data with no setup; gated platforms return an honest `credentials_required` and LinkedIn returns `platform_disabled` — nothing is ever faked.

All 10 tools are read-only and annotated `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SOCIALBRIDGE_MCP_API_BASE_URL` | `https://social-api-olive.vercel.app` | Upstream SocialBridge base URL (override for local/self-hosted testing). |
| `SOCIALBRIDGE_MCP_PROXY_SECRET` | _(unset)_ | RapidAPI proxy secret, sent outbound as `X-RapidAPI-Proxy-Secret` to pass the upstream `/v1/*` guard. Without it the upstream returns `403` and tools surface it honestly. |
| `SOCIALBRIDGE_MCP_RATE_LIMIT` | `30` | Soft per-IP cap on `tools/call` per hour (in-memory, per serverless instance). |

This is a **free discovery tier** over the metered SocialBridge API — heavy users should go through the paid RapidAPI/Apify listings.

## How it wraps social-api

Each tool handler does a plain `fetch(\`${SOCIALBRIDGE_MCP_API_BASE_URL}${path}\`, ...)` (with the `X-RapidAPI-Proxy-Secret` header when configured) against the real SocialBridge REST API and returns the parsed JSON as MCP tool-result content:

```js
{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
```

Upstream HTTP errors (4xx/5xx) are caught and surfaced as a typed MCP error result via an `asError` helper rather than crashing the request.

## Local development

```bash
npm install
node local-server.js &                       # serves /mcp and /health on :3900
SOCIALBRIDGE_MCP_PROXY_SECRET=... npm run smoke   # real end-to-end smoke test
```
