import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHostRegistry } from '../../plus/control/host-registry.js';
import { resolveProjectRoute } from '../../plus/control/route-decision.js';

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

test('route decision returns only projectId + stable hostId and no filesystem/network authority', () => {
  assert.deepEqual(resolveProjectRoute(registry(), 'plus'), {
    status: 'unique',
    projectId: 'plus',
    hostId: HOST_A,
  });
});

test('explicit host mismatch fails closed instead of falling back or rerouting', () => {
  assert.deepEqual(resolveProjectRoute(registry(), 'plus', { requestedHostId: HOST_B }), {
    status: 'wrong_host',
    projectId: 'plus',
    registeredHostId: HOST_A,
  });
});

test('missing, invalid, and malformed-host decisions remain non-executable', () => {
  assert.deepEqual(resolveProjectRoute(registry(), 'missing'), { status: 'missing' });
  assert.deepEqual(resolveProjectRoute(registry(), '../../plus'), { status: 'invalid' });
  assert.deepEqual(resolveProjectRoute(registry(), 'plus', { requestedHostId: 'macbook-pro' }), {
    status: 'invalid_host',
  });
});

test('route decision refuses to operate without a validated registry', () => {
  assert.throws(
    () => resolveProjectRoute(null, 'plus'),
    (error) => error?.code === 'REGISTRY_REQUIRED',
  );
});
