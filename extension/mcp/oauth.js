import { normalizeMcpEndpoint } from './streamable-http.js';

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_AUTHORIZATION_SERVERS = 8;
const MAX_SCOPES = 128;
const MAX_SCOPE_LENGTH = 256;
const UTF8 = new TextEncoder();

export class McpOAuthError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'McpOAuthError';
    this.code = code;
    this.status = options.status ?? null;
  }
}

function normalizeHttpsUrl(value, code = 'INVALID_OAUTH_URL') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new McpOAuthError('OAuth URL must be a bounded HTTPS URL.', code);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError('OAuth URL is invalid.', code);
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new McpOAuthError('OAuth URL must be HTTPS without credentials or fragments.', code);
  }
  return url.toString();
}

function normalizeIssuer(value) {
  const normalized = normalizeHttpsUrl(value, 'INVALID_ISSUER');
  const url = new URL(normalized);
  url.search = '';
  return url.toString();
}

function parseScopes(value) {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length > MAX_SCOPES) {
    throw new McpOAuthError('OAuth scopes_supported is invalid.', 'INVALID_SCOPES');
  }

  const scopes = [];
  const seen = new Set();
  for (const scope of value) {
    if (
      typeof scope !== 'string' ||
      scope.length === 0 ||
      scope.length > MAX_SCOPE_LENGTH ||
      !/^[\x21-\x7e]+$/.test(scope)
    ) {
      throw new McpOAuthError('OAuth scope contains invalid characters.', 'INVALID_SCOPE');
    }
    if (!seen.has(scope)) {
      scopes.push(scope);
      seen.add(scope);
    }
  }
  return Object.freeze(scopes);
}

async function readBoundedJson(response) {
  if (!response.body) {
    throw new McpOAuthError('OAuth metadata response is empty.', 'EMPTY_METADATA', {
      status: response.status,
    });
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
    throw new McpOAuthError('OAuth metadata exceeds the size limit.', 'METADATA_TOO_LARGE');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > MAX_METADATA_BYTES) {
      await reader.cancel();
      throw new McpOAuthError('OAuth metadata exceeds the size limit.', 'METADATA_TOO_LARGE');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpOAuthError('OAuth metadata is not valid JSON.', 'INVALID_METADATA_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpOAuthError('OAuth metadata must be a JSON object.', 'INVALID_METADATA');
  }
  return parsed;
}

async function fetchMetadata(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  allowOrigin = null,
} = {}) {
  const normalized = normalizeHttpsUrl(url);
  if (typeof fetchImpl !== 'function') {
    throw new McpOAuthError('OAuth discovery requires fetch.', 'MISSING_FETCH');
  }
  if (allowOrigin !== null) {
    if (typeof allowOrigin !== 'function' || await allowOrigin(new URL(normalized).origin) !== true) {
      throw new McpOAuthError('OAuth metadata origin has not been explicitly approved.', 'ORIGIN_NOT_APPROVED');
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(normalized, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new McpOAuthError('OAuth metadata request timed out.', 'METADATA_TIMEOUT');
    }
    throw new McpOAuthError('OAuth metadata request failed.', 'METADATA_NETWORK_ERROR', { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new McpOAuthError('OAuth metadata redirects are not followed.', 'METADATA_REDIRECT', {
      status: response.status,
    });
  }
  if (!response.ok) {
    throw new McpOAuthError('OAuth metadata endpoint returned an HTTP error.', 'METADATA_HTTP_ERROR', {
      status: response.status,
    });
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new McpOAuthError('OAuth metadata must use application/json.', 'METADATA_CONTENT_TYPE');
  }

  return readBoundedJson(response);
}

export function protectedResourceMetadataCandidates(endpoint, challengeUrl = null) {
  const endpointUrl = new URL(normalizeMcpEndpoint(endpoint));
  if (challengeUrl !== null) {
    const challenge = new URL(normalizeHttpsUrl(challengeUrl, 'INVALID_RESOURCE_METADATA_URL'));
    if (challenge.origin !== endpointUrl.origin) {
      throw new McpOAuthError(
        'Cross-origin protected-resource metadata requires an explicit future trust policy.',
        'RESOURCE_METADATA_ORIGIN_MISMATCH',
      );
    }
    return Object.freeze([challenge.toString()]);
  }

  const path = endpointUrl.pathname.replace(/^\/+/, '');
  const candidates = [];
  if (path) {
    candidates.push(`${endpointUrl.origin}/.well-known/oauth-protected-resource/${path}`);
  }
  candidates.push(`${endpointUrl.origin}/.well-known/oauth-protected-resource`);
  return Object.freeze([...new Set(candidates)]);
}

function normalizeProtectedResourceMetadata(metadata, endpoint) {
  if (!Array.isArray(metadata.authorization_servers)) {
    throw new McpOAuthError(
      'Protected Resource Metadata must contain authorization_servers.',
      'MISSING_AUTHORIZATION_SERVERS',
    );
  }
  if (
    metadata.authorization_servers.length === 0 ||
    metadata.authorization_servers.length > MAX_AUTHORIZATION_SERVERS
  ) {
    throw new McpOAuthError('Protected Resource Metadata has an invalid authorization server count.', 'AUTHORIZATION_SERVER_COUNT');
  }

  const authorizationServers = metadata.authorization_servers.map(normalizeIssuer);
  const resource = metadata.resource === undefined
    ? normalizeMcpEndpoint(endpoint)
    : normalizeHttpsUrl(metadata.resource, 'INVALID_RESOURCE');

  return Object.freeze({
    resource,
    authorizationServers: Object.freeze(authorizationServers),
    scopesSupported: parseScopes(metadata.scopes_supported),
  });
}

export async function discoverProtectedResourceMetadata({
  endpoint,
  challengeUrl = null,
  fetchImpl = globalThis.fetch,
  allowOrigin = null,
} = {}) {
  const candidates = protectedResourceMetadataCandidates(endpoint, challengeUrl);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const metadata = await fetchMetadata(candidate, { fetchImpl, allowOrigin });
      return Object.freeze({
        metadataUrl: candidate,
        ...normalizeProtectedResourceMetadata(metadata, endpoint),
      });
    } catch (error) {
      lastError = error;
      if (challengeUrl !== null || !(error instanceof McpOAuthError) || error.status === null || ![404, 405].includes(error.status)) {
        throw error;
      }
    }
  }

  throw lastError ?? new McpOAuthError('Protected Resource Metadata was not found.', 'RESOURCE_METADATA_NOT_FOUND');
}

export function authorizationServerMetadataCandidates(issuer) {
  const normalizedIssuer = normalizeIssuer(issuer);
  const issuerUrl = new URL(normalizedIssuer);
  const path = issuerUrl.pathname.replace(/^\/+|\/+$/g, '');

  if (!path) {
    return Object.freeze([
      `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
      `${issuerUrl.origin}/.well-known/openid-configuration`,
    ]);
  }

  return Object.freeze([
    `${issuerUrl.origin}/.well-known/oauth-authorization-server/${path}`,
    `${issuerUrl.origin}/.well-known/openid-configuration/${path}`,
    `${issuerUrl.origin}/${path}/.well-known/openid-configuration`,
  ]);
}

function normalizeAuthorizationServerMetadata(metadata, expectedIssuer) {
  const issuer = normalizeIssuer(metadata.issuer);
  if (issuer !== normalizeIssuer(expectedIssuer)) {
    throw new McpOAuthError('Authorization server metadata issuer does not match discovery issuer.', 'ISSUER_MISMATCH');
  }

  const authorizationEndpoint = normalizeHttpsUrl(metadata.authorization_endpoint, 'INVALID_AUTHORIZATION_ENDPOINT');
  const tokenEndpoint = normalizeHttpsUrl(metadata.token_endpoint, 'INVALID_TOKEN_ENDPOINT');
  const methods = metadata.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes('S256')) {
    throw new McpOAuthError('Authorization server does not advertise PKCE S256 support.', 'PKCE_S256_REQUIRED');
  }

  return Object.freeze({
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: metadata.registration_endpoint === undefined
      ? null
      : normalizeHttpsUrl(metadata.registration_endpoint, 'INVALID_REGISTRATION_ENDPOINT'),
    clientIdMetadataDocumentSupported: metadata.client_id_metadata_document_supported === true,
    scopesSupported: parseScopes(metadata.scopes_supported),
    codeChallengeMethodsSupported: Object.freeze(methods.filter((value) => typeof value === 'string').slice(0, 32)),
  });
}

export async function discoverAuthorizationServerMetadata({
  issuer,
  fetchImpl = globalThis.fetch,
  allowOrigin,
} = {}) {
  if (typeof allowOrigin !== 'function') {
    throw new McpOAuthError(
      'Authorization server discovery requires an explicit origin approval callback.',
      'ORIGIN_APPROVAL_REQUIRED',
    );
  }

  const candidates = authorizationServerMetadataCandidates(issuer);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const metadata = await fetchMetadata(candidate, { fetchImpl, allowOrigin });
      return Object.freeze({
        metadataUrl: candidate,
        ...normalizeAuthorizationServerMetadata(metadata, issuer),
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof McpOAuthError) || error.status === null || ![404, 405].includes(error.status)) {
        throw error;
      }
    }
  }
  throw lastError ?? new McpOAuthError('Authorization server metadata was not found.', 'AUTHORIZATION_METADATA_NOT_FOUND');
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function createPkce() {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new McpOAuthError('Secure Web Crypto is required for OAuth PKCE.', 'WEB_CRYPTO_REQUIRED');
  }

  const verifierBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(verifierBytes);
  const verifier = base64Url(verifierBytes);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', UTF8.encode(verifier)),
  );
  return Object.freeze({
    verifier,
    challenge: base64Url(digest),
    method: 'S256',
  });
}

export function createOAuthState() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new McpOAuthError('Secure Web Crypto is required for OAuth state.', 'WEB_CRYPTO_REQUIRED');
  }
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function buildAuthorizationUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  resource,
  scopes = [],
  state,
  codeChallenge,
} = {}) {
  const url = new URL(normalizeHttpsUrl(authorizationEndpoint, 'INVALID_AUTHORIZATION_ENDPOINT'));
  const normalizedClientId = typeof clientId === 'string' && clientId.length <= 4096 ? clientId : null;
  const normalizedRedirect = typeof redirectUri === 'string' && redirectUri.length <= 4096 ? redirectUri : null;
  const normalizedState = typeof state === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(state) ? state : null;
  const normalizedChallenge = typeof codeChallenge === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)
    ? codeChallenge
    : null;

  if (!normalizedClientId || !normalizedRedirect || !normalizedState || !normalizedChallenge) {
    throw new McpOAuthError('OAuth authorization request parameters are invalid.', 'INVALID_AUTHORIZATION_REQUEST');
  }

  const resourceUrl = normalizeHttpsUrl(resource, 'INVALID_RESOURCE');
  const scopeList = parseScopes(scopes);
  url.search = '';
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', normalizedClientId);
  url.searchParams.set('redirect_uri', normalizedRedirect);
  url.searchParams.set('state', normalizedState);
  url.searchParams.set('code_challenge', normalizedChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', resourceUrl);
  if (scopeList.length > 0) {
    url.searchParams.set('scope', scopeList.join(' '));
  }

  return url.toString();
}
