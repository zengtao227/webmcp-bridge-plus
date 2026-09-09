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
projects:
  webmcp-bridge:
    host: host-a
    path: "/work/My code/webmcp-bridge"
    aliases:
      - "WebMCP Bridge"
  remote-project:
    host: host-b
    path: "/work/Other/remote-project"
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
  assert.equal(registry.resolve('webmcp-bridge').status, 'unique');
  assert.equal(registry.resolve('WebMCP Bridge').project.path, '/work/My code/webmcp-bridge');
  assert.equal(registry.resolve('/work/My code/webmcp-bridge').status, 'unique');
});

test('requires an explicit current host once the registry has multiple hosts', () => {
  assert.throws(
    () => parseProjectRegistry(FIXTURE),
    (error) => error?.code === 'CURRENT_HOST_REQUIRED',
  );
});

test('resolver is deterministic and fails closed for missing or wrong-backend projects', () => {
  const registry = parseProjectRegistry(FIXTURE, { currentHostId: 'host-a' });
  assert.equal(registry.resolve('webmcp-bridge').status, 'unique');
  assert.equal(registry.resolve('WebMCP Bridge').status, 'unique');
  assert.equal(registry.resolve('/work/My code/webmcp-bridge').status, 'unique');
  assert.equal(registry.resolve('/work/webmcp-bridge').status, 'missing');
  assert.equal(registry.resolve('definitely-not-a-real-project').status, 'missing');
  assert.equal(registry.resolve('/work/My code/definitely-not-a-real-project').status, 'missing');
  assert.equal(registry.resolve('remote-project').status, 'backend_unavailable');
  assert.equal(registry.resolve('/work/Other/remote-project').status, 'backend_unavailable');
});

test('open_workspace fails closed when no registry is available', () => {
  const denied = routeOpenWorkspaceCall(toolCall('webmcp-bridge'), null);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'project_registry_unavailable');
});

test('open_workspace routing rewrites only a registered reference to the exact path', () => {
  const registry = parseProjectRegistry(FIXTURE, { currentHostId: 'host-a' });
  const routed = routeOpenWorkspaceCall(toolCall('WebMCP Bridge'), registry);
  assert.equal(routed.allowed, true);
  assert.equal(routed.projectId, 'webmcp-bridge');
  assert.equal(routed.payload.params.arguments.path, '/work/My code/webmcp-bridge');
  assert.equal(routed.payload.params.arguments.mode, 'checkout');

  for (const reference of [
    '/work/webmcp-bridge',
    'definitely-not-a-real-project',
    '/work/My code/definitely-not-a-real-project',
    '../../something',
  ]) {
    const denied = routeOpenWorkspaceCall(toolCall(reference), registry);
    assert.equal(denied.allowed, false, reference);
  }
});

test('tools/list advertises registered references instead of inviting guessed filesystem paths', () => {
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
  assert.match(tool.description, /registered project/i);
  assert.deepEqual(tool.inputSchema.properties.path.enum, [
    'webmcp-bridge',
    'WebMCP Bridge',
    '/work/My code/webmcp-bridge',
  ]);
  assert.equal(tool.inputSchema.properties.mode.type, 'string');
});

test('adapter blocks unknown open_workspace before upstream and rewrites a registered alias in one call', async () => {
  const registry = parseProjectRegistry(FIXTURE, { currentHostId: 'host-a' });
  const { core, seen } = makeCore(registry, (request) => ({
    jsonrpc: '2.0',
    id: request.id,
    result: { ok: true },
  }));

  const denied = await core.handle(toolCall('definitely-not-a-real-project'));
  assert.equal(denied.status, 200);
  assert.equal(seen.length, 0);

  const allowed = await core.handle(toolCall('WebMCP Bridge'));
  assert.equal(allowed.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].params.arguments.path, '/work/My code/webmcp-bridge');
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
  assert.deepEqual(parsed.result.tools[0].inputSchema.properties.path.enum, [
    'webmcp-bridge',
    'WebMCP Bridge',
    '/work/My code/webmcp-bridge',
  ]);
});
