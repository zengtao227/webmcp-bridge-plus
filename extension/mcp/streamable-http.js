export const MCP_REVISION_CURRENT = '2026-07-28';
export const MCP_REVISION_LEGACY = '2025-11-25';

const SUPPORTED_REVISIONS = new Set([
  MCP_REVISION_CURRENT,
  MCP_REVISION_LEGACY,
]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 1024;
const MAX_ACCESS_TOKEN_LENGTH = 16 * 1024;
const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';

export class McpTransportError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'McpTransportError';
    this.code = code;
    this.status = options.status ?? null;
  }
}

export class McpAuthorizationRequiredError extends McpTransportError {
  constructor({ status, resourceMetadataUrl = null, scopes = [], oauthError = null }) {
    super('MCP endpoint requires authorization.', 'AUTHORIZATION_REQUIRED', { status });
    this.name = 'McpAuthorizationRequiredError';
    this.resourceMetadataUrl = resourceMetadataUrl;
    this.scopes = Object.freeze([...scopes]);
    this.oauthError = oauthError;
  }
}

export function normalizeMcpEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 4096) {
    throw new McpTransportError('MCP endpoint must be a bounded HTTPS URL.', 'INVALID_ENDPOINT');
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new McpTransportError('MCP endpoint is not a valid URL.', 'INVALID_ENDPOINT');
  }

  if (url.protocol !== 'https:') {
    throw new McpTransportError('MCP endpoint must use HTTPS.', 'INSECURE_ENDPOINT');
  }
  if (url.username || url.password) {
    throw new McpTransportError('MCP endpoint must not contain URL credentials.', 'ENDPOINT_CREDENTIALS');
  }
  if (url.hash) {
    throw new McpTransportError('MCP endpoint must not contain a fragment.', 'ENDPOINT_FRAGMENT');
  }

  return url.toString();
}

function normalizeMetadataUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function parseBearerChallenge(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length > 16 * 1024) {
    return Object.freeze({ resourceMetadataUrl: null, scopes: [], oauthError: null });
  }

  const bearer = /(?:^|,)\s*Bearer\s+([^]*?)(?=(?:,\s*[A-Za-z][A-Za-z0-9_-]*\s)|$)/i.exec(headerValue);
  const input = bearer?.[1] ?? headerValue.match(/^\s*Bearer\s+([^]*)$/i)?.[1] ?? '';
  const params = Object.create(null);
  const parameterPattern = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([^,\s]+))/g;

  for (const match of input.matchAll(parameterPattern)) {
    const key = match[1].toLowerCase();
    const rawValue = match[2] ?? match[3] ?? '';
    const value = rawValue.replace(/\\(["\\])/g, '$1');
    if (!(key in params) && value.length <= 4096) {
      params[key] = value;
    }
  }

  const scopes = typeof params.scope === 'string'
    ? params.scope.split(/\s+/).filter((scope) => /^[\x21-\x7e]{1,256}$/.test(scope)).slice(0, 64)
    : [];

  return Object.freeze({
    resourceMetadataUrl: normalizeMetadataUrl(params.resource_metadata),
    scopes: Object.freeze(scopes),
    oauthError: typeof params.error === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(params.error)
      ? params.error
      : null,
  });
}

function validateAccessToken(token) {
  if (token === null || token === undefined || token === '') {
    return null;
  }
  if (
    typeof token !== 'string' ||
    token.length > MAX_ACCESS_TOKEN_LENGTH ||
    /[\r\n\0]/.test(token)
  ) {
    throw new McpTransportError('Access token provider returned an invalid token.', 'INVALID_ACCESS_TOKEN');
  }
  return token;
}

async function readBoundedText(response) {
  if (!response.body) {
    return '';
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new McpTransportError('MCP response exceeds the size limit.', 'RESPONSE_TOO_LARGE');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new McpTransportError('MCP response exceeds the size limit.', 'RESPONSE_TOO_LARGE');
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

function validateJsonRpcMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    throw new McpTransportError('MCP response is not a valid JSON-RPC 2.0 message.', 'INVALID_JSON_RPC');
  }
  return message;
}

function parseJsonMessage(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new McpTransportError('MCP response is not valid JSON.', 'INVALID_JSON');
  }
  return validateJsonRpcMessage(message);
}

function parseSseMessages(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) {
      continue;
    }

    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      continue;
    }
    messages.push(parseJsonMessage(data));
    if (messages.length > 1024) {
      throw new McpTransportError('MCP SSE response contains too many messages.', 'TOO_MANY_MESSAGES');
    }
  }
  return messages;
}

function selectResponseMessage(messages, requestId) {
  let selected = null;
  for (const message of messages) {
    if ('id' in message && message.id === requestId) {
      if (selected !== null) {
        throw new McpTransportError('MCP returned duplicate responses for one request.', 'DUPLICATE_RESPONSE');
      }
      selected = message;
      continue;
    }

    if ('id' in message && typeof message.method === 'string') {
      throw new McpTransportError(
        'MCP server-to-client requests are not supported by this minimal client.',
        'UNSUPPORTED_SERVER_REQUEST',
      );
    }
  }

  if (selected === null) {
    throw new McpTransportError('MCP response did not contain the matching request id.', 'MISSING_RESPONSE');
  }
  return selected;
}

function validateSessionId(value) {
  if (value === null) {
    return null;
  }
  if (
    value.length === 0 ||
    value.length > MAX_SESSION_ID_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new McpTransportError('MCP server returned an invalid session id.', 'INVALID_SESSION_ID');
  }
  return value;
}

function responseResult(message) {
  if (message.error && typeof message.error === 'object') {
    const code = Number.isInteger(message.error.code) ? message.error.code : null;
    throw new McpTransportError(
      `MCP JSON-RPC request failed${code === null ? '' : ` with code ${code}`}.`,
      'JSON_RPC_ERROR',
    );
  }
  if (!('result' in message)) {
    throw new McpTransportError('MCP JSON-RPC response has no result.', 'MISSING_RESULT');
  }
  return message.result;
}

export class StreamableHttpTransport {
  #endpoint;
  #revision;
  #fetch;
  #accessTokenProvider;
  #timeoutMs;
  #clientInfo;
  #clientCapabilities;
  #nextId = 1;
  #legacySessionId = null;
  #legacyInitialized = false;

  constructor({
    endpoint,
    revision = MCP_REVISION_CURRENT,
    fetchImpl = globalThis.fetch,
    accessTokenProvider = null,
    timeoutMs = 30_000,
    clientInfo = { name: 'webmcp-bridge', version: '0.1.0' },
    clientCapabilities = {},
  } = {}) {
    this.#endpoint = normalizeMcpEndpoint(endpoint);
    if (!SUPPORTED_REVISIONS.has(revision)) {
      throw new McpTransportError('Unsupported MCP protocol revision.', 'UNSUPPORTED_REVISION');
    }
    if (typeof fetchImpl !== 'function') {
      throw new McpTransportError('A fetch implementation is required.', 'MISSING_FETCH');
    }
    if (accessTokenProvider !== null && typeof accessTokenProvider !== 'function') {
      throw new McpTransportError('Access token provider must be a function.', 'INVALID_TOKEN_PROVIDER');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new McpTransportError('MCP timeout must be between 1s and 120s.', 'INVALID_TIMEOUT');
    }

    this.#revision = revision;
    this.#fetch = fetchImpl;
    this.#accessTokenProvider = accessTokenProvider;
    this.#timeoutMs = timeoutMs;
    this.#clientInfo = Object.freeze({
      name: String(clientInfo?.name ?? 'webmcp-bridge').slice(0, 128),
      version: String(clientInfo?.version ?? '0.1.0').slice(0, 64),
    });
    this.#clientCapabilities = clientCapabilities && typeof clientCapabilities === 'object'
      ? structuredClone(clientCapabilities)
      : {};
  }

  get revision() {
    return this.#revision;
  }

  get endpoint() {
    return this.#endpoint;
  }

  async connect() {
    if (this.#revision === MCP_REVISION_CURRENT) {
      return Object.freeze({ revision: this.#revision, sessionId: null });
    }
    if (this.#legacyInitialized) {
      return Object.freeze({ revision: this.#revision, sessionId: this.#legacySessionId });
    }

    const { result, response } = await this.#sendRequest('initialize', {
      protocolVersion: MCP_REVISION_LEGACY,
      capabilities: this.#clientCapabilities,
      clientInfo: this.#clientInfo,
    }, { includeProtocolHeader: false, requireLegacySession: false });

    if (
      !result ||
      typeof result !== 'object' ||
      result.protocolVersion !== MCP_REVISION_LEGACY
    ) {
      throw new McpTransportError('MCP server negotiated an unsupported legacy revision.', 'REVISION_MISMATCH');
    }

    this.#legacySessionId = validateSessionId(response.headers.get('mcp-session-id'));
    await this.#sendNotification('notifications/initialized', {});
    this.#legacyInitialized = true;

    return Object.freeze({
      revision: this.#revision,
      sessionId: this.#legacySessionId,
    });
  }

  async request(method, params = {}) {
    if (typeof method !== 'string' || !/^[A-Za-z0-9_./-]{1,128}$/.test(method)) {
      throw new McpTransportError('Invalid MCP method name.', 'INVALID_METHOD');
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new McpTransportError('MCP request params must be an object.', 'INVALID_PARAMS');
    }
    if (this.#revision === MCP_REVISION_LEGACY && !this.#legacyInitialized) {
      throw new McpTransportError('Legacy MCP transport must be connected before requests.', 'NOT_CONNECTED');
    }

    const { result } = await this.#sendRequest(method, params);
    return result;
  }

  #modernParams(params) {
    const meta = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta)
      ? { ...params._meta }
      : {};

    meta[PROTOCOL_VERSION_KEY] = MCP_REVISION_CURRENT;
    meta[CLIENT_CAPABILITIES_KEY] = structuredClone(this.#clientCapabilities);
    meta[CLIENT_INFO_KEY] = this.#clientInfo;

    return { ...params, _meta: meta };
  }

  async #baseHeaders(method, params, includeProtocolHeader = true) {
    const headers = new Headers({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    });

    if (includeProtocolHeader) {
      headers.set('MCP-Protocol-Version', this.#revision);
    }
    if (this.#revision === MCP_REVISION_CURRENT) {
      headers.set('Mcp-Method', method);
      if (typeof params.name === 'string') {
        headers.set('Mcp-Name', params.name);
      }
    } else if (this.#legacySessionId !== null) {
      headers.set('Mcp-Session-Id', this.#legacySessionId);
    }

    if (this.#accessTokenProvider !== null) {
      let token;
      try {
        token = validateAccessToken(await this.#accessTokenProvider());
      } catch (error) {
        if (error instanceof McpTransportError) {
          throw error;
        }
        throw new McpTransportError('Access token provider failed.', 'TOKEN_PROVIDER_FAILED', { cause: error });
      }
      if (token !== null) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    }

    return headers;
  }

  async #fetchJsonRpc(body, headers) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      return await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new McpTransportError('MCP request timed out.', 'TIMEOUT');
      }
      throw new McpTransportError('MCP network request failed.', 'NETWORK_ERROR', { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #checkHttpResponse(response) {
    if (response.status === 401 || response.status === 403) {
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
      throw new McpAuthorizationRequiredError({
        status: response.status,
        ...challenge,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new McpTransportError('MCP endpoint redirects are not followed.', 'REDIRECT_REJECTED', {
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new McpTransportError('MCP endpoint returned an HTTP error.', 'HTTP_ERROR', {
        status: response.status,
      });
    }
  }

  async #parseRequestResponse(response, requestId) {
    await this.#checkHttpResponse(response);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const text = await readBoundedText(response);

    if (contentType.includes('application/json')) {
      return selectResponseMessage([parseJsonMessage(text)], requestId);
    }
    if (contentType.includes('text/event-stream')) {
      return selectResponseMessage(parseSseMessages(text), requestId);
    }

    throw new McpTransportError('MCP response uses an unsupported content type.', 'UNSUPPORTED_CONTENT_TYPE');
  }

  async #sendRequest(method, params, {
    includeProtocolHeader = true,
    requireLegacySession = true,
  } = {}) {
    if (
      this.#revision === MCP_REVISION_LEGACY &&
      requireLegacySession &&
      !this.#legacyInitialized
    ) {
      throw new McpTransportError('Legacy MCP transport is not initialized.', 'NOT_CONNECTED');
    }

    const requestId = this.#nextId++;
    const wireParams = this.#revision === MCP_REVISION_CURRENT
      ? this.#modernParams(params)
      : params;
    const body = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params: wireParams,
    };
    const headers = await this.#baseHeaders(method, params, includeProtocolHeader);
    const response = await this.#fetchJsonRpc(body, headers);
    const message = await this.#parseRequestResponse(response, requestId);
    return { result: responseResult(message), response };
  }

  async #sendNotification(method, params) {
    const body = {
      jsonrpc: '2.0',
      method,
      params,
    };
    const headers = await this.#baseHeaders(method, params, true);
    const response = await this.#fetchJsonRpc(body, headers);
    await this.#checkHttpResponse(response);

    if (response.status !== 202) {
      throw new McpTransportError('MCP notification was not acknowledged with HTTP 202.', 'NOTIFICATION_REJECTED', {
        status: response.status,
      });
    }
  }
}
