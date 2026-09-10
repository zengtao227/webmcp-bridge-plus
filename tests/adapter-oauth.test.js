import test from 'node:test';
import assert from 'node:assert/strict';
import { DevSpaceOAuthClient, DevSpaceOAuthError, createPkce } from '../adapter/src/oauth-client.js';
import { startFakeDevSpace } from './helpers/fake-devspace.js';

const OWNER = 'fake-owner-token-0123456789abcdef';

function makeClient(fake, overrides = {}) {
  return new DevSpaceOAuthClient({
    upstreamMcpUrl: `${fake.url}/mcp`,
    resource: `${fake.url}/mcp`,
    ownerToken: OWNER,
    redirectUri: 'http://127.0.0.1:8787/oauth/callback',
    scopes: ['devspace'],
    ...overrides,
  });
}

test('createPkce produces an S256 challenge matching the verifier', async () => {
  const { createHash } = await import('node:crypto');
  const pkce = createPkce();
  assert.equal(pkce.method, 'S256');
  assert.equal(
    pkce.challenge,
    createHash('sha256').update(pkce.verifier).digest('base64url'),
  );
});

test('completes DevSpace OAuth over loopback without any public URL', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  try {
    const client = makeClient(fake);
    const token = await client.getAccessToken();

    assert.equal(token, 'at-1');
    assert.equal(fake.state.registeredClients.length, 1);
    assert.ok(fake.state.lastAuthorization.codeChallenge);
    assert.equal(fake.state.lastAuthorization.redirectUri, 'http://127.0.0.1:8787/oauth/callback');
  } finally {
    await fake.close();
  }
});

test('reuses a valid token instead of re-authorizing', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  try {
    const client = makeClient(fake);
    assert.equal(await client.getAccessToken(), 'at-1');
    assert.equal(await client.getAccessToken(), 'at-1');
    assert.equal(fake.state.tokenCounter, 1);
  } finally {
    await fake.close();
  }
});

test('refreshes using the refresh token when the access token nears expiry', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER, accessTtlSeconds: 600 });
  let nowMs = Date.now();
  try {
    const client = makeClient(fake, {
      refreshSkewSeconds: 300,
      now: () => nowMs,
    });

    assert.equal(await client.getAccessToken(), 'at-1');
    nowMs += 400_000;
    assert.equal(await client.getAccessToken(), 'at-2');

    const refreshCalls = fake.state.requests.filter(
      (entry) => entry.path === '/token' && entry.body.includes('grant_type=refresh_token'),
    );
    assert.equal(refreshCalls.length, 1);
  } finally {
    await fake.close();
  }
});

test('falls back to a full authorization when refresh fails', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER, accessTtlSeconds: 60 });
  let nowMs = Date.now();
  try {
    const client = makeClient(fake, { refreshSkewSeconds: 300, now: () => nowMs });
    assert.equal(await client.getAccessToken(), 'at-1');

    nowMs += 120_000;
    fake.state.failNextTokenRequest = true;
    assert.equal(await client.getAccessToken(), 'at-2');

    const authorizeCalls = fake.state.requests.filter((entry) => entry.path === '/authorize');
    assert.equal(authorizeCalls.length, 2);
  } finally {
    await fake.close();
  }
});

test('re-registers with a new clientId when refresh fails after a DevSpace replacement', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER, accessTtlSeconds: 600 });
  let nowMs = Date.now();
  try {
    const client = makeClient(fake, { refreshSkewSeconds: 300, now: () => nowMs });
    assert.equal(await client.getAccessToken(), 'at-1');
    assert.equal(fake.state.registeredClients.length, 1);

    // Enter the refresh window, then simulate the container being replaced:
    // the server-side client registration and every token it issued are gone,
    // even though the adapter still has them cached.
    nowMs += 400_000;
    fake.state.replaceDevSpace();

    assert.equal(await client.getAccessToken(), 'at-2');

    // A stale clientId must never be reused after the reset; the adapter has
    // to discover/register/authorize from scratch.
    assert.equal(fake.state.registeredClients.length, 2);
    assert.equal(fake.state.lastAuthorization.clientId, 'client-2');
  } finally {
    await fake.close();
  }
});

test('fails closed when the owner password is rejected', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  try {
    const client = new DevSpaceOAuthClient({
      upstreamMcpUrl: `${fake.url}/mcp`,
      resource: `${fake.url}/mcp`,
      ownerToken: 'wrong-owner-token-000000000000',
    });
    await assert.rejects(
      () => client.getAccessToken(),
      (error) => error instanceof DevSpaceOAuthError && error.code === 'INVALID_OWNER_TOKEN',
    );
  } finally {
    await fake.close();
  }
});

test('fails closed when the server does not advertise PKCE S256', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await originalFetch(url, init);
    if (String(url).includes('oauth-authorization-server')) {
      const body = await response.json();
      body.code_challenge_methods_supported = ['plain'];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response;
  };
  try {
    const client = makeClient(fake);
    await assert.rejects(
      () => client.getAccessToken(),
      (error) => error instanceof DevSpaceOAuthError && error.code === 'PKCE_S256_REQUIRED',
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fake.close();
  }
});

test('fails closed when dynamic client registration is unavailable', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER, advertiseRegistration: false });
  try {
    const client = makeClient(fake);
    await assert.rejects(
      () => client.getAccessToken(),
      (error) => error instanceof DevSpaceOAuthError && error.code === 'REGISTRATION_UNAVAILABLE',
    );
  } finally {
    await fake.close();
  }
});

test('rejects an authorization redirect whose state does not match', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/authorize')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:8787/oauth/callback?code=code-1&state=tampered' },
      });
    }
    return originalFetch(url, init);
  };
  try {
    const client = makeClient(fake);
    await assert.rejects(
      () => client.getAccessToken(),
      (error) => error instanceof DevSpaceOAuthError && error.code === 'STATE_MISMATCH',
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fake.close();
  }
});

test('rejects an authorization redirect that carries no state at all', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/authorize')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:8787/oauth/callback?code=code-1' },
      });
    }
    return originalFetch(url, init);
  };
  try {
    const client = makeClient(fake);
    await assert.rejects(
      () => client.getAccessToken(),
      (error) => error instanceof DevSpaceOAuthError && error.code === 'STATE_MISSING',
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fake.close();
  }
});

test('rejects an authorization redirect to a different registered target', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const client = makeClient(fake, {
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/authorize') && response.status === 302) {
        const location = new URL(response.headers.get('location'));
        location.hostname = 'localhost';
        return new Response(null, { status: 302, headers: { location: location.toString() } });
      }
      return response;
    },
  });
  try {
    await assert.rejects(
      client.getAccessToken(),
      (error) => error instanceof DevSpaceOAuthError && error.code === 'REDIRECT_URI_MISMATCH',
    );
  } finally {
    await fake.close();
  }
});

test('bounds metadata reads so a hostile authorization server cannot stream forever', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('oauth-authorization-server')) {
      const chunk = 'x'.repeat(64 * 1024);
      const stream = new ReadableStream({
        pull(controller) {
          // Never closes.
          controller.enqueue(new TextEncoder().encode(chunk));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(url, init);
  };
  try {
    const client = makeClient(fake);
    await assert.rejects(
      () => client.getAccessToken(),
      (error) => error instanceof DevSpaceOAuthError
        && ['METADATA_TOO_LARGE', 'METADATA_TIMEOUT'].includes(error.code),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fake.close();
  }
});

test('times out when OAuth response headers arrive but the body never finishes', async () => {
  const stream = new ReadableStream({
    pull() {},
    cancel() {},
  });
  const client = new DevSpaceOAuthClient({
    upstreamMcpUrl: 'http://127.0.0.1:7676/mcp',
    ownerToken: OWNER,
    timeoutMs: 30,
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    client.getAccessToken(),
    (error) => error instanceof DevSpaceOAuthError && error.code === 'METADATA_TIMEOUT',
  );
});

test('times out when DevSpace never answers the token endpoint', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/token')) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return originalFetch(url, init);
  };
  try {
    const client = makeClient(fake, { timeoutMs: 50 });
    await assert.rejects(
      () => client.getAccessToken(),
      (error) => error instanceof DevSpaceOAuthError && error.code === 'OAUTH_TIMEOUT',
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fake.close();
  }
});

test('concurrent callers share a single authorization round trip', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  try {
    const client = makeClient(fake);
    const results = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);
    assert.deepEqual(results, ['at-1', 'at-1', 'at-1']);
    assert.equal(fake.state.tokenCounter, 1);
  } finally {
    await fake.close();
  }
});

test('invalidate forces re-authentication on the next call', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  try {
    const client = makeClient(fake);
    assert.equal(await client.getAccessToken(), 'at-1');
    client.invalidate();
    assert.equal(await client.getAccessToken(), 'at-2');
  } finally {
    await fake.close();
  }
});

test('talks to the configured upstream even when metadata advertises another host', async () => {
  const fake = await startFakeDevSpace({
    ownerToken: OWNER,
    advertisedIssuer: 'https://public.example.test/',
  });
  try {
    const client = makeClient(fake);
    const token = await client.getAccessToken();
    assert.equal(token, 'at-1');
    // No request may target the advertised public host.
    assert.ok(fake.state.requests.every((entry) => entry.path.startsWith('/')));
    assert.ok(fake.state.lastAuthorization.resource === `${fake.url}/mcp`);
  } finally {
    await fake.close();
  }
});
