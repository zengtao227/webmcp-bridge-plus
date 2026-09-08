import { createServer } from 'node:http';

const ALLOWED_METHODS = new Set(['POST', 'GET', 'DELETE']);
const LOOPBACK_REMOTES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEFAULT_ACCEPT = 'application/json, text/event-stream';

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

function upstreamTarget(config, search) {
  return new URL(`${config.mcpPath}${search ?? ''}`, `${config.upstreamBaseUrl}/`).toString();
}

function buildUpstreamHeaders(req, token, hasBody) {
  const headers = {
    accept: req.headers.accept ?? DEFAULT_ACCEPT,
    authorization: `Bearer ${token}`,
  };
  if (hasBody) {
    headers['content-type'] = 'application/json';
  }
  // MCP Streamable HTTP keeps sessions alive through these headers.
  for (const name of ['mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.length > 0 && value.length <= 4096) {
      headers[name] = value;
    }
  }
  return headers;
}

async function pipeBounded(response, res, limit, log) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    log('upstream_response_too_large', { declared });
    return false;
  }
  if (!response.body) {
    res.end();
    return true;
  }

  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        log('upstream_response_truncated', { limit });
        return false;
      }
      res.write(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  res.end();
  return true;
}

export function createAdapterServer(config, {
  oauthClient,
  log = () => {},
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!oauthClient || typeof oauthClient.getAccessToken !== 'function') {
    throw new Error('createAdapterServer requires an oauth client.');
  }

  async function forward(req, res, body, allowRetry) {
    let token;
    try {
      token = await oauthClient.getAccessToken();
    } catch (error) {
      log('auth_failed', { code: error.code ?? 'UNKNOWN' });
      sendJson(res, 502, { error: 'upstream_auth_unavailable' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${config.listenHost}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

    let response;
    try {
      response = await fetchImpl(upstreamTarget(config, url.search), {
        method: req.method,
        headers: buildUpstreamHeaders(req, token, body !== null),
        body: body ?? undefined,
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      log('upstream_unreachable', { code: error?.name ?? 'UNKNOWN' });
      sendJson(res, 502, { error: 'upstream_unavailable' });
      return;
    }

    if (response.status === 401 && allowRetry) {
      clearTimeout(timeout);
      // The container may have restarted and dropped its token store.
      oauthClient.invalidate();
      log('upstream_unauthorized_retry', {});
      await forward(req, res, body, false);
      return;
    }

    const outHeaders = { 'cache-control': 'no-store' };
    const contentType = response.headers.get('content-type');
    if (contentType) {
      outHeaders['content-type'] = contentType;
    }
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) {
      outHeaders['mcp-session-id'] = sessionId;
    }
    res.writeHead(response.status, outHeaders);
    try {
      const ok = await pipeBounded(response, res, config.maxResponseBytes, log);
      if (!ok) {
        res.destroy();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const server = createServer((req, res) => {
    const remote = normalizeRemoteAddress(req.socket?.remoteAddress);
    if (!LOOPBACK_REMOTES.has(remote)) {
      // Bound to loopback already; this is defence in depth, not the primary control.
      log('non_loopback_remote_rejected', { remote });
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${config.listenHost}`);

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      sendJson(res, 200, { status: 'ok', authenticated: oauthClient.hasToken });
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
        let body = null;
        if (req.method === 'POST') {
          const contentType = (req.headers['content-type'] ?? '').toLowerCase();
          if (!contentType.includes('application/json')) {
            sendJson(res, 415, { error: 'unsupported_media_type' });
            return;
          }
          try {
            body = await readBoundedBody(req, config.maxRequestBytes);
          } catch {
            sendJson(res, 413, { error: 'request_too_large' });
            return;
          }
          try {
            JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { error: 'invalid_json' });
            return;
          }
        }
        await forward(req, res, body, true);
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
