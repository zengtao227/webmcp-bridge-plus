import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterConfigError, loadAdapterConfig } from '../adapter/src/config.js';

const BASE = {
  DEVSPACE_OWNER_TOKEN_REF: 'env:FAKE_OWNER_TOKEN',
};

test('defaults to a loopback-only listener', () => {
  const config = loadAdapterConfig({ ...BASE });
  assert.equal(config.listenHost, '127.0.0.1');
  assert.equal(config.listenPort, 8787);
  assert.equal(config.upstreamMcpUrl, 'http://127.0.0.1:7676/mcp');
  assert.equal(config.mcpPath, '/mcp');
});

test('defaults to stdio, so the adapter has no address to attack', () => {
  const config = loadAdapterConfig({ ...BASE });
  assert.equal(config.transport, 'stdio');
  assert.equal(config.socketPath, null);
  assert.equal(config.httpTokenRef, null);
});

test('refuses the http transport without a token, because loopback is not authorization', () => {
  assert.throws(
    () => loadAdapterConfig({ ...BASE, ADAPTER_TRANSPORT: 'http' }),
    (error) => error instanceof AdapterConfigError && error.code === 'HTTP_TOKEN_REQUIRED',
  );
  const ok = loadAdapterConfig({
    ...BASE,
    ADAPTER_TRANSPORT: 'http',
    ADAPTER_HTTP_TOKEN_REF: 'env:ADAPTER_TOKEN',
  });
  assert.equal(ok.transport, 'http');
  assert.equal(ok.httpTokenRef, 'env:ADAPTER_TOKEN');
});

test('requires an absolute socket path for the unix transport', () => {
  for (const socketPath of ['', 'relative.sock', './tmp/a.sock']) {
    assert.throws(
      () => loadAdapterConfig({ ...BASE, ADAPTER_TRANSPORT: 'unix', ADAPTER_SOCKET_PATH: socketPath }),
      (error) => error instanceof AdapterConfigError && error.code === 'INVALID_SOCKET_PATH',
    );
  }
  assert.equal(
    loadAdapterConfig({
      ...BASE,
      ADAPTER_TRANSPORT: 'unix',
      ADAPTER_SOCKET_PATH: '/tmp/webmcp/adapter.sock',
    }).socketPath,
    '/tmp/webmcp/adapter.sock',
  );
});

test('rejects an unknown transport', () => {
  assert.throws(
    () => loadAdapterConfig({ ...BASE, ADAPTER_TRANSPORT: 'bogus' }),
    (error) => error instanceof AdapterConfigError && error.code === 'INVALID_TRANSPORT',
  );
});

test('requires the DevSpace upstream to be loopback, so credentials never leave this machine', () => {
  // TLS is not a substitute for staying local: the adapter posts the owner
  // credential to this origin, so even https to a remote host is refused.
  for (const upstream of [
    'http://devspace.internal:7676',
    'https://devspace.internal:7676',
    'https://public-devspace.example',
  ]) {
    assert.throws(
      () => loadAdapterConfig({ ...BASE, DEVSPACE_UPSTREAM_URL: upstream }),
      (error) => error instanceof AdapterConfigError && error.code === 'NON_LOOPBACK_UPSTREAM',
      `expected ${upstream} to be refused`,
    );
  }
  // Loopback is acceptable: the bytes never leave the machine.
  for (const upstream of ['http://127.0.0.1:7676', 'http://localhost:7676', 'https://127.0.0.1:7676']) {
    assert.equal(
      loadAdapterConfig({ ...BASE, DEVSPACE_UPSTREAM_URL: upstream }).upstreamBaseUrl,
      upstream,
      `expected ${upstream} to be accepted`,
    );
  }
});

test('rejects binding beyond loopback for the http transport', () => {
  const base = { ...BASE, ADAPTER_TRANSPORT: 'http', ADAPTER_HTTP_TOKEN_REF: 'env:X' };
  assert.throws(
    () => loadAdapterConfig({ ...base, ADAPTER_LISTEN_HOST: '0.0.0.0' }),
    (error) => error instanceof AdapterConfigError && error.code === 'NON_LOOPBACK_BIND',
  );
  assert.throws(
    () => loadAdapterConfig({ ...base, ADAPTER_LISTEN_HOST: '192.168.1.10' }),
    (error) => error instanceof AdapterConfigError && error.code === 'NON_LOOPBACK_BIND',
  );
});

test('accepts only explicit loopback hosts', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(loadAdapterConfig({ ...BASE, ADAPTER_LISTEN_HOST: host }).listenHost, host);
  }
});

test('rejects invalid ports', () => {
  for (const port of ['0', '65536', 'abc', '']) {
    assert.throws(
      () => loadAdapterConfig({ ...BASE, ADAPTER_PORT: port }),
      (error) => error instanceof AdapterConfigError && error.code === 'INVALID_PORT',
    );
  }
});

test('rejects upstream URLs that are not plain http(s) or carry credentials', () => {
  assert.throws(
    () => loadAdapterConfig({ ...BASE, DEVSPACE_UPSTREAM_URL: 'ftp://127.0.0.1:7676' }),
    (error) => error instanceof AdapterConfigError && error.code === 'INVALID_UPSTREAM_URL',
  );
  assert.throws(
    () => loadAdapterConfig({ ...BASE, DEVSPACE_UPSTREAM_URL: 'https://user:pw@127.0.0.1:7676' }),
    (error) => error instanceof AdapterConfigError && error.code === 'INVALID_UPSTREAM_URL',
  );
});

test('rejects unsafe MCP paths', () => {
  for (const path of ['mcp', '/mcp?x=1', '/../mcp', '/mcp#frag']) {
    assert.throws(
      () => loadAdapterConfig({ ...BASE, DEVSPACE_MCP_PATH: path }),
      (error) => error instanceof AdapterConfigError && error.code === 'INVALID_MCP_PATH',
    );
  }
});

test('rejects secret references that are not env/file/keychain', () => {
  for (const ref of ['literal-secret', 'env:', 'file:relative/path', 'keychain:', '']) {
    assert.throws(
      () => loadAdapterConfig({ DEVSPACE_OWNER_TOKEN_REF: ref }),
      (error) => error instanceof AdapterConfigError
        && ['UNSUPPORTED_SECRET_REF', 'INVALID_SECRET_REF'].includes(error.code),
    );
  }
});

test('accepts keychain and file secret references without reading them', () => {
  assert.equal(
    loadAdapterConfig({ DEVSPACE_OWNER_TOKEN_REF: 'keychain:devspace-owner-token' }).ownerTokenRef,
    'keychain:devspace-owner-token',
  );
  assert.equal(
    loadAdapterConfig({ DEVSPACE_OWNER_TOKEN_REF: 'file:/run/secrets/owner' }).ownerTokenRef,
    'file:/run/secrets/owner',
  );
});

test('fails closed on invalid numeric options', () => {
  assert.throws(
    () => loadAdapterConfig({ ...BASE, ADAPTER_MAX_REQUEST_BYTES: '0' }),
    (error) => error instanceof AdapterConfigError && error.code === 'INVALID_MAX_REQUEST_BYTES',
  );
  assert.throws(
    () => loadAdapterConfig({ ...BASE, ADAPTER_UPSTREAM_TIMEOUT_MS: 'soon' }),
    (error) => error instanceof AdapterConfigError && error.code === 'INVALID_UPSTREAM_TIMEOUT_MS',
  );
});

test('derives the OAuth resource from the upstream when not overridden', () => {
  const config = loadAdapterConfig({ ...BASE, DEVSPACE_UPSTREAM_URL: 'http://127.0.0.1:9000' });
  assert.equal(config.oauthResource, 'http://127.0.0.1:9000/mcp');
});
