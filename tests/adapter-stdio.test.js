import test from 'node:test';
import assert from 'node:assert/strict';
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
