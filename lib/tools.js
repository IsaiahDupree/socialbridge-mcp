// MCP tools use an explicitly configured upstream and preserve their input/output contracts.

import { z } from 'zod';
import { upstreamConfig } from './config.js';

const PROXY_SECRET = process.env.SOCIALBRIDGE_MCP_PROXY_SECRET || '';

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const asError = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }],
});

// Every SocialBridge tool only reads public social-media data — never writes,
// never touches a caller's account (there is no account). openWorldHint is true
// because the underlying data comes from the live social networks (an open,
// changing world outside this server's control).
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// The ten networks SocialBridge speaks to. LinkedIn is registered but quarantined
// (returns platform_disabled unless the operator self-hosts with it enabled).
const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'twitter', 'reddit', 'facebook', 'pinterest', 'snapchat', 'threads', 'linkedin'];

function buildUrl(path, params = {}) {
  const config = upstreamConfig();
  if (!config.ok) throw new Error(`SocialBridge upstream unavailable (${config.reason}).`);
  const url = new URL(config.baseUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function callUpstream(path, params) {
  const url = buildUrl(path, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  let res;
  let text;
  try {
    const headers = { accept: 'application/json' };
    if (PROXY_SECRET) headers['X-RapidAPI-Proxy-Secret'] = PROXY_SECRET;
    res = await fetch(url, { headers, signal: controller.signal, redirect: 'error' });
    text = await res.text();
  } catch (e) {
    throw new Error(`SocialBridge API request failed (${url.pathname}${url.search}): ${e.message || e}`);
  } finally {
    clearTimeout(timeout);
  }

  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const message = body?.error?.message || `SocialBridge API returned HTTP ${res.status} for ${url.pathname}${url.search}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Wraps a (args) => { path, params } mapper into an MCP tool handler that calls
// SocialBridge and returns the JSON as tool-result content, or a typed error.
function forward(tool, mapper) {
  return async (args = {}) => {
    try {
      const allowed = new Set((process.env.SOCIALBRIDGE_MCP_ALLOWED_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean));
      if (!allowed.has(tool)) throw new Error(`SocialBridge tool ${tool} is disabled by the operator.`);
      const { path, params } = mapper(args);
      return asText(await callUpstream(path, params));
    } catch (err) {
      return asError(err);
    }
  };
}

export function registerTools(server) {
  // ── Core operation 1/4: profile ──────────────────────────────────────────────
  server.registerTool(
    'social_profile',
    {
      title: 'Get a social profile',
      description:
        'Fetch one account profile from any supported network as the unified Profile schema (id, username, displayName, bio, url, followers, following, postCount, verified, avatarUrl, externalUrl), tagged with its platform. Keyless on Instagram, TikTok, YouTube, Pinterest, Snapchat, and Threads. Twitter/X, Reddit, and Facebook need operator-side credentials (returns credentials_required until set); LinkedIn is quarantined (platform_disabled).',
      inputSchema: {
        platform: z.enum(PLATFORMS).describe('Target social network.'),
        username: z.string().describe('Account handle / username (without @).'),
      },
      annotations: RO,
    },
    forward('social_profile', ({ platform, username }) => ({
      path: `/v1/${platform}/profile`,
      params: { username },
    }))
  );

  // ── Core operation 2/4: posts ────────────────────────────────────────────────
  server.registerTool(
    'social_posts',
    {
      title: "Get an account's recent posts",
      description:
        "An account's recent posts / videos / tweets / threads / pins as the unified Post[] schema (id, url, author, text, createdAt, like/comment/share/view counts, mediaType, mediaUrls, hashtags), tagged with its platform. Keyless on Instagram, TikTok, YouTube, Pinterest, Snapchat, and Threads. Twitter/X, Reddit, and Facebook need operator-side credentials; LinkedIn is quarantined. For a keyless Reddit history pull use reddit_history.",
      inputSchema: {
        platform: z.enum(PLATFORMS).describe('Target social network.'),
        username: z.string().describe('Account handle / username (without @).'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results, clamped 1-100. Default 20.'),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous response (where the platform supports paging).'),
      },
      annotations: RO,
    },
    forward('social_posts', ({ platform, username, limit, cursor }) => ({
      path: `/v1/${platform}/posts`,
      params: { username, limit, cursor },
    }))
  );

  // ── Core operation 3/4: search ───────────────────────────────────────────────
  server.registerTool(
    'social_search',
    {
      title: 'Search one network for posts',
      description:
        'Search a single network for posts matching a query, returned as the unified Post[] schema and tagged with its platform. Keyless on TikTok, YouTube, and Pinterest. Instagram, Twitter/X, Reddit, and Facebook need operator-side credentials (returns credentials_required until set). Snapchat and Threads do not support keyless search (returns not_supported); LinkedIn is quarantined. To fan one query across every network at once, use search_all.',
      inputSchema: {
        platform: z.enum(PLATFORMS).describe('Target social network.'),
        q: z.string().describe('Search query.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results, clamped 1-100. Default 20.'),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous response (where the platform supports paging).'),
      },
      annotations: RO,
    },
    forward('social_search', ({ platform, q, limit, cursor }) => ({
      path: `/v1/${platform}/search`,
      params: { q, limit, cursor },
    }))
  );

  // ── Core operation 4/4: comments ─────────────────────────────────────────────
  server.registerTool(
    'social_comments',
    {
      title: 'Get comments / replies on a post',
      description:
        'Comments / replies on one post as the unified Comment[] schema, tagged with its platform. Provide url OR postId. Keyless on TikTok, YouTube, and Threads (and a single tweet via syndication on Twitter/X). Instagram, Reddit, and Facebook need operator-side credentials; Snapchat comments are not supported keyless; LinkedIn is quarantined.',
      inputSchema: {
        platform: z.enum(PLATFORMS).describe('Target social network.'),
        url: z.string().optional().describe('Post URL. Provide url OR postId.'),
        postId: z.string().optional().describe('Platform-native post id. Provide url OR postId.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results, clamped 1-100. Default 20.'),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous response (where the platform supports paging).'),
      },
      annotations: RO,
    },
    forward('social_comments', ({ platform, url, postId, limit, cursor }) => ({
      path: `/v1/${platform}/comments`,
      params: { url, postId, limit, cursor },
    }))
  );

  // ── Cross-platform superset ──────────────────────────────────────────────────
  server.registerTool(
    'search_all',
    {
      title: 'Search every network at once',
      description:
        'The wedge no incumbent offers: fan one search query out across the requested platforms (default: all keyless, non-disabled) in parallel, merge the unified Post[], and tag each result with its platform. Gated / disabled / unsupported / throttled engines are listed under "skipped" with an honest reason — the call still returns whatever came back.',
      inputSchema: {
        q: z.string().describe('Search query.'),
        platforms: z.string().optional().describe('Comma-separated subset of platforms to query (e.g. "tiktok,youtube,threads"). Omit for all keyless, non-disabled platforms.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results, clamped 1-50. Default 10.'),
      },
      annotations: RO,
    },
    forward('search_all', ({ q, platforms, limit }) => ({
      path: '/v1/search/all',
      params: { q, platforms, limit },
    }))
  );

  // ── Extra: Reddit full history (keyless) ─────────────────────────────────────
  server.registerTool(
    'reddit_history',
    {
      title: 'Reddit full history (keyless)',
      description:
        "Keyless full-history pull via Arctic Shift — a user's or subreddit's posts, or a keyword search across Reddit history, returned as the unified Post[]. Provide at least one of username, subreddit, or q. Optional before/after bound the window by epoch-seconds or ISO timestamp.",
      inputSchema: {
        username: z.string().optional().describe('Reddit username (without u/).'),
        subreddit: z.string().optional().describe('Subreddit (without r/).'),
        q: z.string().optional().describe('Keyword to search across history.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results, clamped 1-100. Default 25.'),
        before: z.string().optional().describe('Return items created before this epoch-seconds / ISO timestamp.'),
        after: z.string().optional().describe('Return items created after this epoch-seconds / ISO timestamp.'),
      },
      annotations: RO,
    },
    forward('reddit_history', ({ username, subreddit, q, limit, before, after }) => ({
      path: '/v1/reddit/history',
      params: { username, subreddit, q, limit, before, after },
    }))
  );

  // ── Extra: Facebook / Meta Ad Library ────────────────────────────────────────
  server.registerTool(
    'facebook_ads',
    {
      title: 'Facebook / Meta Ad Library',
      description:
        'Meta (Facebook/Instagram) Ad Library records as the unified Ad[] (id, pageName, adCreativeBody, adSnapshotUrl, startDate, currency, spend + impression ranges). Provide q OR pageId. GATED — needs operator-side FACEBOOK_ACCESS_TOKEN (with ads_read); returns credentials_required until set.',
      inputSchema: {
        q: z.string().optional().describe('Free-text search across ad creative. Provide q OR pageId.'),
        pageId: z.string().optional().describe('Advertiser Page id. Provide q OR pageId.'),
        country: z.string().optional().describe('ISO-3166 alpha-2 country (upper-cased server-side). Default US.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results, clamped 1-100. Default 25.'),
      },
      annotations: RO,
    },
    forward('facebook_ads', ({ q, pageId, country, limit }) => ({
      path: '/v1/facebook/ads',
      params: { q, pageId, country, limit },
    }))
  );

  // ── Extra: YouTube transcript / caption languages ────────────────────────────
  server.registerTool(
    'youtube_transcript',
    {
      title: 'YouTube transcript / caption languages',
      description:
        'Available caption-language list (and cue segments where retrievable) for a YouTube video. Provide url OR videoId. Keyless. NOTE: actual cue text is BotGuard-gated keyless, so it is reported honestly (available:false, empty segments) rather than fabricated.',
      inputSchema: {
        url: z.string().optional().describe('YouTube watch URL. Provide url OR videoId.'),
        videoId: z.string().optional().describe('11-char video id. Provide url OR videoId.'),
        lang: z.string().optional().describe('Preferred caption language (BCP-47, e.g. "en").'),
      },
      annotations: RO,
    },
    forward('youtube_transcript', ({ url, videoId, lang }) => ({
      path: '/v1/youtube/transcript',
      params: { url, videoId, lang },
    }))
  );

  // ── Extra: Threads one post by shortcode ─────────────────────────────────────
  server.registerTool(
    'threads_post',
    {
      title: 'Threads post by shortcode',
      description:
        'Fetch a single thread by shortcode or URL, including its replies, as the unified Post (with replies). Provide code OR url. Keyless.',
      inputSchema: {
        code: z.string().optional().describe('Thread shortcode. Provide code OR url.'),
        url: z.string().optional().describe('Full thread URL. Provide code OR url.'),
      },
      annotations: RO,
    },
    forward('threads_post', ({ code, url }) => ({
      path: '/v1/threads/post',
      params: { code, url },
    }))
  );

  // ── Extra: Snapchat creator Spotlight feed ───────────────────────────────────
  server.registerTool(
    'snapchat_spotlight',
    {
      title: 'Snapchat creator Spotlight feed',
      description:
        "A creator's public Snapchat Spotlight feed as the unified Post[] with real view/comment/share counts. Keyless.",
      inputSchema: {
        username: z.string().optional().describe('Account handle / username (without @).'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results, clamped 1-50. Default 20.'),
      },
      annotations: RO,
    },
    forward('snapchat_spotlight', ({ username, limit }) => ({
      path: '/v1/snapchat/spotlight',
      params: { username, limit },
    }))
  );
}

export function upstreamStatus() {
  const config = upstreamConfig();
  return config.ok ? { configured: true, kind: config.kind, baseUrl: config.baseUrl } : { configured: false, reason: config.reason };
}
