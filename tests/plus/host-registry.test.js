import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadHostRegistry,
  parseHostRegistry,
} from '../../plus/control/host-registry.js';

const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_B = 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function fixture(overrides = {}) {
  return JSON.stringify({
    version: 1,
    hosts: [
      { hostId: HOST_A, label: 'MacBook Pro' },
      { hostId: HOST_B, label: 'Mac Mini' },
    ],
    projects: [
      { projectId: 'webmcp-bridge-plus', hostId: HOST_A },
      { projectId: 'trading-engine', hostId: HOST_B },
    ],
    ...overrides,
  });
}

test('data-only registry maps an exact project id to one stable host identity', () => {
  const registry = parseHostRegistry(fixture());

  const exact = registry.resolveProject('webmcp-bridge-plus');
  assert.equal(exact.status, 'unique');
  assert.equal(exact.project.hostId, HOST_A);
  assert.equal(exact.host.label, 'MacBook Pro');

  assert.equal(registry.resolveProject('missing-project').status, 'missing');
  assert.equal(registry.resolveProject('../plus').status, 'invalid');
});

test('registry schema rejects authority-bearing hidden fields', () => {
  for (const hosts of [
    [{ hostId: HOST_A, label: 'MacBook Pro', path: '/Users/alice' }],
    [{ hostId: HOST_A, label: 'MacBook Pro', token: '[REDACTED]' }],
    [{ hostId: HOST_A, label: 'MacBook Pro', online: true }],
  ]) {
    assert.throws(
      () => parseHostRegistry(JSON.stringify({ version: 1, hosts, projects: [] })),
      (error) => error?.code === 'INVALID_HOST_ENTRY',
    );
  }

  assert.throws(
    () => parseHostRegistry(JSON.stringify({
      version: 1,
      hosts: [{ hostId: HOST_A, label: 'MacBook Pro' }],
      projects: [{
        projectId: 'plus',
        hostId: HOST_A,
        path: '/Users/alice/Doc/My code/webmcp-bridge-plus',
      }],
    })),
    (error) => error?.code === 'INVALID_PROJECT_ENTRY',
  );
});

test('registry rejects unknown or duplicate stable identities and duplicate project ids', () => {
  assert.throws(
    () => parseHostRegistry(JSON.stringify({
      version: 1,
      hosts: [{ hostId: HOST_A, label: 'MacBook Pro' }],
      projects: [{ projectId: 'plus', hostId: HOST_B }],
    })),
    (error) => error?.code === 'INVALID_PROJECT_ENTRY',
  );

  assert.throws(
    () => parseHostRegistry(JSON.stringify({
      version: 1,
      hosts: [
        { hostId: HOST_A, label: 'MacBook Pro' },
        { hostId: HOST_A, label: 'Duplicate' },
      ],
      projects: [],
    })),
    (error) => error?.code === 'DUPLICATE_HOST_ID',
  );

  assert.throws(
    () => parseHostRegistry(JSON.stringify({
      version: 1,
      hosts: [{ hostId: HOST_A, label: 'MacBook Pro' }],
      projects: [
        { projectId: 'plus', hostId: HOST_A },
        { projectId: 'plus', hostId: HOST_A },
      ],
    })),
    (error) => error?.code === 'DUPLICATE_PROJECT_ID',
  );
});

test('registry loader rejects symlink substitution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-plus-registry-link-'));
  const target = path.join(root, 'target.json');
  const link = path.join(root, 'host-registry.json');
  await writeFile(target, fixture());
  await symlink(target, link);

  await assert.rejects(
    loadHostRegistry(link),
    (error) => error?.code === 'REGISTRY_UNAVAILABLE',
  );
});
