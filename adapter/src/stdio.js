// stdio transport: the strongest local boundary available.
//
// tunnel-client launches us as a child process and speaks MCP over stdin/stdout.
// There is no port and no socket path, so no other local process can reach the
// adapter at all. Loopback was never authorization; this removes the address.

function writeLine(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function parseSseMessages(raw) {
  const messages = [];
  let data = [];
  const flush = () => {
    if (data.length > 0) {
      messages.push(JSON.parse(data.join('\n')));
      data = [];
    }
  };
  for (const sourceLine of raw.split('\n')) {
    const line = sourceLine.replace(/\r$/, '');
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  flush();
  return messages;
}

export function createStdioAdapter(core, config, {
  log = () => {},
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  let buffer = Buffer.alloc(0);
  let discardingOversizedLine = false;
  let closed = false;
  // Serializes handling so responses stay ordered and a slow request cannot
  // interleave replies.
  let pending = Promise.resolve();

  async function processLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      log('stdio_invalid_json', {});
      writeLine(stdout, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const isNotification = payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && !('id' in payload);

    // DevSpace currently implements the initialize-based MCP revisions. The
    // 2026-07-28 stdio compatibility probe requires a correlated JSON-RPC
    // error so the caller can downgrade on the same process. Forwarding the
    // probe upstream before initialize produces DevSpace's id:null session
    // error, which tunnel-client cannot match to the outstanding request.
    if (!isNotification && payload?.method === 'server/discover') {
      log('stdio_legacy_discovery_fallback', {});
      writeLine(stdout, {
        jsonrpc: '2.0',
        id: payload.id ?? null,
        error: { code: -32601, message: 'Method not found' },
      });
      return;
    }

    const result = await core.handle(payload, {
      // No HTTP headers here, so the session learned from DevSpace is used.
      clientSessionId: null,
      clientProtocolVersion: null,
      method: 'POST',
      // tunnel-client keeps remote connector state across local process
      // restarts, so tools/call may arrive before a fresh initialize.
      restoreSession: !isNotification && payload?.method !== 'initialize',
      // Streamable HTTP requires clients to accept both representations.
      // DevSpace rejects an application/json-only request with HTTP 406.
      accept: 'application/json, text/event-stream',
    });

    if (isNotification) {
      // Notifications get no response; DevSpace answers 202 with an empty body.
      return;
    }

    if (result.status === 204 || result.body.trim().length === 0) {
      return;
    }

    let messages;
    try {
      messages = result.contentType === 'sse'
        ? parseSseMessages(result.body)
        : [JSON.parse(result.body)];
      if (messages.length === 0) {
        throw new Error('No JSON-RPC message in upstream response.');
      }
    } catch {
      log('stdio_upstream_unparsable', {});
      writeLine(stdout, {
        jsonrpc: '2.0',
        id: payload?.id ?? null,
        error: { code: -32603, message: 'Upstream returned an unparsable result' },
      });
      return;
    }
    for (const message of messages) {
      writeLine(stdout, message);
    }
  }

  function onData(chunk) {
    // A stream may hand us a decoded string or raw bytes; frame on bytes either
    // way so the framing cannot be confused by encoding.
    let piece = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;

    // Once a line is over the configured request limit, discard through its
    // newline. Never reinterpret a later chunk of that same oversized frame as
    // a fresh JSON-RPC request.
    if (discardingOversizedLine) {
      const newline = piece.indexOf(0x0a);
      if (newline === -1) {
        return;
      }
      discardingOversizedLine = false;
      piece = piece.subarray(newline + 1);
    }

    buffer = Buffer.concat([buffer, piece]);

    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const lineBytes = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (lineBytes.byteLength > config.maxRequestBytes) {
        log('stdio_line_too_large', {});
      } else {
        const line = lineBytes.toString('utf8');
        pending = pending.then(() => (closed ? undefined : processLine(line)))
          .catch((error) => {
            log('stdio_request_failed', { code: error?.code ?? 'UNKNOWN' });
          });
      }
      newline = buffer.indexOf(0x0a);
    }

    if (buffer.byteLength > config.maxRequestBytes) {
      log('stdio_line_too_large', {});
      buffer = Buffer.alloc(0);
      discardingOversizedLine = true;
    }
  }

  return {
    start() {
      stdin.on('data', onData);
      stdin.on('end', () => {
        closed = true;
      });
      log('adapter_stdio_ready', { upstream: config.upstreamBaseUrl });
      return {
        close: async () => {
          closed = true;
          stdin.pause();
          await pending;
        },
      };
    },
  };
}

export { parseSseMessages };
