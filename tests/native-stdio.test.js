import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createNativeStdioServer } from '../native/src/stdio.js';

function createHarness(server, options = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  const waiters = [];

  stdout.on('data', (chunk) => {
    out += chunk.toString('utf8');
    for (;;) {
      const newline = out.indexOf('\n');
      if (newline === -1) {
        break;
      }
      const line = out.slice(0, newline);
      out = out.slice(newline + 1);
      const waiter = waiters.shift();
      waiter?.(JSON.parse(line));
    }
  });
  stderr.on('data', (chunk) => {
    err += chunk.toString('utf8');
  });

  const handle = createNativeStdioServer(server, {
    stdin,
    stdout,
    stderr,
    ...options,
  }).start();

  return {
    stdin,
    get stderrText() { return err; },
    send(payload) { stdin.write(`${JSON.stringify(payload)}\n`); },
    sendRaw(raw) { stdin.write(raw); },
    next() { return new Promise((resolve) => waiters.push(resolve)); },
    close: () => handle.close(),
  };
}

test('native stdio frames JSON-RPC without exposing a socket', async () => {
  const server = { handle: async (payload) => ({ jsonrpc: '2.0', id: payload.id, result: { ok: true } }) };
  const harness = createHarness(server);
  try {
    const reply = harness.next();
    harness.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.deepEqual(await reply, { jsonrpc: '2.0', id: 1, result: { ok: true } });
    assert.match(harness.stderrText, /webmcp_native_stdio_ready/);
  } finally {
    await harness.close();
  }
});

test('native stdio returns parse errors without passing malformed JSON to the server', async () => {
  let calls = 0;
  const server = { handle: async () => { calls += 1; return null; } };
  const harness = createHarness(server);
  try {
    const reply = harness.next();
    harness.sendRaw('{bad json\n');
    const response = await reply;
    assert.equal(response.error.code, -32700);
    assert.equal(calls, 0);
  } finally {
    await harness.close();
  }
});

test('native stdio discards oversized frames through newline and recovers', async () => {
  const server = { handle: async (payload) => ({ jsonrpc: '2.0', id: payload.id, result: {} }) };
  const harness = createHarness(server, { maxRequestBytes: 64 });
  try {
    const oversized = harness.next();
    harness.sendRaw(`${'x'.repeat(100)}\n`);
    assert.equal((await oversized).error.message, 'Request too large');

    const good = harness.next();
    harness.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.equal((await good).id, 2);
  } finally {
    await harness.close();
  }
});

test('native stdio sends no response for notifications when server returns null', async () => {
  const seen = [];
  const server = { handle: async (payload) => { seen.push(payload.method); return null; } };
  const harness = createHarness(server);
  try {
    harness.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, ['notifications/initialized']);
  } finally {
    await harness.close();
  }
});
