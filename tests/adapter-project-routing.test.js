import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAdapterConfig } from '../adapter/src/config.js';
import { createAdapterCore } from '../adapter/src/core.js';
import {
  loadProjectRegistry,
  parseProjectRegistry,
  routeOpenWorkspaceCall,
  rewriteToolsListPayload,
} from '../adapter/src/project-registry.js';

const FIXTURE = `
version: 1
hosts:
  host-a:
    app: devspace-host-a
    approvedRoot: "/work/My code"
  host-b:
    app: devspace-host-b
    approvedRoot: "/work/Other"
`;

function toolCall(reference) {
  return {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'open_workspace',
      arguments: { path: reference, mode: 'checkout' },
    },
  };
}

function makeCore(registry, responder) {
  const seen = [];
  const config = loadAdapterConfig({
    DEVSPACE_UPSTREAM_URL: 'http://127.0.0.1:7676',
    DEVSPACE_OWNER_TOKEN_REF: 'env:TEST_OWNER_TOKEN',
  });
  const oauthClient = {
    async getAccessToken() { return 'test-access-token'; },
    invalidate() {},
  };
  const fetchImpl = async (_url, init) => {
    const requestPayload = init.body ? JSON.parse(init.body) : null;
    seen.push(requestPayload);
    const payload = responder(requestPayload);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const log = () => {};
  log.addSecret = () => {};
  return {
    seen,
    core: createAdapterCore(config, { oauthClient, fetchImpl, log, projectRegistry: registry }),
  };
}

test('loads the canonical repository registry and selects the sole current host', async () => {
  const registry = await loadProjectRegistry(
    new URL('../config/devspace-projects.yaml', import.meta.url),
  );
  assert.equal(registry.currentHostId, 'macbook-pro');
  assert.equal(registry.approvedRoot, '/work/My code');
  assert.equal(registry.resolve('/work/My code').status, 'unique');
  assert.equal(registry.resolve('/work/My code/webmcp-bridge').status, 'missing');
});

test('requires an explicit current host once the registry has multiple hosts', () => {
  assert.throws(
    () => parseProjectRegistry(FIXTURE),
    (error) => error?.code === 'CURRENT_HOST_REQUIRED',
  );
});

test('resolver accepts only the current host approved root and fails closed for every other path', () => {
  const registry = parseProjectRegistry(FIXTURE, { currentHostId: 'host-a' });
  assert.equal(registry.resolve('/work/My code').status, 'unique');
  assert.equal(registry.resolve('/work/My code/webmcp-bridge').status, 'missing');
  assert.equal(registry.resolve('/work/My code/definitely-not-a-real-project').status, 'missing');
  assert.equal(registry.resolve('/work/Other').status, 'missing');
  assert.equal(registry.resolve('webmcp-bridge').status, 'missing');
  assert.equal(registry.resolve('../../something').status, 'missing');
});

test('open_workspace fails closed when no registry is available', () => {
  const denied = routeOpenWorkspaceCall(toolCall('webmcp-bridge'), null);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'project_registry_unavailable');
});

test('open_workspace routing accepts only the approved root', () => {
  const registry = parseProjectRegistry(FIXTURE, { currentHostId: 'host-a' });
  const routed = routeOpenWorkspaceCall(toolCall('/work/My code'), registry);
  assert.equal(routed.allowed, true);
  assert.equal(routed.workspaceRoot, '/work/My code');
  assert.equal(routed.payload.params.arguments.path, '/work/My code');
  assert.equal(routed.payload.params.arguments.mode, 'checkout');

  for (const reference of [
    '/work/My code/webmcp-bridge',
    ' /work/My code ',
    '/work/webmcp-bridge',
    'definitely-not-a-real-project',
    '/work/My code/definitely-not-a-real-project',
    '../../something',
  ]) {
    const denied = routeOpenWorkspaceCall(toolCall(reference), registry);
    assert.equal(denied.allowed, false, reference);
  }
});

test('tools/list advertises only the approved workspace root', () => {
  const registry = parseProjectRegistry(FIXTURE, { currentHostId: 'host-a' });
  const payload = rewriteToolsListPayload({
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [{
        name: 'open_workspace',
        description: 'Open an absolute path.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, mode: { type: 'string' } },
          required: ['path'],
        },
      }],
    },
  }, registry);
  const tool = payload.result.tools[0];
  assert.match(tool.description, /approved workspace root/i);
  assert.deepEqual(tool.inputSchema.properties.path.enum, ['/work/My code']);
  assert.equal(tool.inputSchema.properties.mode.type, 'string');
});

test('tools/list explicitly permits user-authorized Git commit and push operations', () => {
  const payload = rewriteToolsListPayload({
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [{
        name: 'bash',
        description: 'Use only for git inspection. Do not modify files.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Read-only command.' },
            workspaceId: { type: 'string' },
          },
          required: ['workspaceId', 'command'],
        },
      }],
    },
  }, null);

  const tool = payload.result.tools[0];
  assert.match(tool.description, /Git read and write operations are supported/);
  assert.match(tool.description, /git add/);
  assert.match(tool.description, /git commit/);
  assert.match(tool.description, /git push/);
  assert.doesNotMatch(tool.description, /Use only for git inspection/);
  assert.match(tool.inputSchema.properties.command.description, /git add/);
  assert.match(tool.inputSchema.properties.command.description, /git commit/);
  assert.match(tool.inputSchema.properties.command.description, /git push/);
  assert.deepEqual(tool.inputSchema.required, ['workspaceId', 'command']);
  assert.equal(tool.inputSchema.properties.workspaceId.type, 'string');
});

test('adapter blocks every non-root open_workspace request before upstream', async () => {
  const registry = parseProjectRegistry(FIXTURE, { currentHostId: 'host-a' });
  const { core, seen } = makeCore(registry, (request) => ({
    jsonrpc: '2.0',
    id: request.id,
    result: { ok: true },
  }));

  const denied = await core.handle(toolCall('/work/My code/definitely-not-a-real-project'));
  assert.equal(denied.status, 200);
  assert.equal(seen.length, 0);

  const allowed = await core.handle(toolCall('/work/My code'));
  assert.equal(allowed.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].params.arguments.path, '/work/My code');
});

test('adapter rewrites the live open_workspace schema returned by tools/list', async () => {
  const registry = parseProjectRegistry(FIXTURE, { currentHostId: 'host-a' });
  const { core } = makeCore(registry, (request) => ({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      tools: request.method === 'tools/list'
        ? [{ name: 'open_workspace', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }]
        : [],
    },
  }));

  const result = await core.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const parsed = JSON.parse(result.body);
  assert.deepEqual(parsed.result.tools[0].inputSchema.properties.path.enum, ['/work/My code']);
});
