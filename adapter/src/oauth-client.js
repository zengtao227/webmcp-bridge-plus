import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DevSpaceOAuthError } from './errors.js';
import { readBoundedJson, readBoundedText, fetchWithTimeout } from './bounded.js';

export { DevSpaceOAuthError };

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_AUTHORIZATION_SERVERS = 8;

export function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return Object.freeze({ verifier, challenge, method: 'S256' });
}

export function protectedResourceMetadataCandidates(mcpUrl) {
  const url = new URL(mcpUrl);
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  const candidates = [];
  if (path) {
    candidates.push(`${url.origin}/.well-known/oauth-protected-resource/${path}`);
  }
  candidates.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return Object.freeze([...new Set(candidates)]);
}

export function authorizationServerMetadataUrl(issuer) {
  const issuerUrl = new URL(issuer);
  const metadataUrl = new URL(issuerUrl.toString());
  metadataUrl.search = '';
  metadataUrl.hash = '';
  metadataUrl.pathname = `${issuerUrl.pathname.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`;
  return metadataUrl.toString();
}

function normalizeIssuer(value) {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

async function fetchMetadata(fetchImpl, url, timeoutMs) {
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      cache: 'no-store',
    }, timeoutMs);
  } catch (error) {
    if (error instanceof DevSpaceOAuthError && error.code === 'REQUEST_TIMEOUT') {
      throw new DevSpaceOAuthError('OAuth metadata request timed out.', 'METADATA_TIMEOUT', { cause: error });
    }
    throw new DevSpaceOAuthError('OAuth metadata request failed.', 'METADATA_NETWORK_ERROR', { cause: error });
  }

  if (response.status >= 300 && response.status < 400) {
    throw new DevSpaceOAuthError('OAuth metadata redirects are not followed.', 'METADATA_REDIRECT', {
      status: response.status,
    });
  }
  if (!response.ok) {
    throw new DevSpaceOAuthError('OAuth metadata endpoint returned an HTTP error.', 'METADATA_HTTP_ERROR', {
      status: response.status,
    });
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new DevSpaceOAuthError('OAuth metadata must use application/json.', 'METADATA_CONTENT_TYPE');
  }
  try {
    return await readBoundedJson(response, MAX_METADATA_BYTES);
  } catch (error) {
    if (error instanceof DevSpaceOAuthError && error.code === 'RESPONSE_TOO_LARGE') {
      throw new DevSpaceOAuthError('OAuth metadata exceeds the size limit.', 'METADATA_TOO_LARGE');
    }
    if (error instanceof DevSpaceOAuthError && error.code === 'INVALID_JSON') {
      throw new DevSpaceOAuthError('OAuth metadata is not valid JSON.', 'INVALID_METADATA_JSON');
    }
    throw error;
  }
}

export class DevSpaceOAuthClient {
  #options;
  #fetchImpl;
  #now;
  #log;
  #timeoutMs;
  #metadata = null;
  #client = null;
  #token = null;
  #inflight = null;

  constructor({
    upstreamMcpUrl,
    resource,
    ownerToken,
    clientName = 'webmcp-bridge-private-adapter',
    redirectUri = 'http://127.0.0.1:8787/oauth/callback',
    scopes = ['devspace'],
    refreshSkewSeconds = 300,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    timeoutMs = 10_000,
    log = () => {},
  } = {}) {
    if (typeof upstreamMcpUrl !== 'string' || upstreamMcpUrl.length === 0) {
      throw new DevSpaceOAuthError('upstreamMcpUrl is required.', 'INVALID_OPTIONS');
    }
    if (typeof ownerToken !== 'string' || ownerToken.length === 0) {
      throw new DevSpaceOAuthError('ownerToken is required.', 'INVALID_OPTIONS');
    }
    if (typeof fetchImpl !== 'function') {
      throw new DevSpaceOAuthError('fetch implementation is required.', 'INVALID_OPTIONS');
    }

    this.#options = Object.freeze({
      upstreamMcpUrl,
      resource: resource ?? upstreamMcpUrl,
      ownerToken,
      clientName,
      redirectUri,
      scopes: Object.freeze([...scopes]),
      refreshSkewSeconds,
    });
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#log = log;
    this.#timeoutMs = timeoutMs;
  }

  get hasToken() {
    return this.#token !== null;
  }

  async getAccessToken() {
    if (this.#token) {
      const nowSeconds = Math.floor(this.#now() / 1000);
      if (this.#token.expiresAt - nowSeconds > this.#options.refreshSkewSeconds) {
        return this.#token.accessToken;
      }
    }
    if (!this.#inflight) {
      this.#inflight = this.#establish().finally(() => {
        this.#inflight = null;
      });
    }
    return this.#inflight;
  }

  invalidate() {
    if (this.#token) {
      this.#token = null;
      this.#log('token_invalidated', {});
    }
  }

  async #establish() {
    if (this.#token?.refreshToken) {
      try {
        await this.#refresh();
        this.#log('token_refreshed', {});
        return this.#token.accessToken;
      } catch (error) {
        this.#token = null;
        this.#log('token_refresh_failed', { code: error.code ?? 'UNKNOWN' });
      }
    }
    await this.#authorizeAndExchange();
    this.#log('token_issued', {});
    return this.#token.accessToken;
  }

  async #authorizeAndExchange() {
    const metadata = await this.#discover();
    const client = await this.#register(metadata);
    const pkce = createPkce();
    const state = randomUUID();
    const code = await this.#requestAuthorizationCode(metadata, client, pkce, state);
    await this.#exchangeCode(metadata, client, pkce, code);
  }

  // Every OAuth round trip is time bounded. A peer that never answers must not
  // hold the adapter open, and a hang here would look like "unavailable" to the
  // caller with no explanation.
  async #post(url, headers, body) {
    try {
      return await fetchWithTimeout(this.#fetchImpl, url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        cache: 'no-store',
      }, this.#timeoutMs);
    } catch (error) {
      if (error instanceof DevSpaceOAuthError && error.code === 'REQUEST_TIMEOUT') {
        throw new DevSpaceOAuthError('OAuth request timed out.', 'OAUTH_TIMEOUT', { cause: error });
      }
      throw new DevSpaceOAuthError('OAuth request failed.', 'OAUTH_NETWORK_ERROR', { cause: error });
    }
  }

  // Metadata may advertise a public origin that is unreachable from here
  // (that is the whole point of the tunnel). Always talk to the upstream we
  // were configured with, keeping the advertised path.
  #toUpstream(urlString) {
    const url = new URL(urlString);
    const upstream = new URL(this.#options.upstreamMcpUrl);
    url.protocol = upstream.protocol;
    url.host = upstream.host;
    return url.toString();
  }

  async #discover() {
    if (this.#metadata) {
      return this.#metadata;
    }

    const candidates = protectedResourceMetadataCandidates(this.#options.upstreamMcpUrl);
    let lastError = null;
    let authorizationServers = null;

    for (const candidate of candidates) {
      try {
        const metadata = await fetchMetadata(this.#fetchImpl, candidate, this.#timeoutMs);
        if (!Array.isArray(metadata.authorization_servers)) {
          throw new DevSpaceOAuthError(
            'Protected resource metadata must contain authorization_servers.',
            'MISSING_AUTHORIZATION_SERVERS',
          );
        }
        if (
          metadata.authorization_servers.length === 0 ||
          metadata.authorization_servers.length > MAX_AUTHORIZATION_SERVERS
        ) {
          throw new DevSpaceOAuthError(
            'Protected resource metadata has an invalid authorization server count.',
            'AUTHORIZATION_SERVER_COUNT',
          );
        }
        authorizationServers = metadata.authorization_servers
          .filter((value) => typeof value === 'string')
          .map((value) => normalizeIssuer(value));
        if (authorizationServers.length > 0) {
          break;
        }
        authorizationServers = null;
      } catch (error) {
        lastError = error;
        if (!(error instanceof DevSpaceOAuthError) || ![404, 405].includes(error.status)) {
          throw error;
        }
      }
    }

    if (!authorizationServers) {
      throw lastError ?? new DevSpaceOAuthError(
        'Protected resource metadata was not found.',
        'RESOURCE_METADATA_NOT_FOUND',
      );
    }

    const issuer = authorizationServers[0];
    // The issuer may be a public origin that is unreachable from here; fetch
    // the metadata document from the upstream we were configured with.
    const metadata = await fetchMetadata(
      this.#fetchImpl,
      this.#toUpstream(authorizationServerMetadataUrl(issuer)),
      this.#timeoutMs,
    );

    if (typeof metadata.issuer !== 'string' || normalizeIssuer(metadata.issuer) !== issuer) {
      throw new DevSpaceOAuthError(
        'Authorization server metadata issuer does not match discovery issuer.',
        'ISSUER_MISMATCH',
      );
    }
    if (!Array.isArray(metadata.code_challenge_methods_supported) ||
        !metadata.code_challenge_methods_supported.includes('S256')) {
      throw new DevSpaceOAuthError(
        'Authorization server does not advertise PKCE S256 support.',
        'PKCE_S256_REQUIRED',
      );
    }
    for (const key of ['authorization_endpoint', 'token_endpoint']) {
      if (typeof metadata[key] !== 'string' || metadata[key].length === 0) {
        throw new DevSpaceOAuthError(
          `Authorization server metadata is missing ${key}.`,
          'INCOMPLETE_AUTHORIZATION_METADATA',
        );
      }
    }

    this.#metadata = Object.freeze({
      issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      registrationEndpoint: typeof metadata.registration_endpoint === 'string'
        ? metadata.registration_endpoint
        : null,
    });
    return this.#metadata;
  }

  async #register(metadata) {
    if (this.#client) {
      return this.#client;
    }
    if (!metadata.registrationEndpoint) {
      throw new DevSpaceOAuthError(
        'DevSpace did not advertise dynamic client registration.',
        'REGISTRATION_UNAVAILABLE',
      );
    }

    const response = await this.#post(this.#toUpstream(metadata.registrationEndpoint), {
      'content-type': 'application/json',
      accept: 'application/json',
    }, JSON.stringify({
      client_name: this.#options.clientName,
      redirect_uris: [this.#options.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.#options.scopes.join(' '),
    }));

    if (!response.ok) {
      throw new DevSpaceOAuthError('Dynamic client registration failed.', 'REGISTRATION_FAILED', {
        status: response.status,
      });
    }
    const body = await readBoundedJson(response, MAX_METADATA_BYTES);
    if (typeof body.client_id !== 'string' || body.client_id.length === 0) {
      throw new DevSpaceOAuthError('Registration response has no client_id.', 'REGISTRATION_INVALID');
    }

    this.#client = Object.freeze({ clientId: body.client_id });
    return this.#client;
  }

  async #requestAuthorizationCode(metadata, client, pkce, state) {
    const body = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: this.#options.redirectUri,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
      scope: this.#options.scopes.join(' '),
      resource: this.#options.resource,
      owner_token: this.#options.ownerToken,
    });

    const response = await this.#post(this.#toUpstream(metadata.authorizationEndpoint), {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/json',
    }, body.toString());

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new DevSpaceOAuthError('Authorization redirect has no Location header.', 'AUTHORIZATION_NO_LOCATION');
      }
      const redirect = new URL(location, this.#options.redirectUri);
      const code = redirect.searchParams.get('code');
      const returnedState = redirect.searchParams.get('state');
      if (!code) {
        throw new DevSpaceOAuthError('Authorization redirect has no code.', 'AUTHORIZATION_NO_CODE');
      }
      // A missing state is not acceptable: it is the only thing binding this
      // response to the request we made.
      if (returnedState === null) {
        throw new DevSpaceOAuthError('Authorization redirect has no state.', 'STATE_MISSING');
      }
      if (returnedState !== state) {
        throw new DevSpaceOAuthError('Authorization state mismatch.', 'STATE_MISMATCH');
      }
      return code;
    }

    // DevSpace answers a wrong owner password with HTTP 200 and the login form.
    if (response.status === 200 || response.status === 401 || response.status === 403) {
      throw new DevSpaceOAuthError('DevSpace rejected the owner password.', 'INVALID_OWNER_TOKEN', {
        status: response.status,
      });
    }
    throw new DevSpaceOAuthError('Authorization request failed.', 'AUTHORIZATION_FAILED', {
      status: response.status,
    });
  }

  async #postToken(metadata, params) {
    const body = new URLSearchParams({
      client_id: (await this.#register(metadata)).clientId,
      resource: this.#options.resource,
      ...params,
    });

    const response = await this.#post(this.#toUpstream(metadata.tokenEndpoint), {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    }, body.toString());

    if (!response.ok) {
      throw new DevSpaceOAuthError('Token request was rejected.', 'TOKEN_REQUEST_FAILED', {
        status: response.status,
      });
    }
    const payload = await readBoundedJson(response, MAX_METADATA_BYTES);
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new DevSpaceOAuthError('Token response has no access_token.', 'TOKEN_RESPONSE_INVALID');
    }
    const expiresIn = Number(payload.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new DevSpaceOAuthError('Token response has an invalid expires_in.', 'TOKEN_RESPONSE_INVALID');
    }

    this.#token = Object.freeze({
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
      expiresAt: Math.floor(this.#now() / 1000) + Math.floor(expiresIn),
      scope: typeof payload.scope === 'string' ? payload.scope : this.#options.scopes.join(' '),
    });
    return this.#token;
  }

  async #exchangeCode(metadata, client, pkce, code) {
    return this.#postToken(metadata, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.#options.redirectUri,
      code_verifier: pkce.verifier,
    });
  }

  async #refresh() {
    const metadata = await this.#discover();
    const refreshToken = this.#token?.refreshToken;
    if (!refreshToken) {
      throw new DevSpaceOAuthError('No refresh token is available.', 'NO_REFRESH_TOKEN');
    }
    return this.#postToken(metadata, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: this.#options.scopes.join(' '),
    });
  }
}
