import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildNativeContainerRun,
  NATIVE_ELEVATED_LEASE_LABEL,
  NATIVE_GIT_KEY_PATH,
  NATIVE_GIT_KNOWN_HOSTS_PATH,
} from '../native/deploy/container-policy.js';

const IMAGE = 'example/webmcp@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const TEST_IDENTITY = { hostUid: 1000, hostGid: 1000 };

function buildRun(options) {
  return buildNativeContainerRun({ ...options, ...TEST_IDENTITY });
}

function legacyV1PolicyDigest(run) {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    image: IMAGE,
    hostRoot: run.canonicalRoot,
    mode: run.config.mode,
    networkEnabled: run.config.networkEnabled,
    gitPublicationEnabled: run.config.gitPublicationEnabled,
    gitUserName: run.config.gitUserName ?? null,
    gitUserEmail: run.config.gitUserEmail ?? null,
    gitCredentialSource: run.gitCredentialSource,
    gitKnownHostsSource: run.gitKnownHostsSource,
    hostUid: TEST_IDENTITY.hostUid,
    hostGid: TEST_IDENTITY.hostGid,
    masks: run.maskPlan.map(({ type, destination }) => ({ type, destination })),
  })).digest('hex');
}

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-native-policy-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('native container policy requires an immutable image digest', async () => {
  await withRoot(async (root) => {
    await assert.rejects(buildRun({
      config: { version: 1, hostRoot: root, mode: 'project' },
      image: 'example/webmcp:latest',
      platform: 'linux',
    }), /pinned by sha256/);
  });
});

test('project/workspace mode keeps network and applies mandatory hardening/mount controls', async () => {
  await withRoot(async (root) => {
    const protectedDir = path.join(root, 'control-plane');
    await mkdir(protectedDir);
    const run = await buildRun({
      config: { version: 1, hostRoot: root, mode: 'workspace' },
      image: IMAGE,
      protectedPaths: [protectedDir],
      platform: 'linux',
    });
    assert.equal(run.command, 'docker');
    assert.deepEqual(run.args.slice(0, 4), ['run', '--detach', '--name', 'webmcp-native']);
    const capDropIndex = run.args.indexOf('--cap-drop');
    const securityOptIndex = run.args.indexOf('--security-opt');
    const userIndex = run.args.indexOf('--user');
    assert.notEqual(capDropIndex, -1);
    assert.equal(run.args[capDropIndex + 1], 'ALL');
    assert.notEqual(securityOptIndex, -1);
    assert.equal(run.args[securityOptIndex + 1], 'no-new-privileges');
    assert.notEqual(userIndex, -1);
    assert.equal(run.args[userIndex + 1], '1000:1000');
    assert.ok(run.args.some((arg) => arg.includes('bind-recursive=disabled')));
    assert.ok(run.args.some((arg) => arg.includes('type=tmpfs,dst=')));
    assert.equal(run.args.includes('--network'), false);
    assert.equal(run.args.at(-2), 'sleep');
    assert.equal(run.args.at(-1), 'infinity');
  });
});

test('normal-mode policy digest remains compatible with the V1.0 algorithm', async () => {
  await withRoot(async (root) => {
    const protectedDir = path.join(root, 'control-plane');
    await mkdir(protectedDir);
    const normal = await buildRun({
      config: { version: 1, hostRoot: root, mode: 'workspace' },
      image: IMAGE,
      protectedPaths: [protectedDir],
      platform: 'linux',
    });
    assert.equal(normal.policyDigest, legacyV1PolicyDigest(normal));

    const elevated = await buildRun({
      config: { version: 1, hostRoot: root, mode: 'advanced' },
      image: IMAGE,
      protectedPaths: [protectedDir],
      elevationLeaseId: 'a'.repeat(64),
      platform: 'linux',
    });
    assert.notEqual(elevated.policyDigest, legacyV1PolicyDigest(elevated));
  });
});

test('temporary elevation is lease-bound, network-off, and preserves control-plane carve-outs', async () => {
  await withRoot(async (root) => {
    const protectedDir = path.join(root, 'control-plane');
    await mkdir(protectedDir);
    const leaseId = 'a'.repeat(64);
    const run = await buildRun({
      config: { version: 1, hostRoot: root, mode: 'advanced' },
      image: IMAGE,
      protectedPaths: [protectedDir],
      elevationLeaseId: leaseId,
      platform: 'linux',
    });
    assert.ok(run.args.includes(`${NATIVE_ELEVATED_LEASE_LABEL}=${leaseId}`));
    const networkIndex = run.args.indexOf('--network');
    assert.equal(run.args[networkIndex + 1], 'none');
    // The mask plan records canonical sources, so compare against the resolved
    // path: on macOS the temp root reaches the mask plan as /private/var/...
    const canonicalProtectedDir = await realpath(protectedDir);
    assert.ok(run.maskPlan.some((item) => item.type === 'directory' && item.source === canonicalProtectedDir));
    assert.equal(run.args.some((arg) => arg.includes(NATIVE_GIT_KEY_PATH)), false);
    assert.equal(run.args.some((arg) => arg.includes(NATIVE_GIT_KNOWN_HOSTS_PATH)), false);
    await assert.rejects(buildRun({
      config: { version: 1, hostRoot: root, mode: 'advanced' },
      image: IMAGE,
      elevationLeaseId: 'not-a-lease',
      platform: 'linux',
    }), /valid lease identity/);
  });
});

test('advanced mode disables network and Git publication by default', async () => {
  await withRoot(async (root) => {
    const run = await buildRun({
      config: { version: 1, hostRoot: root, mode: 'advanced' },
      image: IMAGE,
      platform: 'linux',
    });
    const networkIndex = run.args.indexOf('--network');
    assert.notEqual(networkIndex, -1);
    assert.equal(run.args[networkIndex + 1], 'none');
    assert.equal(run.args.some((arg) => arg.includes(NATIVE_GIT_KEY_PATH)), false);
  });
});

test('Git publication credential is separately authorized and mounted read-only only when enabled', async () => {
  await withRoot(async (root) => {
    const keyDir = path.join(root, 'control');
    const key = path.join(keyDir, 'webmcp-test-deploy-key');
    const knownHosts = path.join(keyDir, 'known_hosts');
    await mkdir(keyDir);
    await writeFile(key, 'fake-key', 'utf8');
    await writeFile(knownHosts, 'github.com ssh-ed25519 AAAATEST\n', 'utf8');
    try {
      const run = await buildRun({
        config: {
          version: 1,
          hostRoot: root,
          mode: 'project',
          gitPublicationEnabled: true,
          gitUserName: 'WebMCP Test',
          gitUserEmail: 'webmcp-test@example.invalid',
        },
        image: IMAGE,
        gitCredentialPath: key,
        gitKnownHostsPath: knownHosts,
        platform: 'linux',
      });
      assert.ok(run.args.some((arg) => arg.includes(`dst=${NATIVE_GIT_KEY_PATH},readonly`)));
      assert.ok(run.args.some((arg) => arg.includes(`dst=${NATIVE_GIT_KNOWN_HOSTS_PATH},readonly`)));
      assert.ok(run.args.some((arg) => arg.includes(`UserKnownHostsFile=${NATIVE_GIT_KNOWN_HOSTS_PATH}`)));
      assert.ok(run.args.includes('GIT_AUTHOR_NAME=WebMCP Test'));
      assert.ok(run.args.includes('GIT_AUTHOR_EMAIL=webmcp-test@example.invalid'));
      // If the credential happens to live under the selected root, its original
      // workspace-visible path is carved out before the dedicated secret mount.
      const canonicalKey = await realpath(key);
      const canonicalKnownHosts = await realpath(knownHosts);
      assert.ok(run.maskPlan.some((item) => item.source === canonicalKey && item.type === 'file'));
      assert.ok(run.maskPlan.some((item) => item.source === canonicalKnownHosts && item.type === 'file'));

      await assert.rejects(buildRun({
        config: { version: 1, hostRoot: root, mode: 'project' },
        image: IMAGE,
        gitCredentialPath: key,
        gitKnownHostsPath: knownHosts,
        platform: 'linux',
      }), /must not be supplied/);
    } finally {
      await rm(key, { force: true });
      await rm(knownHosts, { force: true });
    }
  });
});
