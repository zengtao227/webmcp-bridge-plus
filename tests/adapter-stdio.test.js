import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { loadAdapterConfig } from '../adapter/src/config.js';
import { DevSpaceOAuthClient } from '../adapter/src/oauth-client.js';
import { createAdapterCore } from '../adapter/src/core.js';
import { createStdioAdapter } from '../adapter/src/stdio.js';
import { startFakeDevSpace } from './helpers/fake-devspace.js';

const OWNER = 'fake-owner-token-0123456789abcdef';

function createPipes() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffer = '';
  const waiters = [];

  stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(JSON.parse(line));
      }
    }
  });

  return {
    stdin,
    stdout,
    send(payload) {
      stdin.write(`${JSON.stringify(payload)}\n`);
    },
    sendRaw(raw) {
      stdin.write(raw);
    },
    next() {
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function startStdioAdapter(fake, extraEnv = {}) {
  const config = loadAdapterConfig({
    DEVSPACE_UPSTREAM_URL: fake.url,
    DEVSPACE_OWNER_TOKEN_REF: 'env:FAKE_OWNER_TOKEN',
    ...extraEnv,
  });
  const events = [];
  const log = (event, fields = {}) => events.push({ event, ...fields });
  const oauthClient = new DevSpaceOAuthClient({
    upstreamMcpUrl: config.upstreamMcpUrl,
    resource: config.oauthResource,
    ownerToken: OWNER,
    clientName: config.clientName,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    log,
  });
  const core = createAdapterCore(config, { oauthClient, log });
  const pipes = createPipes();
  const handle = createStdioAdapter(core, config, {
    log,
    stdin: pipes.stdin,
    stdout: pipes.stdout,
  }).start();
  return { config, events, core, pipes, handle };
}

test('stdio is the default transport and exposes no address at all', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const { config, pipes, handle } = await startStdioAdapter(fake);
  try {
    assert.equal(config.transport, 'stdio');
    assert.equal(config.socketPath, null);

    const reply = pipes.next();
    pipes.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const response = await reply;

    assert.equal(response.id, 1);
    assert.equal(response.result.echoed, 'tools/list');
    assert.equal(fake.state.mcpCalls.length, 1);
    assert.equal(fake.state.mcpCalls[0].presented, 'at-1');
  } finally {
    await handle.close();
    await fake.close();
  }
});

test('converts a Streamable HTTP SSE response into stdio JSON-RPC', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER, mcpResponseType: 'sse' });
  const { pipes, handle } = await startStdioAdapter(fake);
  try {
    const reply = pipes.next();
    pipes.send({ jsonrpc: '2.0', id: 41, method: 'tools/list' });
    const response = await reply;
    assert.equal(response.id, 41);
    assert.equal(response.result.echoed, 'tools/list');
  } finally {
    await handle.close();
    await fake.close();
  }
});

test('redacts secrets in a tool result before the caller ever sees it', async () => {
  const secret = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';
  const fake = await startFakeDevSpace({
    ownerToken: OWNER,
    // An ordinary file that happens to contain a credential: the path is
    // allowed, so this exercises redaction rather than path denial.
    toolResult: {
      content: [{ type: 'text', text: `AWS_SECRET_ACCESS_KEY=${secret}\n` }],
    },
  });
  const { events, pipes, handle } = await startStdioAdapter(fake);
  try {
    const reply = pipes.next();
    pipes.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read', arguments: { path: '/work/app/config.yaml' } },
    });
    const response = await reply;

    const text = response.result.content[0].text;
    assert.ok(!text.includes(secret), 'raw secret must not reach the caller');
    assert.match(text, /\[REDACTED\]/);
    assert.ok(events.some((entry) => entry.event === 'firewall_applied'));
  } finally {
    await handle.close();
    await fake.close();
  }
});

test('blocks a forbidden path before DevSpace is ever asked to read it', async () => {
  const fake = await startFakeDevSpace({
    ownerToken: OWNER,
    toolResult: { content: [{ type: 'text', text: 'should never be produced' }] },
  });
  const { events, pipes, handle } = await startStdioAdapter(fake);
  try {
    const reply = pipes.next();
    pipes.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read', arguments: { path: '/Users/zengtao/.ssh/id_ed25519' } },
    });
    const response = await reply;

    assert.equal(response.error.code, -32001);
    assert.match(response.error.message, /Secret Firewall/);
    // The file was never opened, so its contents never existed in this process.
    assert.equal(fake.state.mcpCalls.length, 0);
    assert.ok(events.some((entry) => entry.event === 'request_blocked'));
  } finally {
    await handle.close();
    await fake.close();
  }
});

test('answers requests in the order they arrive', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const { pipes, handle } = await startStdioAdapter(fake);
  try {
    const ids = [];
    for (const id of [10, 11, 12]) {
      const reply = pipes.next();
      pipes.send({ jsonrpc: '2.0', id, method: 'tools/list' });
      ids.push((await reply).id);
    }
    assert.deepEqual(ids, [10, 11, 12]);
  } finally {
    await handle.close();
    await fake.close();
  }
});

test('notifications get no response, and malformed input gets a parse error', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const { events, pipes, handle } = await startStdioAdapter(fake);
  try {
    pipes.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A notification is followed by a real request; only that one is answered.
    const reply = pipes.next();
    pipes.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    const response = await reply;
    assert.equal(response.id, 5);

    pipes.sendRaw('{not json\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((entry) => entry.event === 'stdio_invalid_json'));
  } finally {
    await handle.close();
    await fake.close();
  }
});

test('drops an oversized frame through its newline instead of parsing a later fragment', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const { events, pipes, handle } = await startStdioAdapter(fake, {
    ADAPTER_MAX_REQUEST_BYTES: '128',
  });
  try {
    const smuggled = JSON.stringify({ jsonrpc: '2.0', id: 98, method: 'tools/list' });
    pipes.sendRaw(`${'x'.repeat(256)}${smuggled}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.state.mcpCalls.length, 0);
    assert.ok(events.some((entry) => entry.event === 'stdio_line_too_large'));

    const reply = pipes.next();
    pipes.send({ jsonrpc: '2.0', id: 99, method: 'tools/list' });
    assert.equal((await reply).id, 99);
  } finally {
    await handle.close();
    await fake.close();
  }
});

test('real stdio entrypoint keeps logs off stdout and accepts DevSpace SSE', async () => {
  const fake = await startFakeDevSpace({ ownerToken: OWNER });
  const child = spawn(process.execPath, ['adapter/bin/start.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEVSPACE_UPSTREAM_URL: fake.url,
      DEVSPACE_OWNER_TOKEN_REF: 'env:FAKE_OWNER_TOKEN',
      FAKE_OWNER_TOKEN: OWNER,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 91,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'entrypoint-test', version: '1' },
      },
    })}\n`);

    const deadline = Date.now() + 2_000;
    while (!stdout.includes('\n') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(stdout.includes('\n'), `expected a response, stderr=${stderr}`);
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const response = JSON.parse(lines[0]);
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 91);
    assert.match(stderr, /adapter_stdio_ready/);
    assert.ok(!stdout.includes('adapter_stdio_ready'));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await fake.close();
  }
});
