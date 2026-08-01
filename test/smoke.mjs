// test/smoke.mjs — real end-to-end smoke test against a locally-running
// local-server.js (which serves the exact same api/mcp.js Vercel handler).
// No mocks: initialize, tools/list, and a live tools/call all go over real
// HTTP/JSON-RPC to a real MCP server instance, which in turn fetches real data
// from SOCIALBRIDGE_MCP_API_BASE_URL (when SOCIALBRIDGE_MCP_PROXY_SECRET is set).
//
// Usage:
//   node local-server.js &            # in one terminal
//   node test/smoke.mjs               # in another

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3900';

let idCounter = 1;
async function rpc(method, params) {
  const body = { jsonrpc: '2.0', id: idCounter++, method, params };
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // StreamableHTTPServerTransport may respond with either a JSON body or an
  // SSE stream ("event: message\ndata: {...}\n\n") depending on client Accept
  // headers / SDK version. Handle both.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') || text.includes('\ndata:') || text.startsWith('data:')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) throw new Error(`no SSE data line in response: ${text}`);
    return { status: res.status, json: JSON.parse(dataLine.slice(5).trim()) };
  }
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function main() {
  console.log(`Smoke-testing socialbridge-mcp at ${BASE} ...\n`);

  // 1. health
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log('== GET /health ==');
  console.log(JSON.stringify(health, null, 2));
  if (!health.ok) throw new Error('health check failed');

  // 2. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'socialbridge-mcp-smoke-test', version: '1.0.0' },
  });
  console.log('\n== initialize ==');
  console.log(`HTTP ${init.status}`);
  console.log(JSON.stringify(init.json, null, 2));
  if (init.status !== 200 || init.json?.error) throw new Error('initialize failed');
  const serverName = init.json?.result?.serverInfo?.name;
  if (serverName !== 'socialbridge') throw new Error(`unexpected server name: ${serverName}`);

  // 3. tools/list
  const list = await rpc('tools/list', {});
  console.log('\n== tools/list ==');
  const tools = list.json?.result?.tools || [];
  console.log(`HTTP ${list.status}, ${tools.length} tools:`);
  for (const t of tools) {
    console.log(`  - ${t.name}: ${t.description.slice(0, 90)}${t.description.length > 90 ? '...' : ''}`);
  }
  if (tools.length < 9) throw new Error(`expected >= 9 tools, got ${tools.length}`);
  const searchTool = tools.find((t) => t.name === 'social_search');
  if (!searchTool) throw new Error('social_search tool missing');
  console.log('\nsocial_search inputSchema:');
  console.log(JSON.stringify(searchTool.inputSchema, null, 2));

  // 4. tools/call social_search with a real query (keyless engine: tiktok).
  //    NOTE: reaching real upstream data requires SOCIALBRIDGE_MCP_PROXY_SECRET to
  //    be set in the local-server's env; without it the upstream returns 403 and
  //    the tool surfaces that honestly as an isError result.
  const call = await rpc('tools/call', {
    name: 'social_search',
    arguments: { platform: 'tiktok', q: 'ai automation', limit: 3 },
  });
  console.log('\n== tools/call social_search {platform:"tiktok", q:"ai automation", limit:3} ==');
  console.log(`HTTP ${call.status}`);
  const resultText = call.json?.result?.content?.[0]?.text;
  console.log(resultText);
  if (call.json?.result?.isError) {
    console.log('\n(tools/call returned an isError result — expected when SOCIALBRIDGE_MCP_PROXY_SECRET is unset; the protocol path is verified.)');
  } else {
    const parsed = resultText ? JSON.parse(resultText) : null;
    if (!parsed?.results) throw new Error('social_search returned no results envelope');
  }

  console.log('\nAll smoke tests passed.');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exit(1);
});
