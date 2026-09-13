#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultPlusControlPaths } from './control/host-identity.js';
import { loadHostRegistry } from './control/host-registry.js';
import { resolveProjectRoute } from './control/route-decision.js';

const SSH_BIN = '/usr/bin/ssh';
const HOST_ID_PATTERN = /^host_[0-9a-f]{32}$/;
const SSH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const REMOTE_NATIVE_COMMAND = '/usr/bin/env PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin "$HOME/.local/share/webmcp/host-runtime/current/native/host/start.js"';

export class SshE2EError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SshE2EError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new SshE2EError(message, code);
}

function routeOrFail(registry, projectReference, requestedHostId) {
  const route = resolveProjectRoute(registry, projectReference, { requestedHostId });
  if (route.status === 'unique') return route;
  if (route.status === 'wrong_host') fail('Requested host does not own the selected project.', 'WRONG_HOST');
  if (route.status === 'missing') fail('Project is not registered.', 'PROJECT_NOT_FOUND');
  if (route.status === 'invalid') fail('Project reference is invalid.', 'INVALID_PROJECT');
  if (route.status === 'invalid_host') fail('Requested hostId is invalid.', 'INVALID_HOST');
  fail('Project route is not executable.', 'ROUTE_UNAVAILABLE');
}

function mcpInput() {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'open_workspace', arguments: { path: '/workspace' } } },
  ].map((request) => JSON.stringify(request)).join('\n') + '\n';
}

function parseResponses(stdout) {
  let responses;
  try {
    responses = String(stdout ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    fail('Remote Native WebMCP returned malformed JSON.', 'REMOTE_MCP_FAILED');
  }
  const byId = new Map(responses.map((response) => [response?.id, response]));
  for (const id of [1, 2, 3]) {
    const response = byId.get(id);
    if (!response || response.jsonrpc !== '2.0' || response.error) {
      fail('Remote Native WebMCP did not complete the required E2E sequence.', 'REMOTE_MCP_FAILED');
    }
  }
  if (byId.get(1)?.result?.serverInfo?.name !== 'webmcp-native') {
    fail('Remote endpoint is not the expected Native WebMCP server.', 'REMOTE_MCP_FAILED');
  }
  const tools = byId.get(2)?.result?.tools;
  if (!Array.isArray(tools) || !tools.some((tool) => tool?.name === 'open_workspace')) {
    fail('Remote Native WebMCP does not expose open_workspace.', 'REMOTE_MCP_FAILED');
  }
  const opened = byId.get(3)?.result?.structuredContent;
  if (opened?.root !== '/workspace' || typeof opened?.workspaceId !== 'string' || !opened.workspaceId.startsWith('ws_')) {
    fail('Remote Native WebMCP did not open the fixed workspace root.', 'REMOTE_MCP_FAILED');
  }
  return Object.freeze({
    serverName: byId.get(1).result.serverInfo.name,
    toolNames: Object.freeze(tools.map((tool) => tool.name)),
    workspaceId: opened.workspaceId,
    root: opened.root,
  });
}

export function runProjectSshE2E(registry, projectReference, {
  requestedHostId = null,
  spawnSyncImpl = spawnSync,
} = {}) {
  const route = routeOrFail(registry, projectReference, requestedHostId);
  if (!HOST_ID_PATTERN.test(route.hostId)) {
    fail('Resolved route contains an invalid hostId.', 'INVALID_HOST');
  }

  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'PermitLocalCommand=no',
    '-o', 'CanonicalizeHostname=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ConnectionAttempts=1',
    route.hostId,
    REMOTE_NATIVE_COMMAND,
  ];

  const result = spawnSyncImpl(SSH_BIN, args, {
    input: mcpInput(),
    encoding: 'utf8',
    timeout: SSH_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result?.error || result?.status !== 0) {
    fail('SSH connection or fixed Native command failed for the selected host.', 'SSH_CONNECTION_FAILED');
  }

  return Object.freeze({
    projectId: route.projectId,
    hostId: route.hostId,
    ...parseResponses(result.stdout),
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1 || argv.length > 3) {
    fail('Usage: node plus/ssh-e2e.js <projectId> [--host <hostId>]', 'INVALID_ARGUMENTS');
  }
  const projectReference = argv[0];
  let requestedHostId = null;
  if (argv.length > 1) {
    if (argv.length !== 3 || argv[1] !== '--host') {
      fail('Usage: node plus/ssh-e2e.js <projectId> [--host <hostId>]', 'INVALID_ARGUMENTS');
    }
    requestedHostId = argv[2];
  }

  const registry = await loadHostRegistry(defaultPlusControlPaths().hostRegistry);
  const result = runProjectSshE2E(registry, projectReference, { requestedHostId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  main().catch((error) => {
    const code = error instanceof SshE2EError ? error.code : 'SSH_E2E_FAILED';
    process.stderr.write(`Plus SSH E2E failed [${code}]: ${error.message}\n`);
    process.exitCode = 1;
  });
}
