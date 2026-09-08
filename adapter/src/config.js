export class AdapterConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AdapterConfigError';
    this.code = code;
  }
}

// stdio: no socket at all. tunnel-client spawns us as a child process, so no
// other local process can reach the adapter. Default, and the only transport
// that exposes no address to attack.
// unix: 0600 socket owned by the user; filesystem permissions are the boundary.
// http: loopback TCP, and it requires a bearer token because loopback is not
// identity. Missing token means we refuse to start.
export const TRANSPORTS = Object.freeze(['stdio', 'unix', 'http']);

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_OAUTH_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_SKEW_SECONDS = 300;
const MAX_PATH_LENGTH = 256;
const MAX_SECRET_REF_LENGTH = 4096;

// Secret references only. A literal secret in configuration is a misconfiguration.
const SECRET_REF_PATTERN = /^(?:env:[A-Za-z_][A-Za-z0-9_]*|file:\/[^\s]+|keychain:[^\s:]+)$/;

export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    return false;
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // 127.0.0.0/8 is all loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host.split('.').every((part) => Number(part) <= 255);
  }
  return false;
}

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

/**
 * Parse a URL and enforce the transport policy: plaintext http is acceptable
 * only for a loopback peer. Anything else must be TLS, because the OAuth owner
 * token is posted to this origin.
 */
function parseUrl(value, code, { requireTls = false } = {}) {
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
  if (requireTls && url.protocol !== 'https:') {
    throw new AdapterConfigError(`URL must use https (${code}).`, code);
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new AdapterConfigError(
      `Plaintext http is allowed only for loopback peers; use https for ${url.hostname} (${code}).`,
      'PLAINTEXT_UPSTREAM_FORBIDDEN',
    );
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

function parseSecretRef(value, code) {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (ref.length === 0 || ref.length > MAX_SECRET_REF_LENGTH) {
    throw new AdapterConfigError(`A bounded secret reference is required (${code}).`, 'INVALID_SECRET_REF');
  }
  if (!SECRET_REF_PATTERN.test(ref)) {
    throw new AdapterConfigError(
      `Secret reference must use env:<NAME>, file:<absolute-path> or keychain:<service> (${code}).`,
      'UNSUPPORTED_SECRET_REF',
    );
  }
  return ref;
}

function parseOptionalSecretRef(value, code) {
  if (value === undefined || String(value).trim() === '') {
    return null;
  }
  return parseSecretRef(value, code);
}

export function loadAdapterConfig(env = process.env) {
  const transport = (env.ADAPTER_TRANSPORT ?? 'stdio').trim().toLowerCase();
  if (!TRANSPORTS.includes(transport)) {
    throw new AdapterConfigError(
      `ADAPTER_TRANSPORT must be one of ${TRANSPORTS.join(', ')}.`,
      'INVALID_TRANSPORT',
    );
  }

  const listenHost = (env.ADAPTER_LISTEN_HOST ?? '127.0.0.1').trim();
  const listenPort = parsePort(env.ADAPTER_PORT ?? String(DEFAULT_PORT));
  const socketPath = (env.ADAPTER_SOCKET_PATH ?? '').trim();

  if (transport === 'unix') {
    if (!socketPath.startsWith('/') || socketPath.includes('\0') || socketPath.length > 4096) {
      throw new AdapterConfigError(
        'ADAPTER_SOCKET_PATH must be an absolute path for the unix transport.',
        'INVALID_SOCKET_PATH',
      );
    }
  }
  if (transport === 'http' && !isLoopbackHost(listenHost)) {
    throw new AdapterConfigError(
      'ADAPTER_LISTEN_HOST must be loopback for the http transport.',
      'NON_LOOPBACK_BIND',
    );
  }

  // Loopback is not authorization, so the http transport is only permitted with
  // a token. Refusing to start is the fail-closed answer to a missing token.
  const httpTokenRef = parseOptionalSecretRef(env.ADAPTER_HTTP_TOKEN_REF, 'ADAPTER_HTTP_TOKEN_REF');
  if (transport === 'http' && httpTokenRef === null) {
    throw new AdapterConfigError(
      'ADAPTER_HTTP_TOKEN_REF is required for the http transport; loopback is not authorization.',
      'HTTP_TOKEN_REQUIRED',
    );
  }

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
    'DEVSPACE_OWNER_TOKEN_REF',
  );

  // We trigger the 302 ourselves and read the code from it, so the redirect URI
  // is never contacted. It still must not be able to smuggle the code elsewhere.
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
    transport,
    listenHost,
    listenPort,
    socketPath: transport === 'unix' ? socketPath : null,
    httpTokenRef,
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
    oauthTimeoutMs: parsePositiveInteger(
      env.ADAPTER_OAUTH_TIMEOUT_MS, DEFAULT_OAUTH_TIMEOUT_MS, 'INVALID_OAUTH_TIMEOUT_MS',
    ),
    refreshSkewSeconds: parsePositiveInteger(
      env.ADAPTER_REFRESH_SKEW_SECONDS, DEFAULT_REFRESH_SKEW_SECONDS, 'INVALID_REFRESH_SKEW_SECONDS',
    ),
  });
}
