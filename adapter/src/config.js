export class AdapterConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AdapterConfigError';
    this.code = code;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_REFRESH_SKEW_SECONDS = 300;
const MAX_PATH_LENGTH = 256;
const MAX_SECRET_REF_LENGTH = 4096;

// Secret references only. A literal secret in configuration is a misconfiguration.
//   env:<NAME>            read from the process environment
//   file:/absolute/path   read from a file on disk
//   keychain:<service>    read from the macOS Keychain (see src/secrets.js)
const SECRET_REF_PATTERN = /^(?:env:[A-Za-z_][A-Za-z0-9_]*|file:\/[^\s]+|keychain:[^\s:]+)$/;

function parsePort(value) {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '');
  if (!/^\d{1,5}$/.test(raw)) {
    throw new AdapterConfigError('ADAPTER_PORT must be a valid TCP port.', 'INVALID_PORT');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AdapterConfigError('ADAPTER_PORT must be between 1 and 65535.', 'INVALID_PORT');
  }
  return port;
}

function parseUrl(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new AdapterConfigError(`A bounded URL is required (${code}).`, code);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AdapterConfigError(`Value is not a valid URL (${code}).`, code);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AdapterConfigError(`URL must use http or https (${code}).`, code);
  }
  if (url.username || url.password) {
    throw new AdapterConfigError(`URL must not contain credentials (${code}).`, code);
  }
  return url;
}

function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw new AdapterConfigError('DEVSPACE_MCP_PATH must be a bounded path.', 'INVALID_MCP_PATH');
  }
  if (!value.startsWith('/') || value.includes('?') || value.includes('#') || value.includes('..')) {
    throw new AdapterConfigError('DEVSPACE_MCP_PATH must be an absolute path without query or traversal.', 'INVALID_MCP_PATH');
  }
  return value;
}

function parsePositiveInteger(value, fallback, code) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const raw = String(value).trim();
  if (!/^\d{1,12}$/.test(raw)) {
    throw new AdapterConfigError(`Numeric option is invalid (${code}).`, code);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AdapterConfigError(`Numeric option must be a positive integer (${code}).`, code);
  }
  return parsed;
}

function parseSecretRef(value) {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (ref.length === 0 || ref.length > MAX_SECRET_REF_LENGTH) {
    throw new AdapterConfigError('DEVSPACE_OWNER_TOKEN_REF must be a bounded secret reference.', 'INVALID_SECRET_REF');
  }
  if (!SECRET_REF_PATTERN.test(ref)) {
    throw new AdapterConfigError(
      'DEVSPACE_OWNER_TOKEN_REF must use env:<NAME>, file:<absolute-path> or keychain:<service>.',
      'UNSUPPORTED_SECRET_REF',
    );
  }
  return ref;
}

export function loadAdapterConfig(env = process.env) {
  const listenHost = (env.ADAPTER_LISTEN_HOST ?? '127.0.0.1').trim();
  if (!LOOPBACK_HOSTS.has(listenHost)) {
    throw new AdapterConfigError(
      'ADAPTER_LISTEN_HOST must be loopback. The adapter is the trust boundary and must never bind a routable interface.',
      'NON_LOOPBACK_BIND',
    );
  }

  const listenPort = parsePort(env.ADAPTER_PORT ?? String(DEFAULT_PORT));
  const upstreamBaseUrl = parseUrl(
    env.DEVSPACE_UPSTREAM_URL ?? 'http://127.0.0.1:7676',
    'INVALID_UPSTREAM_URL',
  );
  const mcpPath = normalizePath(env.DEVSPACE_MCP_PATH ?? '/mcp');
  const upstreamMcpUrl = new URL(mcpPath, upstreamBaseUrl).toString();

  const oauthResource = env.DEVSPACE_OAUTH_RESOURCE
    ? parseUrl(env.DEVSPACE_OAUTH_RESOURCE, 'INVALID_OAUTH_RESOURCE').toString()
    : upstreamMcpUrl;

  const ownerTokenRef = parseSecretRef(
    env.DEVSPACE_OWNER_TOKEN_REF ?? 'keychain:devspace-owner-token',
  );

  const redirectUri = env.DEVSPACE_OAUTH_REDIRECT_URI
    ? parseUrl(env.DEVSPACE_OAUTH_REDIRECT_URI, 'INVALID_REDIRECT_URI').toString()
    : `http://127.0.0.1:${listenPort}/oauth/callback`;

  const clientName = (env.ADAPTER_CLIENT_NAME ?? 'webmcp-bridge-private-adapter').trim();
  if (clientName.length === 0 || clientName.length > 128) {
    throw new AdapterConfigError('ADAPTER_CLIENT_NAME must be 1-128 characters.', 'INVALID_CLIENT_NAME');
  }

  const scopes = (env.DEVSPACE_OAUTH_SCOPES ?? 'devspace')
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  if (scopes.length === 0 || scopes.length > 32) {
    throw new AdapterConfigError('DEVSPACE_OAUTH_SCOPES must contain 1-32 scopes.', 'INVALID_SCOPES');
  }

  return Object.freeze({
    listenHost,
    listenPort,
    upstreamBaseUrl: upstreamBaseUrl.toString().replace(/\/+$/, ''),
    mcpPath,
    upstreamMcpUrl,
    oauthResource,
    ownerTokenRef,
    redirectUri,
    clientName,
    scopes: Object.freeze(scopes),
    maxRequestBytes: parsePositiveInteger(
      env.ADAPTER_MAX_REQUEST_BYTES, DEFAULT_MAX_REQUEST_BYTES, 'INVALID_MAX_REQUEST_BYTES',
    ),
    maxResponseBytes: parsePositiveInteger(
      env.ADAPTER_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES, 'INVALID_MAX_RESPONSE_BYTES',
    ),
    upstreamTimeoutMs: parsePositiveInteger(
      env.ADAPTER_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS, 'INVALID_UPSTREAM_TIMEOUT_MS',
    ),
    refreshSkewSeconds: parsePositiveInteger(
      env.ADAPTER_REFRESH_SKEW_SECONDS, DEFAULT_REFRESH_SKEW_SECONDS, 'INVALID_REFRESH_SKEW_SECONDS',
    ),
  });
}
