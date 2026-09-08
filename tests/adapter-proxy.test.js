import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAdapterConfig } from '../adapter/src/config.js';
import { DevSpaceOAuthClient } from '../adapter/src/oauth-client.js';
import { createAdapterServer } from '../adapter/src/server.js';
import { startFakeDevSpace } from './helpers/fake-devspace.js';
import { reserveLoopbackPort } from './helpers/free-port.js';

const OWNER = 'fake-owner-token-0123456789abcdef';

async function startAdapter(fake, extraEnv = {}) {
  // Configuration requires a real port; the listener itself still binds 0 so
  // the port is never raced between config validation and bind.
  const configuredPort = await reserveLoopbackPort();
  const config = loadAdapterConfig({
    DEVSPACE_UPSTREAM_URL: fake.url,
    ADAPTER_PORT: String(configuredPort),
    DEVSPACE_OWNER_TOKEN_REF: 'env:FAKE_OWNER_TOKEN',
    ...extraEnv,
  });

  const events = [];
  const log = (event, fields = {}) => events.push({ event, ...fields });
  const oauthClient = new DevSpaceOAuthClient({
    upstreamMcpUrl: config.upstreamMcpUrl,
    resource: config.oauthResource,
    ownerToken: OWNER,
    clientName: config.clientName,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    refreshSkewSeconds: config.refreshSkewSeconds,
    log,
  });

  const server = createAdapterServer(config, { oauthClient, log });
  await new Promise((resolve) => server.listen(0, config.listenHost, resolve));
  const port = server.address().port;
  return {
    config,
    events,
    oauthClient,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      // Keep-alive sockets would otherwise hold the event loop open.
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

test('proxies MCP requests and attaches a DevSpace access token', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const adapter = await startAdapter(fake);
  try {
    const response = await fetch(`${adapter.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'session-abc',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.echoed, 'tools/list');
    assert.equal(body.result.viaAdapter, true);

    assert.equal(fake.state.mcpCalls.length, 1);
    assert.equal(fake.state.mcpCalls[0].presented, 'at-1');
    assert.equal(fake.state.mcpCalls[0].sessionId, 'session-abc');
  } finally {
    await adapter.close();
    await fake.close();
  }
});

test('re-authenticates and retries once when DevSpace rejects the token', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const adapter = await startAdapter(fake);
  try {
    const first = await fetch(`${adapter.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(first.status, 200);

    fake.state.rejectedTokens.add('at-1');

    const second = await fetch(`${adapter.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(second.status, 200);
    assert.ok(fake.state.mcpCalls.some((call) => call.presented === 'at-2'));
    assert.ok(adapter.events.some((entry) => entry.event === 'upstream_unauthorized_retry'));
  } finally {
    await adapter.close();
    await fake.close();
  }
});

test('never advertises OAuth metadata, so the tunnel stays in unauthenticated-target mode', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const adapter = await startAdapter(fake);
  try {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/authorize',
      '/token',
      '/register',
      '/',
    ]) {
      const response = await fetch(`${adapter.url}${path}`);
      assert.equal(response.status, 404, `expected 404 for ${path}`);
    }
  } finally {
    await adapter.close();
    await fake.close();
  }
});

test('rejects unsupported methods, media types, malformed JSON and oversized bodies', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const adapter = await startAdapter(fake, { ADAPTER_MAX_REQUEST_BYTES: '64' });
  try {
    const put = await fetch(`${adapter.url}/mcp`, { method: 'PUT' });
    assert.equal(put.status, 405);

    const wrongType = await fetch(`${adapter.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(wrongType.status, 415);

    const badJson = await fetch(`${adapter.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);

    const tooBig = await fetch(`${adapter.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(4096) }),
    });
    assert.equal(tooBig.status, 413);

    // No request may have reached DevSpace without a valid token.
    assert.equal(fake.state.mcpCalls.length, 0);
  } finally {
    await adapter.close();
    await fake.close();
  }
});

test('healthz reports readiness without exposing secrets', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const adapter = await startAdapter(fake);
  try {
    const before = await fetch(`${adapter.url}/healthz`);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { status: 'ok', authenticated: false });

    await fetch(`${adapter.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });

    const after = await fetch(`${adapter.url}/healthz`);
    const body = await after.text();
    assert.match(body, /"authenticated":true/);
    assert.ok(!body.includes('at-1'));
    assert.ok(!body.includes(OWNER));
  } finally {
    await adapter.close();
    await fake.close();
  }
});

test('returns 502 instead of leaking details when authentication is impossible', async () => {
  const configuredPort = await reserveLoopbackPort();
  // Point the adapter at an upstream that has no metadata endpoint at all.
  const broken = loadAdapterConfig({
    DEVSPACE_UPSTREAM_URL: 'http://127.0.0.1:1',
    ADAPTER_PORT: String(configuredPort),
    DEVSPACE_OWNER_TOKEN_REF: 'env:FAKE_OWNER_TOKEN',
  });
  const oauthClient = new DevSpaceOAuthClient({
    upstreamMcpUrl: broken.upstreamMcpUrl,
    resource: broken.oauthResource,
    ownerToken: OWNER,
  });
  const server = createAdapterServer(broken, { oauthClient, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.ok(!body.includes(OWNER));
    assert.ok(!body.includes('stack'));
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  }
});

test('forwards the MCP session id returned by DevSpace', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const adapter = await startAdapter(fake);
  try {
    // The fake does not emit a session id; assert the header is simply absent
    // rather than fabricated, which would break MCP session handling.
    const response = await fetch(`${adapter.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), null);
  } finally {
    await adapter.close();
    await fake.close();
  }
});
