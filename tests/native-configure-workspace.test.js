import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configureWorkspace,
  parseConfigureArgs,
} from '../native/deploy/configure-workspace.js';

const IMAGE = 'example/webmcp@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

test('configure CLI requires explicit high-trust acknowledgement for Advanced network/Git capability', () => {
  assert.throws(() => parseConfigureArgs([
    '--root', '/tmp/work',
    '--mode', 'advanced',
    '--probe-image', IMAGE,
    '--network', 'on',
  ]), /ack-high-trust/);

  const parsed = parseConfigureArgs([
    '--root', '/tmp/work',
    '--mode', 'advanced',
    '--probe-image', IMAGE,
    '--network', 'on',
    '--git-publication', 'on',
    '--git-user-name', 'WebMCP Test',
    '--git-user-email', 'webmcp-test@example.invalid',
    '--ack-high-trust',
  ]);
  assert.equal(parsed.networkEnabled, true);
  assert.equal(parsed.gitPublicationEnabled, true);
  assert.equal(parsed.gitUserName, 'WebMCP Test');
  assert.equal(parsed.gitUserEmail, 'webmcp-test@example.invalid');
  assert.equal(parsed.ackHighTrust, true);
});

test('configureWorkspace persists only after the mount identity probe succeeds', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-configure-root-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'webmcp-configure-state-'));
  const configPath = path.join(configDir, 'workspace.json');
  let verified = false;
  try {
    const saved = await configureWorkspace({
      root,
      mode: 'workspace',
      probeImage: IMAGE,
      configPath,
      protectedPaths: [],
      platform: 'linux',
      verifyMount: async ({ hostRoot, image }) => {
        assert.equal(hostRoot, root);
        assert.equal(image, IMAGE);
        verified = true;
        return { canonicalRoot: root, maskPlan: [] };
      },
    });
    assert.equal(verified, true);
    assert.equal(saved.hostRoot, root);
    assert.match(await readFile(configPath, 'utf8'), /"hostRoot"/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('configureWorkspace leaves no persisted config when verification fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-configure-root-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'webmcp-configure-state-'));
  const configPath = path.join(configDir, 'workspace.json');
  try {
    await assert.rejects(configureWorkspace({
      root,
      mode: 'project',
      probeImage: IMAGE,
      configPath,
      protectedPaths: [],
      platform: 'linux',
      verifyMount: async () => {
        throw new Error('identity mismatch');
      },
    }), /identity mismatch/);
    await assert.rejects(readFile(configPath, 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
