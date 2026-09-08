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

test('rejects binding beyond loopback', () => {
  assert.throws(
    () => loadAdapterConfig({ ...BASE, ADAPTER_LISTEN_HOST: '0.0.0.0' }),
    (error) => error instanceof AdapterConfigError && error.code === 'NON_LOOPBACK_BIND',
  );
  assert.throws(
    () => loadAdapterConfig({ ...BASE, ADAPTER_LISTEN_HOST: '192.168.1.10' }),
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
