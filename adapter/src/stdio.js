// stdio transport: the strongest local boundary available.
//
// tunnel-client launches us as a child process and speaks MCP over stdin/stdout.
// There is no port and no socket path, so no other local process can reach the
// adapter at all. Loopback was never authorization; this removes the address.

const MAX_LINE_BYTES = 8 * 1024 * 1024;

function writeLine(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function createStdioAdapter(core, config, {
  log = () => {},
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  let buffer = Buffer.alloc(0);
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

    const result = await core.handle(payload, {
      // No HTTP headers here, so the session learned from DevSpace is used.
      clientSessionId: null,
      clientProtocolVersion: null,
      method: 'POST',
      accept: 'application/json',
    });

    if (isNotification) {
      // Notifications get no response; DevSpace answers 202 with an empty body.
      return;
    }

    if (result.status === 204 || result.body.trim().length === 0) {
      return;
    }

    let body;
    try {
      body = JSON.parse(result.body);
    } catch {
      log('stdio_upstream_unparsable', {});
      writeLine(stdout, {
        jsonrpc: '2.0',
        id: payload?.id ?? null,
        error: { code: -32603, message: 'Upstream returned an unparsable result' },
      });
      return;
    }
    writeLine(stdout, body);
  }

  function onData(chunk) {
    // A stream may hand us a decoded string or raw bytes; frame on bytes either
    // way so the framing cannot be confused by encoding.
    const piece = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    buffer = Buffer.concat([buffer, piece]);
    if (buffer.byteLength > MAX_LINE_BYTES) {
      log('stdio_line_too_large', {});
      buffer = Buffer.alloc(0);
      return;
    }

    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      pending = pending.then(() => (closed ? undefined : processLine(line)))
        .catch((error) => {
          log('stdio_request_failed', { code: error?.code ?? 'UNKNOWN' });
        });
      newline = buffer.indexOf(0x0a);
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
