import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_REVISION_CURRENT,
  MCP_REVISION_LEGACY,
  McpAuthorizationRequiredError,
  McpTransportError,
  StreamableHttpTransport,
  normalizeMcpEndpoint,
  parseBearerChallenge,
} from '../extension/mcp/streamable-http.js';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

test('MCP endpoints are HTTPS-only and reject embedded credentials', () => {
  assert.equal(normalizeMcpEndpoint('https://mcp.example.test/mcp'), 'https://mcp.example.test/mcp');
  assert.throws(
    () => normalizeMcpEndpoint('http://mcp.example.test/mcp'),
    (error) => error instanceof McpTransportError && error.code === 'INSECURE_ENDPOINT',
  );
  assert.throws(
    () => normalizeMcpEndpoint('https://user:fake@mcp.example.test/mcp'),
    (error) => error instanceof McpTransportError && error.code === 'ENDPOINT_CREDENTIALS',
  );
});

test('parses bounded Bearer authorization challenge metadata', () => {
  const challenge = parseBearerChallenge(
    'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", scope="files:read files:write", error="insufficient_scope"',
  );

  assert.equal(
    challenge.resourceMetadataUrl,
    'https://mcp.example.test/.well-known/oauth-protected-resource',
  );
  assert.deepEqual(challenge.scopes, ['files:read', 'files:write']);
  assert.equal(challenge.oauthError, 'insufficient_scope');
});

test('current MCP revision sends stateless envelope and routing headers', async () => {
  const seen = [];
  const transport = new StreamableHttpTransport({
    endpoint: 'https://mcp.example.test/mcp',
    revision: MCP_REVISION_CURRENT,
    accessTokenProvider: async () => 'fake_access_token_for_test_only',
    fetchImpl: async (url, init) => {
      seen.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [] },
      });
    },
  });

  await transport.connect();
  const result = await transport.request('tools/list', {});
  assert.deepEqual(result, { tools: [] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://mcp.example.test/mcp');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.equal(seen[0].init.credentials, 'omit');
  assert.equal(seen[0].init.headers.get('MCP-Protocol-Version'), MCP_REVISION_CURRENT);
  assert.equal(seen[0].init.headers.get('Mcp-Method'), 'tools/list');
  assert.equal(seen[0].init.headers.get('Mcp-Name'), null);
  assert.equal(seen[0].init.headers.get('Authorization'), 'Bearer fake_access_token_for_test_only');
  assert.equal(
    seen[0].body.params._meta['io.modelcontextprotocol/protocolVersion'],
    MCP_REVISION_CURRENT,
  );
  assert.deepEqual(
    seen[0].body.params._meta['io.modelcontextprotocol/clientCapabilities'],
    {},
  );
  assert.equal(
    seen[0].body.params._meta['io.modelcontextprotocol/clientInfo'].name,
    'webmcp-bridge',
  );
});

test('current tools/call mirrors the tool name in Mcp-Name', async () => {
  let captured;
  const transport = new StreamableHttpTransport({
    endpoint: 'https://mcp.example.test/mcp',
    fetchImpl: async (_url, init) => {
      captured = init;
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
      });
    },
  });

  await transport.request('tools/call', { name: 'read', arguments: { path: 'README.md' } });
  assert.equal(captured.headers.get('Mcp-Method'), 'tools/call');
  assert.equal(captured.headers.get('Mcp-Name'), 'read');
});

test('Streamable HTTP accepts SSE JSON-RPC responses', async () => {
  const transport = new StreamableHttpTransport({
    endpoint: 'https://mcp.example.test/mcp',
    fetchImpl: async () => new Response(
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
  });

  assert.deepEqual(await transport.request('tools/list', {}), { tools: [] });
});

test('legacy revision performs initialize, keeps session id, and sends initialized', async () => {
  const requests = [];
  const transport = new StreamableHttpTransport({
    endpoint: 'https://legacy.example.test/mcp',
    revision: MCP_REVISION_LEGACY,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ body, headers: new Headers(init.headers) });

      if (body.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: MCP_REVISION_LEGACY,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-devspace', version: '0.0.0-test' },
          },
        }, { headers: { 'Mcp-Session-Id': 'fake-session-123' } });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [] },
      });
    },
  });

  const connection = await transport.connect();
  assert.deepEqual(connection, {
    revision: MCP_REVISION_LEGACY,
    sessionId: 'fake-session-123',
  });
  await transport.request('tools/list', {});

  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers.get('MCP-Protocol-Version'), null);
  assert.equal(requests[1].headers.get('MCP-Protocol-Version'), MCP_REVISION_LEGACY);
  assert.equal(requests[1].headers.get('Mcp-Session-Id'), 'fake-session-123');
  assert.equal(requests[2].headers.get('Mcp-Session-Id'), 'fake-session-123');
});

test('401 and 403 become sanitized authorization-required errors', async () => {
  const secretBody = 'fake-server-body-that-must-not-reach-the-error';
  const transport = new StreamableHttpTransport({
    endpoint: 'https://mcp.example.test/mcp',
    fetchImpl: async () => new Response(secretBody, {
      status: 401,
      headers: {
        'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", scope="tools:read"',
      },
    }),
  });

  await assert.rejects(
    transport.request('tools/list', {}),
    (error) => {
      assert.ok(error instanceof McpAuthorizationRequiredError);
      assert.equal(error.status, 401);
      assert.deepEqual(error.scopes, ['tools:read']);
      assert.equal(error.message.includes(secretBody), false);
      return true;
    },
  );
});

test('redirects are rejected so bearer tokens cannot follow another origin', async () => {
  const transport = new StreamableHttpTransport({
    endpoint: 'https://mcp.example.test/mcp',
    accessTokenProvider: async () => 'fake_secret_token',
    fetchImpl: async () => new Response(null, {
      status: 307,
      headers: { location: 'https://evil.example/collect' },
    }),
  });

  await assert.rejects(
    transport.request('tools/list', {}),
    (error) => error instanceof McpTransportError && error.code === 'REDIRECT_REJECTED',
  );
});

test('JSON-RPC response id must match the request id', async () => {
  const transport = new StreamableHttpTransport({
    endpoint: 'https://mcp.example.test/mcp',
    fetchImpl: async () => jsonResponse({
      jsonrpc: '2.0',
      id: 999,
      result: { tools: [] },
    }),
  });

  await assert.rejects(
    transport.request('tools/list', {}),
    (error) => error instanceof McpTransportError && error.code === 'MISSING_RESPONSE',
  );
});
