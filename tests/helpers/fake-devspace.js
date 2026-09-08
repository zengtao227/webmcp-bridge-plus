import { createServer } from 'node:http';

const HTML_FORM = '<!doctype html><html><body><form method="post"><input name="owner_token" /></form></body></html>';

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startFakeDevSpace({
  ownerToken = 'fake-owner-token-0123456789abcdef',
  accessTtlSeconds = 3600,
  resource = null,
  advertiseRegistration = true,
  advertisedIssuer = null,
  toolResult = null,
  mcpResponseType = 'json',
} = {}) {
  const state = {
    toolResult,
    requests: [],
    registeredClients: [],
    tokenCounter: 0,
    accessTokens: new Map(),
    refreshTokens: new Map(),
    rejectedTokens: new Set(),
    mcpCalls: [],
    failNextTokenRequest: false,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const form = raw.includes('=') && !raw.trimStart().startsWith('{')
      ? new URLSearchParams(raw)
      : null;
    state.requests.push({ method: req.method, path: url.pathname, body: raw });

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' && req.method === 'GET') {
      const issuer = advertisedIssuer ?? `${state.baseUrl}/`;
      json(res, 200, {
        resource: resource ?? `${state.baseUrl}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ['devspace'],
      });
      return;
    }

    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      json(res, 200, {
        issuer: advertisedIssuer ?? `${state.baseUrl}/`,
        authorization_endpoint: `${state.baseUrl}/authorize`,
        token_endpoint: `${state.baseUrl}/token`,
        ...(advertiseRegistration ? { registration_endpoint: `${state.baseUrl}/register` } : {}),
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        scopes_supported: ['devspace'],
      });
      return;
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      state.registeredClients.push(JSON.parse(raw));
      json(res, 201, { client_id: `client-${state.registeredClients.length}` });
      return;
    }

    if (url.pathname === '/authorize' && req.method === 'POST') {
      if (form?.get('owner_token') !== ownerToken) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML_FORM);
        return;
      }
      const redirect = new URL(form.get('redirect_uri'));
      redirect.searchParams.set('code', `code-${state.registeredClients.length}-${form.get('state')}`);
      redirect.searchParams.set('state', form.get('state'));
      state.lastAuthorization = {
        clientId: form.get('client_id'),
        codeChallenge: form.get('code_challenge'),
        redirectUri: form.get('redirect_uri'),
        resource: form.get('resource'),
      };
      res.writeHead(302, { location: redirect.toString() });
      res.end();
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      if (state.failNextTokenRequest) {
        state.failNextTokenRequest = false;
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      const grantType = form?.get('grant_type');
      if (grantType === 'refresh_token') {
        const presented = form.get('refresh_token');
        if (!state.refreshTokens.has(presented)) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        state.refreshTokens.delete(presented);
      } else if (grantType !== 'authorization_code') {
        json(res, 400, { error: 'unsupported_grant_type' });
        return;
      }

      state.tokenCounter += 1;
      const accessToken = `at-${state.tokenCounter}`;
      const refreshToken = `rt-${state.tokenCounter}`;
      state.accessTokens.set(accessToken, { scope: form?.get('scope') ?? 'devspace' });
      state.refreshTokens.set(refreshToken, { accessToken });
      json(res, 200, {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: accessTtlSeconds,
        refresh_token: refreshToken,
        scope: 'devspace',
      });
      return;
    }

    if (url.pathname === '/mcp') {
      const auth = req.headers.authorization ?? '';
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      state.mcpCalls.push({
        method: req.method,
        sessionId: req.headers['mcp-session-id'] ?? null,
        presented,
      });
      if (!presented || !state.accessTokens.has(presented) || state.rejectedTokens.has(presented)) {
        json(res, 401, { error: 'invalid_token' });
        return;
      }
      if (req.method === 'POST') {
        const payload = JSON.parse(raw);
        const responsePayload = payload?.method === 'tools/call' && state.toolResult
          ? {
            jsonrpc: '2.0',
            id: payload?.id ?? null,
            result: state.toolResult,
          }
          : {
            jsonrpc: '2.0',
            id: payload?.id ?? null,
            result: { echoed: payload?.method ?? null, viaAdapter: true },
          };
        if (mcpResponseType === 'sse') {
          const body = `event: message\ndata: ${JSON.stringify(responsePayload)}\n\n`;
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'content-length': Buffer.byteLength(body),
          });
          res.end(body);
          return;
        }
        json(res, 200, responsePayload);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', result: { stream: true } }));
      return;
    }

    json(res, 404, { error: 'not_found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    state,
    url: state.baseUrl,
    close: () => new Promise((resolve) => {
      // Keep-alive sockets would otherwise hold the event loop open.
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
