# SocialBridge MCP

A stateless streamable-HTTP MCP adapter for the existing SocialBridge API. It retains the ten existing tool names and input/output contracts. The adapter does not start a scheduler; a call can cause the API to use network services, including a paid proxy or third-party services.

## Spending and access defaults

- Every MCP POST requires a bearer token in `SOCIALBRIDGE_MCP_CLIENT_TOKEN`. It must be at least 32 bytes. With no valid server token the endpoint returns 503; missing or incorrect caller tokens return 401. Health is an unauthenticated liveness/configuration endpoint and does not call the upstream.
- No tools may execute by default. `SOCIALBRIDGE_MCP_ALLOWED_TOOLS` is a comma-separated list of the exact enabled tool names. Tool discovery remains available to authenticated clients; disabled calls return an MCP error without contacting the API.
- `SOCIALBRIDGE_MCP_API_BASE_URL` must be configured. Only `http://127.0.0.1`, `http://localhost`, or `http://[::1]` (with an optional port), or HTTPS equivalents, are accepted by default. Remote upstreams require HTTPS and `SOCIALBRIDGE_MCP_ALLOW_REMOTE_UPSTREAM=1`. Redirects are refused. No cloud workload is authorized merely by these switches; enable a remote endpoint or tool only for the owner's explicitly authorized workload and expense.
- `SOCIALBRIDGE_MCP_PROXY_SECRET` is forwarded only to the configured upstream as the upstream API's RapidAPI proxy header. The MCP caller token and this upstream credential are different secrets. Never put either in source control or logs.
- The local development server binds to `127.0.0.1`. The existing in-memory rate limit remains best-effort per instance and is not a billing cap or a substitute for authentication.

A local upstream is not automatically free: SocialBridge API can call external social platforms or a configured paid proxy; `search_all` may fan out across several sources. Its own provider credentials and all downstream actions must be governed separately. This connector's configuration cannot limit direct API clients or guarantee a dollar cap. Existing public clients will need a token after this change; hosted deployment and its compatibility are not yet verified.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SOCIALBRIDGE_MCP_CLIENT_TOKEN` | unset | Owner-provisioned bearer, at least 32 bytes |
| `SOCIALBRIDGE_MCP_API_BASE_URL` | unset | Explicit SocialBridge API origin; loopback by default |
| `SOCIALBRIDGE_MCP_ALLOWED_TOOLS` | unset | Comma-separated enabled tool names |
| `SOCIALBRIDGE_MCP_ALLOW_REMOTE_UPSTREAM` | unset | `1` permits an HTTPS non-loopback upstream after separate authorization |
| `SOCIALBRIDGE_MCP_PROXY_SECRET` | unset | Separate upstream proxy credential |
| `SOCIALBRIDGE_MCP_RATE_LIMIT` | `30` | Best-effort tool calls per IP per hour per instance |
| `PORT` | `3900` | Local loopback listener port |

Use a securely generated secret through the local environment or secret manager, never as a command-line argument. The live-lookup smoke test requires the token and `SMOKE_ALLOW_REAL_LOOKUP=1`; it makes a real upstream request and must only be run for an explicitly authorized workload. Run `SOCIAL_API_ROOT=/path/to/social-api npm run check:local` to start the actual local API with provider keys absent and verify its quarantined LinkedIn response without a remote lookup. The test uses random temporary credentials and stops its child processes.

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

`platform` is an enum of `instagram, tiktok, youtube, twitter, reddit, facebook, pinterest, snapchat, threads, linkedin`. After access and the individual tool are enabled, platform availability still depends on the upstream. Credential-gated platforms can return `credentials_required`; LinkedIn is quarantined and returns `platform_disabled` by default.

All 10 tools are read-only and annotated `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.
