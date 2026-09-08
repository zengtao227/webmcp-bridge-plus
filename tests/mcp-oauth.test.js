import test from 'node:test';
import assert from 'node:assert/strict';
import {
  McpOAuthError,
  authorizationServerMetadataCandidates,
  buildAuthorizationUrl,
  createOAuthState,
  createPkce,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  protectedResourceMetadataCandidates,
} from '../extension/mcp/oauth.js';

function metadataResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('builds RFC9728 protected-resource metadata fallback paths', () => {
  assert.deepEqual(
    protectedResourceMetadataCandidates('https://mcp.example.test/public/mcp'),
    [
      'https://mcp.example.test/.well-known/oauth-protected-resource/public/mcp',
      'https://mcp.example.test/.well-known/oauth-protected-resource',
    ],
  );
});

test('challenge-provided protected resource metadata remains same-origin in MVP', () => {
  assert.throws(
    () => protectedResourceMetadataCandidates(
      'https://mcp.example.test/mcp',
      'https://other.example.test/.well-known/oauth-protected-resource',
    ),
    (error) => error instanceof McpOAuthError && error.code === 'RESOURCE_METADATA_ORIGIN_MISMATCH',
  );
});

test('discovers protected-resource metadata using path fallback then root', async () => {
  const fetched = [];
  const result = await discoverProtectedResourceMetadata({
    endpoint: 'https://mcp.example.test/public/mcp',
    allowOrigin: async (origin) => origin === 'https://mcp.example.test',
    fetchImpl: async (url, init) => {
      fetched.push({ url, init });
      if (url.includes('/oauth-protected-resource/public/mcp')) {
        return metadataResponse({ error: 'not found' }, 404);
      }
      return metadataResponse({
        resource: 'https://mcp.example.test/public/mcp',
        authorization_servers: ['https://auth.example.test/tenant1'],
        scopes_supported: ['tools:read'],
      });
    },
  });

  assert.equal(fetched.length, 2);
  assert.equal(fetched[0].init.redirect, 'manual');
  assert.equal(fetched[0].init.credentials, 'omit');
  assert.equal(result.authorizationServers[0], 'https://auth.example.test/tenant1');
  assert.deepEqual(result.scopesSupported, ['tools:read']);
});

test('builds authorization metadata discovery candidates for path issuers', () => {
  assert.deepEqual(
    authorizationServerMetadataCandidates('https://auth.example.test/tenant1'),
    [
      'https://auth.example.test/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.test/.well-known/openid-configuration/tenant1',
      'https://auth.example.test/tenant1/.well-known/openid-configuration',
    ],
  );
});

test('authorization server discovery requires explicit origin approval and PKCE S256', async () => {
  const issuer = 'https://auth.example.test/tenant1';
  const result = await discoverAuthorizationServerMetadata({
    issuer,
    allowOrigin: async (origin) => origin === 'https://auth.example.test',
    fetchImpl: async (url) => {
      if (url.includes('oauth-authorization-server')) {
        return metadataResponse({ error: 'not found' }, 404);
      }
      return metadataResponse({
        issuer,
        authorization_endpoint: 'https://auth.example.test/tenant1/authorize',
        token_endpoint: 'https://auth.example.test/tenant1/token',
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['tools:read'],
        client_id_metadata_document_supported: true,
      });
    },
  });

  assert.equal(result.issuer, issuer);
  assert.equal(result.authorizationEndpoint, 'https://auth.example.test/tenant1/authorize');
  assert.equal(result.clientIdMetadataDocumentSupported, true);
  assert.deepEqual(result.scopesSupported, ['tools:read']);
});

test('authorization server discovery rejects an issuer mix-up', async () => {
  await assert.rejects(
    discoverAuthorizationServerMetadata({
      issuer: 'https://auth.example.test',
      allowOrigin: async () => true,
      fetchImpl: async () => metadataResponse({
        issuer: 'https://evil.example.test',
        authorization_endpoint: 'https://evil.example.test/authorize',
        token_endpoint: 'https://evil.example.test/token',
        code_challenge_methods_supported: ['S256'],
      }),
    }),
    (error) => error instanceof McpOAuthError && error.code === 'ISSUER_MISMATCH',
  );
});

test('authorization server discovery refuses missing PKCE S256 support', async () => {
  await assert.rejects(
    discoverAuthorizationServerMetadata({
      issuer: 'https://auth.example.test',
      allowOrigin: async () => true,
      fetchImpl: async () => metadataResponse({
        issuer: 'https://auth.example.test',
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://auth.example.test/token',
        code_challenge_methods_supported: ['plain'],
      }),
    }),
    (error) => error instanceof McpOAuthError && error.code === 'PKCE_S256_REQUIRED',
  );
});

test('creates high-entropy PKCE and state values using Web Crypto', async () => {
  const first = await createPkce();
  const second = await createPkce();
  const state = createOAuthState();

  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.method, 'S256');
  assert.notEqual(first.verifier, second.verifier);
  assert.match(state, /^[A-Za-z0-9_-]{32}$/);
});

test('authorization URL includes PKCE, state, scopes, and MCP resource audience', async () => {
  const pkce = await createPkce();
  const state = createOAuthState();
  const url = new URL(buildAuthorizationUrl({
    authorizationEndpoint: 'https://auth.example.test/authorize',
    clientId: 'https://bridge.example.test/oauth/client.json',
    redirectUri: 'https://bridge.example.test/oauth/callback',
    resource: 'https://mcp.example.test/mcp',
    scopes: ['tools:read', 'tools:write'],
    state,
    codeChallenge: pkce.challenge,
  }));

  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('resource'), 'https://mcp.example.test/mcp');
  assert.equal(url.searchParams.get('scope'), 'tools:read tools:write');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});
