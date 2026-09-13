// Transport-independent MCP handling.
//
// Both the stdio transport (tunnel-client spawns us) and the http/unix
// transports flow through here, so the Secret Firewall and the auth retry
// cannot be bypassed by choosing a different transport.

import { authorizeRequest, firewallResponse, deniedToolResult, FirewallError } from './firewall.js';
import { scrubAuthMetadata, localErrorEnvelope } from './sanitize.js';
import { DevSpaceOAuthError } from './errors.js';
import { readBoundedText } from './bounded.js';
import { routeOpenWorkspaceCall, rewriteToolsListPayload } from './project-registry.js';

const DEFAULT_ACCEPT = 'application/json, text/event-stream';
const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';
const LEGACY_PROTOCOL_VERSION = '2025-06-18';

// DevSpace answers these when *we* are not authenticated. They describe our
// local credential exchange, so they are terminal here: never forwarded, and
// never surfaced as a 401 the remote caller could mistake for an OAuth prompt.
const AUTH_CHALLENGE_STATUSES = new Set([401, 403]);

function upstreamTarget(config) {
  return new URL(config.mcpPath, `${config.upstreamBaseUrl}/`).toString();
}

function parseSseEvents(raw) {
  const events = [];
  let current = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed === '') {
      if (current) {
        events.push(current);
        current = null;
      }
      continue;
    }
    if (trimmed.startsWith(':')) {
      continue;
    }
    const separator = trimmed.indexOf(':');
    const field = separator === -1 ? trimmed : trimmed.slice(0, separator);
    let value = separator === -1 ? '' : trimmed.slice(separator + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (!current) {
      current = { event: null, data: [] };
    }
    if (field === 'data') {
      current.data.push(value);
    } else if (field === 'event') {
      current.event = value;
    }
  }
  if (current) {
    events.push(current);
  }
  return events;
}

function serializeSseEvents(events) {
  let out = '';
  for (const entry of events) {
    if (entry.event) {
      out += `event: ${entry.event}\n`;
    }
    out += `data: ${JSON.stringify(entry.payload)}\n\n`;
  }
  return out;
}

function hasSuccessfulResponse(raw, contentType, expectedId) {
  let payloads;
  try {
    if (contentType === 'sse') {
      payloads = parseSseEvents(raw)
        .filter((entry) => entry.data.length > 0)
        .map((entry) => JSON.parse(entry.data.join('\n')));
    } else if (contentType === 'json') {
      payloads = [JSON.parse(raw)];
    } else {
      return false;
    }
  } catch {
    return false;
  }

  return payloads.some((payload) => payload
    && payload.jsonrpc === '2.0'
    && payload.id === expectedId
    && payload.result
    && typeof payload.result === 'object'
    && !Array.isArray(payload.result));
}

export function createAdapterCore(config, {
  oauthClient,
  log = () => {},
  fetchImpl = globalThis.fetch,
  projectRegistry = null,
} = {}) {
  if (!oauthClient || typeof oauthClient.getAccessToken !== 'function') {
    throw new Error('createAdapterCore requires an oauth client.');
  }

  // Learned from DevSpace when the caller cannot carry the header (stdio).
  let sessionId = null;
  // True once DevSpace has actually issued us a token. /healthz reports this so
  // an operator can tell "adapter is up" from "adapter can reach DevSpace".
  let authenticated = false;

  async function callUpstream({
    method,
    body,
    clientSessionId,
    clientProtocolVersion,
    useSession,
    allowRetry,
    accept = DEFAULT_ACCEPT,
  }) {
    let token;
    try {
      token = await oauthClient.getAccessToken();
    } catch (error) {
      log('auth_failed', { code: error.code ?? 'UNKNOWN' });
      return { status: 502, payload: { error: 'upstream_auth_unavailable' }, contentType: 'json' };
    }
    authenticated = true;
    // The token is ours and lives only in this process; make sure it can never
    // appear in a log line even if something downstream stringifies a request.
    log.addSecret?.(token);

    const headers = {
      accept,
      authorization: `Bearer ${token}`,
    };
    if (body !== null) {
      headers['content-type'] = 'application/json';
    }
    const effectiveSession = useSession ? (clientSessionId ?? sessionId) : null;
    if (effectiveSession) {
      headers[SESSION_HEADER] = effectiveSession;
    }
    if (clientProtocolVersion) {
      headers[PROTOCOL_HEADER] = clientProtocolVersion;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
    let response;
    try {
      response = await fetchImpl(upstreamTarget(config), {
        method,
        headers,
        body: body ?? undefined,
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      log('upstream_unreachable', { code: error?.name ?? 'UNKNOWN' });
      return { status: 502, payload: { error: 'upstream_unavailable' }, contentType: 'json' };
    }

    if (response.status === 401 && allowRetry) {
      clearTimeout(timeout);
      // The container may have restarted and dropped its token store.
      oauthClient.invalidate();
      log('upstream_unauthorized_retry', {});
      return callUpstream({
        method, body, clientSessionId, clientProtocolVersion, useSession, allowRetry: false, accept,
      });
    }

    // DevSpace is telling *us* it does not accept our credential. Answering 401
    // to the remote caller would invite it to start an OAuth flow against a
    // loopback endpoint it can never reach, and the challenge body would carry
    // our authorization server URL. Terminate it here instead.
    if (AUTH_CHALLENGE_STATUSES.has(response.status)) {
      clearTimeout(timeout);
      oauthClient.invalidate();
      log('upstream_auth_rejected', { status: response.status });
      return { status: 502, payload: { error: 'upstream_auth_rejected' }, contentType: 'json' };
    }

    // Upstream headers are never copied forward, so WWW-Authenticate cannot
    // leak even by accident; only the session id is carried across.

    const upstreamSession = response.headers.get(SESSION_HEADER);
    if (upstreamSession) {
      sessionId = upstreamSession;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    let raw;
    try {
      raw = await readBoundedText(response, config.maxResponseBytes);
    } catch (error) {
      clearTimeout(timeout);
      const tooLarge = error?.code === 'RESPONSE_TOO_LARGE';
      log(tooLarge ? 'upstream_response_too_large' : 'upstream_response_failed', {
        code: error?.code ?? error?.name ?? 'UNKNOWN',
      });
      return {
        status: 502,
        payload: { error: tooLarge ? 'upstream_response_too_large' : 'upstream_response_unavailable' },
        contentType: 'json',
      };
    }
    clearTimeout(timeout);

    return {
      status: response.status,
      raw,
      contentType: contentType.includes('text/event-stream') ? 'sse'
        : contentType.includes('json') ? 'json'
          : 'other',
    };
  }

  function responsePayloadForRequest(parsed, requestMethod) {
    const sanitized = scrubAuthMetadata(parsed);
    return requestMethod === 'tools/list'
      ? rewriteToolsListPayload(sanitized, projectRegistry)
      : sanitized;
  }

  function firewallBody(raw, contentType, requestedPath, requestMethod) {
    if (contentType === 'sse') {
      const events = parseSseEvents(raw);
      let blocked = 0;
      let redacted = 0;
      const rebuilt = [];
      for (const entry of events) {
        if (entry.data.length === 0) {
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(entry.data.join('\n'));
        } catch {
          // Not JSON: drop rather than forward something we cannot inspect.
          log('upstream_event_unparsable', {});
          continue;
        }
        const result = firewallResponse(
          responsePayloadForRequest(parsed, requestMethod), requestedPath,
        );
        blocked += result.blocked;
        redacted += result.redacted;
        rebuilt.push({ event: entry.event, payload: result.payload });
      }
      if (blocked > 0 || redacted > 0) {
        log('firewall_applied', { blocked, redacted });
      }
      return { body: serializeSseEvents(rebuilt), blocked, redacted };
    }

    if (contentType !== 'json') {
      return null;
    }
    if (raw.trim().length === 0) {
      return { body: raw, blocked: 0, redacted: 0 };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log('upstream_body_unparsable', {});
      return null;
    }
    const result = firewallResponse(
      responsePayloadForRequest(parsed, requestMethod), requestedPath,
    );
    if (result.blocked > 0 || result.redacted > 0) {
      log('firewall_applied', result);
    }
    return { body: JSON.stringify(result.payload), blocked: result.blocked, redacted: result.redacted };
  }

  async function ensureLegacySession() {
    if (sessionId) {
      return true;
    }

    const initializeId = 'webmcp-adapter-initialize';
    const initializePayload = {
      jsonrpc: '2.0',
      id: initializeId,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: config.clientName, version: '1' },
      },
    };
    const initialized = await callUpstream({
      method: 'POST',
      body: JSON.stringify(initializePayload),
      clientSessionId: null,
      clientProtocolVersion: null,
      useSession: false,
      allowRetry: true,
      accept: DEFAULT_ACCEPT,
    });

    if (initialized.status !== 200
      || !sessionId
      || !hasSuccessfulResponse(initialized.raw ?? '', initialized.contentType, initializeId)) {
      sessionId = null;
      log('legacy_session_initialize_failed', { status: initialized.status });
      return false;
    }

    const notification = await callUpstream({
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      clientSessionId: null,
      clientProtocolVersion: null,
      useSession: true,
      allowRetry: true,
      accept: DEFAULT_ACCEPT,
    });
    if (notification.status < 200 || notification.status >= 300) {
      sessionId = null;
      log('legacy_session_notification_failed', { status: notification.status });
      return false;
    }

    log('legacy_session_restored', {});
    return true;
  }

  /**
   * Handle one JSON-RPC payload.
   * Returns { status, body, contentType } where body is already redacted.
   */
  async function handle(payload, {
    clientSessionId = null,
    clientProtocolVersion = null,
    method: httpMethod = 'POST',
    accept = DEFAULT_ACCEPT,
    restoreSession = false,
  } = {}) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        status: 400,
        contentType: 'json',
        body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
      };
    }

    // open_workspace is a routing boundary as well as a filesystem operation.
    // Only the current host's approved workspace root may reach DevSpace.
    // Projects are addressed beneath that workspace after it is opened.
    // Every other tool keeps the existing Secret Firewall behavior unchanged.
    let effectivePayload = payload;
    if (payload?.method === 'tools/call' && payload?.params?.name === 'open_workspace') {
      const routed = routeOpenWorkspaceCall(payload, projectRegistry);
      if (!routed.allowed) {
        log('request_blocked', { reason: routed.reason });
        return {
          status: 200,
          contentType: 'json',
          body: JSON.stringify(deniedToolResult(payload.id, routed.reason)),
        };
      }
      effectivePayload = routed.payload;
      log('workspace_routed', { root: routed.workspaceRoot, host: projectRegistry?.currentHostId ?? null });
    }

    // Deny before DevSpace ever sees the resolved path: the secret is never read.
    const decision = authorizeRequest(effectivePayload);
    if (!decision.allowed) {
      log('request_blocked', { reason: decision.reason });
      return {
        status: 200,
        contentType: 'json',
        body: JSON.stringify(deniedToolResult(payload.id, decision.reason)),
      };
    }

    if (restoreSession && !await ensureLegacySession()) {
      return {
        status: 502,
        contentType: 'json',
        body: JSON.stringify(localErrorEnvelope(payload.id, 'upstream_session_unavailable')),
      };
    }

    const upstream = await callUpstream({
      method: httpMethod === 'POST' ? 'POST' : httpMethod,
      body: httpMethod === 'POST' ? JSON.stringify(effectivePayload) : null,
      clientSessionId,
      clientProtocolVersion,
      // An initialize request creates a fresh MCP session. Reusing the
      // previous session header makes a second ChatGPT validation attempt fail
      // with HTTP 400 instead of replacing the old session.
      useSession: effectivePayload.method !== 'initialize',
      allowRetry: true,
      accept,
    });

    if (upstream.contentType === 'json' && upstream.payload) {
      // A locally generated failure (auth rejected, unreachable, oversized).
      // Never 401: the caller has no way to satisfy a local challenge.
      return {
        status: upstream.status,
        contentType: 'json',
        body: JSON.stringify(localErrorEnvelope(payload.id, upstream.payload.error)),
      };
    }

    let filtered;
    try {
      filtered = firewallBody(
        upstream.raw ?? '', upstream.contentType, decision.requestedPath, effectivePayload.method,
      );
    } catch (error) {
      if (error instanceof FirewallError) {
        log('firewall_failed', { code: error.code });
      } else {
        log('firewall_failed', { code: 'UNKNOWN' });
      }
      return {
        status: 502,
        contentType: 'json',
        body: JSON.stringify(localErrorEnvelope(payload.id, 'policy_enforcement_failed')),
      };
    }

    if (filtered === null) {
      // Unclassified payload: never forward what we cannot inspect.
      log('upstream_payload_unclassified', { contentType: upstream.contentType });
      return {
        status: 502,
        contentType: 'json',
        body: JSON.stringify(localErrorEnvelope(payload.id, 'upstream_payload_unclassified')),
      };
    }

    return {
      status: upstream.status,
      contentType: upstream.contentType,
      body: filtered.body,
    };
  }

  return {
    handle,
    get sessionId() {
      return sessionId;
    },
    get authenticated() {
      return authenticated;
    },
  };
}

export { DevSpaceOAuthError };
