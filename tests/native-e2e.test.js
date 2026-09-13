import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createHostRelay } from '../native/host/relay.js';

const FIXTURE = path.resolve('tests/helpers/native-fixture-server.js');
const FAKE_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz123456';

function createClient(root) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';
  let log = '';
  const waiters = [];

  stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      waiter?.(JSON.parse(line));
    }
  });
  stderr.on('data', (chunk) => { log += chunk.toString('utf8'); });

  const handle = createHostRelay({
    stdin,
    stdout,
    stderr,
    command: [process.execPath, FIXTURE, root],
  }).start();

  return {
    send(payload) {
      const response = new Promise((resolve) => waiters.push(resolve));
      stdin.write(`${JSON.stringify(payload)}\n`);
      return response;
    },
    logs: () => log,
    close: () => handle.close(),
  };
}

function call(id, name, args) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

test('full Native pipeline works through host relay with no DevSpace process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-native-e2e-'));
  await writeFile(path.join(root, 'seed.txt'), 'alpha\nbeta\n', 'utf8');
  const client = createClient(root);
  try {
    const initialized = await client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    assert.equal(initialized.result.serverInfo.name, 'webmcp-native');

    const listed = await client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      'open_workspace', 'read', 'write', 'edit', 'bash',
    ]);

    const opened = await client.send(call(3, 'open_workspace', { path: '/workspace' }));
    const workspaceId = opened.result.structuredContent.workspaceId;
    assert.match(workspaceId, /^ws_/);

    const read = await client.send(call(4, 'read', { workspaceId, path: 'seed.txt' }));
    assert.equal(read.result.structuredContent.result, 'alpha\nbeta\n');

    const write = await client.send(call(5, 'write', {
      workspaceId,
      path: 'created.txt',
      content: 'one\ntwo\n',
    }));
    assert.match(write.result.structuredContent.result, /Successfully wrote/);

    const edit = await client.send(call(6, 'edit', {
      workspaceId,
      path: 'created.txt',
      edits: [{ oldText: 'two', newText: 'three' }],
    }));
    assert.equal(edit.result.structuredContent.status, 'applied');
    assert.equal(await readFile(path.join(root, 'created.txt'), 'utf8'), 'one\nthree\n');

    const bash = await client.send(call(7, 'bash', {
      workspaceId,
      command: "printf 'native-ok'",
    }));
    assert.equal(bash.result.structuredContent.result, 'native-ok');
    assert.match(client.logs(), /webmcp_native_stdio_ready/);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('host Secret Firewall redacts Native tool output independently of the container server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-native-e2e-secret-'));
  await writeFile(path.join(root, 'ordinary.txt'), `token=${FAKE_TOKEN}\n`, 'utf8');
  const client = createClient(root);
  try {
    const opened = await client.send(call(1, 'open_workspace', { path: '/workspace' }));
    const workspaceId = opened.result.structuredContent.workspaceId;
    const read = await client.send(call(2, 'read', { workspaceId, path: 'ordinary.txt' }));
    const serialized = JSON.stringify(read);
    assert.doesNotMatch(serialized, new RegExp(FAKE_TOKEN));
    assert.match(serialized, /REDACTED/);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
