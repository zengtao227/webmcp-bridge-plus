// http and unix transports.
//
// These exist for local debugging and for callers that cannot use stdio. They
// are NOT the default, and the http transport refuses to start without a bearer
// token: loopback is not authorization, and every local process can reach a
// loopback port.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const ALLOWED_METHODS = new Set(['POST', 'GET', 'DELETE']);
const LOOPBACK_REMOTES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';

function normalizeRemoteAddress(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/^::ffff:/, '');
}

// Drain (do not buffer) anything past the limit so the 413 response still
// reaches the client. Draining stops at a hard cap; beyond that the socket is
// destroyed rather than read without bound.
function readBoundedBody(req, limit) {
  const hardCap = limit + 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > hardCap) {
        reject(new Error('REQUEST_TOO_LARGE'));
        req.destroy();
        return;
      }
      if (bytes > limit) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        reject(new Error('REQUEST_TOO_LARGE'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => reject(error));
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function createTokenVerifier(token) {
  const expected = Buffer.from(token, 'utf8');
  return (presented) => {
    if (typeof presented !== 'string') {
      return false;
    }
    const actual = Buffer.from(presented, 'utf8');
    if (actual.length !== expected.length) {
      return false;
    }
    try {
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  };
}

function presentedToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export function createAdapterServer(core, config, {
  log = () => {},
  verifyToken = null,
  requireToken = false,
} = {}) {
  if (requireToken && typeof verifyToken !== 'function') {
    throw new Error('The http transport requires a token verifier.');
  }

  const server = createServer((req, res) => {
    // A unix socket has no remote address: the 0600 mode on the socket file is
    // the whole boundary there, so there is nothing to check.
    if (config.transport !== 'unix') {
      const remote = normalizeRemoteAddress(req.socket?.remoteAddress);
      if (!LOOPBACK_REMOTES.has(remote)) {
        // Bound to loopback already; this is defence in depth, not the primary control.
        log('non_loopback_remote_rejected', { remote });
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
    }

    const url = new URL(req.url ?? '/', `http://${config.listenHost}`);

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      sendJson(res, 200, {
        status: 'ok',
        transport: config.transport,
        authenticated: core.authenticated === true,
      });
      return;
    }

    // Loopback does not identify a caller, so a token is mandatory here.
    if (requireToken && !verifyToken(presentedToken(req))) {
      log('unauthorized_request', { path: url.pathname });
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // Advertise nothing else: no protected-resource metadata means the tunnel
    // client stays in unauthenticated-target mode and never opens a browser flow.
    if (url.pathname !== config.mcpPath) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (!ALLOWED_METHODS.has(req.method)) {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    Promise.resolve()
      .then(async () => {
        let parsed = null;
        if (req.method === 'POST') {
          const contentType = (req.headers['content-type'] ?? '').toLowerCase();
          if (!contentType.includes('application/json')) {
            sendJson(res, 415, { error: 'unsupported_media_type' });
            return;
          }
          let raw;
          try {
            raw = await readBoundedBody(req, config.maxRequestBytes);
          } catch {
            sendJson(res, 413, { error: 'request_too_large' });
            return;
          }
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { error: 'invalid_json' });
            return;
          }
        }

        const result = await core.handle(parsed, {
          clientSessionId: req.headers[SESSION_HEADER] ?? null,
          clientProtocolVersion: req.headers[PROTOCOL_HEADER] ?? null,
          method: req.method,
        });

        const headers = { 'cache-control': 'no-store' };
        headers['content-type'] = result.contentType === 'sse'
          ? 'text/event-stream'
          : 'application/json; charset=utf-8';
        if (core.sessionId) {
          headers[SESSION_HEADER] = core.sessionId;
        }
        const body = Buffer.from(result.body ?? '', 'utf8');
        res.writeHead(result.status, { ...headers, 'content-length': body.byteLength });
        res.end(body);
      })
      .catch((error) => {
        log('request_failed', { code: error?.code ?? 'UNKNOWN' });
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'internal_error' });
        } else {
          res.destroy();
        }
      });
  });

  return server;
}

export { ALLOWED_METHODS, LOOPBACK_REMOTES };
