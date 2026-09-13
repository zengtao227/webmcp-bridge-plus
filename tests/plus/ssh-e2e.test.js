import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHostRegistry } from '../../plus/control/host-registry.js';
import { runProjectSshE2E } from '../../plus/ssh-e2e.js';

const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_B = 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function registry() {
  return parseHostRegistry(JSON.stringify({
    version: 1,
    hosts: [
      { hostId: HOST_A, label: 'MacBook Pro' },
      { hostId: HOST_B, label: 'Mac Mini' },
    ],
    projects: [
      { projectId: 'plus', hostId: HOST_A },
      { projectId: 'trading', hostId: HOST_B },
    ],
  }));
}

function successfulStdout() {
  return [
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'webmcp-native', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'open_workspace' }] } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, result: { structuredContent: { workspaceId: 'ws_test', root: '/workspace' } } }),
    '',
  ].join('\n');
}

test('exact project routing invokes one fixed OpenSSH command for the stable hostId and Native stdio entrypoint', () => {
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, signal: null, stdout: successfulStdout(), stderr: '' };
  };

  const result = runProjectSshE2E(registry(), 'plus', { spawnSyncImpl });

  assert.equal(result.projectId, 'plus');
  assert.equal(result.hostId, HOST_A);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/ssh');
  assert.ok(calls[0].args.includes('BatchMode=yes'));
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=yes'));
  assert.ok(calls[0].args.includes('PasswordAuthentication=no'));
  assert.ok(calls[0].args.includes('KbdInteractiveAuthentication=no'));
  assert.ok(calls[0].args.includes('ClearAllForwardings=yes'));
  assert.ok(calls[0].args.includes('PermitLocalCommand=no'));
  assert.equal(calls[0].args.at(-2), HOST_A);
  assert.match(calls[0].args.at(-1), /\.local\/share\/webmcp\/host-runtime\/current\/native\/host\/start\.js/);
  assert.equal(calls[0].args.join(' ').includes('plus'), false, 'project reference must not become SSH command data');

  const requests = calls[0].options.input.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(requests.length, 3);
  assert.equal(requests[0].method, 'initialize');
  assert.equal(requests[1].method, 'tools/list');
  assert.equal(requests[2].method, 'tools/call');
  assert.equal(requests[2].params.name, 'open_workspace');
  assert.deepEqual(requests[2].params.arguments, { path: '/workspace' });
});

test('wrong explicit host and unknown project fail before SSH is invoked', () => {
  let calls = 0;
  const spawnSyncImpl = () => {
    calls += 1;
    throw new Error('must not run');
  };

  assert.throws(
    () => runProjectSshE2E(registry(), 'plus', { requestedHostId: HOST_B, spawnSyncImpl }),
    (error) => error?.code === 'WRONG_HOST',
  );
  assert.throws(
    () => runProjectSshE2E(registry(), 'missing', { spawnSyncImpl }),
    (error) => error?.code === 'PROJECT_NOT_FOUND',
  );
  assert.equal(calls, 0);
});

test('SSH host-key, authentication, and unavailability failures are explicit and never fallback', () => {
  for (const stderr of [
    'Host key verification failed.',
    'Permission denied (publickey).',
    'ssh: connect to host example port 22: Operation timed out',
  ]) {
    const hosts = [];
    const spawnSyncImpl = (command, args) => {
      hosts.push(args.at(-2));
      return { status: 255, signal: null, stdout: '', stderr };
    };

    assert.throws(
      () => runProjectSshE2E(registry(), 'plus', { spawnSyncImpl }),
      (error) => error?.code === 'SSH_CONNECTION_FAILED',
    );
    assert.deepEqual(hosts, [HOST_A]);
  }
});
