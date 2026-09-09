// These tests pin the reason ChatGPT must never see an OAuth prompt.
//
// DevSpace authenticates *the adapter*, on loopback. A caller on the far side
// of the tunnel cannot reach 127.0.0.1, so any authorization endpoint we
// forward is at best useless and at worst an invitation to start a flow against
// a host it can never reach. Public authorization URLs must therefore be
// removed before connector-visible output is returned.

import test from 'node:test';
import assert from 'node:assert/strict';
import { localErrorEnvelope, scrubAuthMetadata } from '../adapter/src/sanitize.js';

const PUBLIC_AUTH_URL = 'https://auth.public-devspace.example/authorize?state=abc123';

test('drops every key that describes how to authenticate against DevSpace', () => {
  const scrubbed = scrubAuthMetadata({
    jsonrpc: '2.0',
    id: 1,
    result: {
      authorization_endpoint: 'https://auth.public-devspace.example/authorize',
      token_endpoint: 'https://auth.public-devspace.example/token',
      registration_endpoint: 'https://auth.public-devspace.example/register',
      issuer: 'http://127.0.0.1:7676/',
      authorization_servers: ['http://127.0.0.1:7676/'],
      resource_metadata: 'https://auth.public-devspace.example/.well-known/oauth-protected-resource/mcp',
      scopes_supported: ['devspace'],
    },
  });

  for (const key of [
    'authorization_endpoint',
    'token_endpoint',
    'registration_endpoint',
    'issuer',
    'authorization_servers',
    'resource_metadata',
  ]) {
    assert.equal(key in scrubbed.result, false, `${key} must be dropped`);
  }
  // Non-auth data survives, so tools keep working.
  assert.deepEqual(scrubbed.result.scopes_supported, ['devspace']);
});

test('redacts credential values while keeping the payload shape', () => {
  const scrubbed = scrubAuthMetadata({
    access_token: 'fake-access-token-abcdefghijklmnop123456',
    refresh_token: 'fake-refresh-token-abcdefghijklmnop123456',
    owner_token: 'fake-owner-token-abcdefghijklmnop123456',
    code: 'auth-code-1',
    state: 'csrf-state-1',
    scope: 'devspace',
  });

  assert.equal(scrubbed.access_token, '[redacted]');
  assert.equal(scrubbed.refresh_token, '[redacted]');
  assert.equal(scrubbed.owner_token, '[redacted]');
  assert.equal(scrubbed.code, '[redacted]');
  assert.equal(scrubbed.state, '[redacted]');
  assert.equal(scrubbed.scope, 'devspace');
});

test('scrubs an authorization URL out of free text', () => {
  const scrubbed = scrubAuthMetadata({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: `Sign in at ${PUBLIC_AUTH_URL}` },
  });

  assert.ok(!JSON.stringify(scrubbed).includes('public-devspace.example'));
  assert.ok(!JSON.stringify(scrubbed).includes('/authorize'));
  assert.match(scrubbed.error.message, /\[redacted\]/);
});

test('preserves a JSON-RPC integer error code without exposing nested auth codes', () => {
  const scrubbed = scrubAuthMetadata({
    jsonrpc: '2.0',
    id: 'discover-1',
    error: {
      code: -32601,
      message: 'Method not found',
      data: { code: 'oauth-authorization-code' },
    },
  });

  assert.equal(scrubbed.error.code, -32601);
  assert.equal(scrubbed.error.data.code, '[redacted]');
});

test('does not preserve a non-integer JSON-RPC error code', () => {
  const scrubbed = scrubAuthMetadata({
    jsonrpc: '2.0',
    id: 1,
    error: { code: 'oauth-authorization-code', message: 'invalid' },
  });

  assert.equal(scrubbed.error.code, '[redacted]');
});

test('scrubs RFC 8414 / RFC 9728 metadata references', () => {
  const scrubbed = scrubAuthMetadata({
    a: 'https://auth.public-devspace.example/.well-known/oauth-authorization-server',
    b: 'https://auth.public-devspace.example/.well-known/oauth-protected-resource/mcp',
  });

  assert.ok(!JSON.stringify(scrubbed).includes('well-known/oauth'));
});

test('redacts bearer tokens in flight', () => {
  const scrubbed = scrubAuthMetadata({ header: 'Authorization: Bearer fake-bearer-abcdefghijklmnop123456' });
  assert.ok(!scrubbed.header.includes('abcdefghijklmnop123456'));
  assert.match(scrubbed.header, /Bearer \[redacted\]/);
});

test('leaves ordinary project paths alone', () => {
  // The endpoint pattern requires a scheme, so a file called "token" is safe.
  for (const path of ['/work/app/token', '/work/app/authorize.ts', '/work/My code/x/register']) {
    assert.equal(scrubAuthMetadata({ path }).path, path);
  }
});

test('walks arrays and nested objects', () => {
  const scrubbed = scrubAuthMetadata({
    content: [{ type: 'text', text: `go to ${PUBLIC_AUTH_URL}` }],
    nested: { deep: { authorization_endpoint: 'https://auth.public-devspace.example/authorize' } },
  });

  assert.ok(!JSON.stringify(scrubbed).includes('public-devspace.example'));
  assert.equal('authorization_endpoint' in scrubbed.nested.deep, false);
});

test('local error envelopes echo the id and carry no URL', () => {
  const envelope = localErrorEnvelope(7, 'upstream_auth_rejected');
  assert.equal(envelope.id, 7);
  assert.equal(envelope.error.code, -32002);
  assert.ok(!JSON.stringify(envelope).includes('http'));
  assert.match(envelope.error.message, /not forwarded/);
});

test('an unknown failure code still produces a safe envelope', () => {
  const envelope = localErrorEnvelope(null, 'something-unexpected');
  assert.equal(envelope.id, null);
  assert.ok(!JSON.stringify(envelope).includes('http'));
});
