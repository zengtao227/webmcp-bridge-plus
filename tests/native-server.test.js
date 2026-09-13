import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeMcpServer } from '../native/src/server.js';
import { createWorkspaceRuntime } from '../native/src/workspace.js';

async function withServer(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-native-server-'));
  const runtime = createWorkspaceRuntime({ root, runtimeToken: 'server-test' });
  const server = createNativeMcpServer(runtime, { serverVersion: 'test' });
  try {
    await run({ root, runtime, server });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function call(id, name, args) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

test('initialize advertises the Native server without DevSpace metadata', async () => {
  await withServer(async ({ server }) => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, 'webmcp-native');
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.doesNotMatch(JSON.stringify(response), /DevSpace/i);
  });
});

test('server/discover remains a tiny in-container downgrade compatibility reply', async () => {
  await withServer(async ({ server }) => {
    const response = await server.handle({ jsonrpc: '2.0', id: 'discover', method: 'server/discover' });
    assert.equal(response.id, 'discover');
    assert.equal(response.error.code, -32601);
  });
});

test('tools/list exposes exactly the five frozen tools and /workspace only', async () => {
  await withServer(async ({ server }) => {
    const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(response.result.tools.map((tool) => tool.name), [
      'open_workspace',
      'read',
      'write',
      'edit',
      'bash',
    ]);
    const open = response.result.tools[0];
    assert.deepEqual(open.inputSchema.properties.path.enum, ['/workspace']);
    assert.doesNotMatch(JSON.stringify(response), /project discovery/i);
  });
});

test('open_workspace returns structured content and the same runtime id on repeated opens', async () => {
  await withServer(async ({ runtime, server }) => {
    const first = await server.handle(call(3, 'open_workspace', { path: '/workspace' }));
    const second = await server.handle(call(4, 'open_workspace', { path: '/workspace' }));
    assert.equal(first.result.structuredContent.workspaceId, runtime.workspaceId);
    assert.equal(second.result.structuredContent.workspaceId, runtime.workspaceId);
    assert.equal(first.result.structuredContent.root, '/workspace');
  });
});

test('tools/call executes Native file operations and surfaces bounded tool errors as tool results', async () => {
  await withServer(async ({ root, runtime, server }) => {
    await writeFile(path.join(root, 'a.txt'), 'alpha\nbeta\n', 'utf8');
    const read = await server.handle(call(5, 'read', {
      workspaceId: runtime.workspaceId,
      path: 'a.txt',
      offset: 2,
      limit: 1,
    }));
    assert.equal(read.result.structuredContent.result, 'beta');
    assert.equal(read.result.isError, undefined);

    const denied = await server.handle(call(6, 'read', {
      workspaceId: runtime.workspaceId,
      path: '.env',
    }));
    assert.equal(denied.result.isError, true);
    assert.equal(denied.result.structuredContent.error, 'blocked_sensitive_filename');
  });
});

test('unknown arguments and unknown methods fail closed', async () => {
  await withServer(async ({ runtime, server }) => {
    const badArg = await server.handle(call(7, 'bash', {
      workspaceId: runtime.workspaceId,
      command: 'true',
      surprise: true,
    }));
    assert.equal(badArg.result.isError, true);
    assert.equal(badArg.result.structuredContent.error, 'invalid_arguments');

    const unknown = await server.handle({ jsonrpc: '2.0', id: 8, method: 'made/up' });
    assert.equal(unknown.error.code, -32601);
  });
});

test('notifications receive no response and malformed envelopes are rejected', async () => {
  await withServer(async ({ server }) => {
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const invalid = await server.handle({ jsonrpc: '1.0', id: 9, method: 'tools/list' });
    assert.equal(invalid.error.code, -32600);
  });
});
