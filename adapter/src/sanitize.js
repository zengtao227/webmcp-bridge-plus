// Never let DevSpace's local authentication surface reach ChatGPT.
//
// DevSpace answers unauthenticated MCP calls with 401 + WWW-Authenticate and a
// body naming its authorization server. That challenge is *our* credential
// exchange, performed here on loopback by the adapter. The caller on the other
// side of the tunnel has nothing to do with it: it cannot reach 127.0.0.1, and
// it must never learn that a local OAuth server exists.
//
// So an upstream auth challenge is replaced with a generic error, and every
// payload we do forward is scrubbed of auth metadata as defence in depth.

const REDACTED = '[redacted]';

// Keys dropped outright. Their values exist only to drive a browser OAuth flow
// that has to happen on this machine.
const DROPPED_KEYS = new Set([
  'authorization_endpoint',
  'token_endpoint',
  'registration_endpoint',
  'device_authorization_endpoint',
  'revocation_endpoint',
  'introspection_endpoint',
  'userinfo_endpoint',
  'end_session_endpoint',
  'jwks_uri',
  'resource_metadata',
  'authorization_servers',
  'issuer',
  'www-authenticate',
  'proxy-authenticate',
]);

// Keys whose values are credentials: keep the shape of the payload, drop the
// value, so nothing downstream learns it ever existed.
const SECRET_KEYS = new Set([
  'access_token',
  'refresh_token',
  'owner_token',
  'ownertoken',
  'id_token',
  'client_secret',
  'code',
  'code_verifier',
  'code_challenge',
  'state',
  'token',
  'authorization',
  'cookie',
  'set-cookie',
  'password',
]);

function isJsonRpcError(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.jsonrpc === '2.0'
    && value.error
    && typeof value.error === 'object'
    && !Array.isArray(value.error);
}

// Absolute URLs naming an OAuth endpoint. Deliberately requires a scheme so a
// plain project path such as /work/app/token is not mangled.
const OAUTH_ENDPOINT_URL = /https?:\/\/[^\s"'<>]*?\/(?:authorize|token|register|userinfo|introspect|revoke|device\/authorization)(?:[/?#][^\s"'<>]*)?/gi;

// Any RFC 8414 / RFC 9728 metadata reference, with or without a scheme.
const OAUTH_METADATA_REF = /(?:https?:\/\/[^\s"'<>]+)?\.well-known\/oauth-[a-z-]+/gi;

// A bearer credential in flight.
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

function scrubString(value) {
  return value
    .replace(OAUTH_ENDPOINT_URL, REDACTED)
    .replace(OAUTH_METADATA_REF, REDACTED)
    .replace(BEARER, '$1[redacted]');
}

function walk(value, { preserveErrorCode = false } = {}) {
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map(walk);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (key === 'error' && isJsonRpcError(value)) {
      out[key] = walk(child, { preserveErrorCode: true });
      continue;
    }
    // JSON-RPC error codes are protocol metadata, not OAuth authorization
    // codes. Preserve only the required integer field at error.code; a string
    // or a nested data.code stays redacted by the ordinary secret rule.
    if (lower === 'code' && preserveErrorCode && Number.isInteger(child)) {
      out[key] = child;
      continue;
    }
    if (DROPPED_KEYS.has(lower)) {
      continue;
    }
    if (SECRET_KEYS.has(lower)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = walk(child);
  }
  return out;
}

/**
 * Remove everything that would tell the caller how to authenticate against
 * DevSpace. Safe to call on any JSON value.
 */
export function scrubAuthMetadata(value) {
  return walk(value);
}

// Upstream auth challenges are answered with one of these. They carry no URL,
// no header value, and no token — by construction, not by convention.
const LOCAL_ERROR_MESSAGES = new Map([
  ['upstream_auth_unavailable', 'DevSpace authentication is unavailable. It is performed by the adapter on this machine, not by the caller.'],
  ['upstream_auth_rejected', 'DevSpace rejected the adapter. Its local authentication challenge was not forwarded.'],
  ['upstream_unavailable', 'DevSpace is unreachable on loopback.'],
  ['upstream_response_too_large', 'DevSpace returned a response larger than the adapter allows.'],
  ['upstream_response_unavailable', 'DevSpace returned a response the adapter could not read.'],
  ['upstream_payload_unclassified', 'DevSpace returned a payload the adapter could not classify.'],
  ['policy_enforcement_failed', 'The adapter could not enforce its content policy on this response.'],
]);

/**
 * A JSON-RPC error envelope for a locally generated failure. The id is echoed
 * so a client can match it, and the message names the condition without
 * describing our local credential exchange.
 */
export function localErrorEnvelope(id, code) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32002,
      message: LOCAL_ERROR_MESSAGES.get(code) ?? 'DevSpace is unavailable.',
    },
  };
}
