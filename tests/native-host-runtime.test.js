import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  defaultNativeHostRuntimeRoot,
  deployNativeHostBoundary,
  NATIVE_HOST_ENTRYPOINT,
  NATIVE_HOST_RUNTIME_PAYLOAD,
  verifyNativeHostBoundary,
} from '../native/deploy/deploy-host-boundary.js';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function createSourceRepository(parent) {
  const source = path.join(parent, 'source');
  await mkdir(source);
  for (const relativePath of NATIVE_HOST_RUNTIME_PAYLOAD) {
    const destination = path.join(source, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const content = relativePath === 'package.json'
      ? '{"type":"module"}\n'
      : `// fixture for ${relativePath}\n`;
    await writeFile(destination, content, 'utf8');
  }
  await git(source, ['init', '--quiet']);
  await git(source, ['add', ...NATIVE_HOST_RUNTIME_PAYLOAD]);
  await git(source, ['-c', 'user.name=Native Host Test', '-c', 'user.email=native-host@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  return source;
}

test('Native host boundary defaults to the WebMCP-owned host runtime location', () => {
  assert.equal(
    defaultNativeHostRuntimeRoot('/Users/example'),
    '/Users/example/.local/share/webmcp/host-runtime',
  );
});

test('Native host boundary source-gates the container controller and every host-side policy dependency', () => {
  for (const forbidden of [
    'adapter/src/core.js',
    'adapter/src/oauth-client.js',
    'adapter/src/project-registry.js',
    'config/devspace-projects.yaml',
  ]) {
    assert.equal(NATIVE_HOST_RUNTIME_PAYLOAD.includes(forbidden), false, `${forbidden} must not enter the Native host payload`);
  }
  for (const required of [
    'adapter/deploy/deploy-host-runtime.js',
    'native/deploy/build-image.js',
    'native/deploy/configure-workspace.js',
    'native/deploy/container-controller.js',
    'native/deploy/container-policy.js',
    'native/deploy/control-plane-paths.js',
    'native/deploy/deploy-host-boundary.js',
    'native/deploy/elevated-access.js',
    'native/deploy/image-pin.js',
    'native/deploy/installer.js',
    'native/deploy/runtime-payload.js',
    'native/deploy/workspace-config.js',
  ]) {
    assert.ok(NATIVE_HOST_RUNTIME_PAYLOAD.includes(required), `${required} must be in the immutable host payload`);
  }
});

test('immutable host payload is dependency-complete for the local owner-control CLI', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-native-owner-control-'));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    for (const relativePath of NATIVE_HOST_RUNTIME_PAYLOAD) {
      const destination = path.join(root, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(repo, relativePath), destination);
    }
    const cli = path.join(root, 'native', 'deploy', 'installer.js');
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, 'help'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, /elevate --root/);
    assert.equal(stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('normal host startup does not probe GUI identity when no elevation lease is present', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = await readFile(path.join(repo, 'native', 'host', 'start.js'), 'utf8');
  const leaseBranch = source.indexOf('if (leasePresent) {');
  const guiProbe = source.indexOf('await getLoginSessionId()', leaseBranch);
  assert.notEqual(leaseBranch, -1);
  assert.ok(guiProbe > leaseBranch, 'GUI identity must only be probed inside the lease-present branch');
  assert.equal(source.slice(0, leaseBranch).includes('await getLoginSessionId()'), false);
});

test('elevation lifetime starts only after local approval completes', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = await readFile(path.join(repo, 'native', 'deploy', 'installer.js'), 'utf8');
  const grant = source.slice(source.indexOf('export async function elevateWebMcp'));
  const approval = grant.indexOf('await requestLocalElevationApproval');
  const approvedAt = grant.indexOf('const approvedAt = Date.now();');
  const createLease = grant.indexOf('const lease = createElevatedLease');
  assert.notEqual(approval, -1);
  assert.ok(approvedAt > approval, 'lease clock must start after local approval');
  assert.ok(createLease > approvedAt, 'lease must be created from the post-approval timestamp');
});

test('Native host boundary reuses the immutable source-gated runtime mechanism with its own entrypoint', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'webmcp-native-host-runtime-'));
  try {
    const sourceRoot = await createSourceRepository(parent);
    const runtimeRoot = path.join(parent, 'host-runtime');
    const deployed = await deployNativeHostBoundary({ sourceRoot, runtimeRoot });
    const canonicalRuntimeRoot = await realpath(runtimeRoot);
    assert.match(deployed.artifactId, /^[0-9a-f]{40}-[0-9a-f]{64}$/);
    assert.equal(deployed.entrypoint, path.join(canonicalRuntimeRoot, 'current', NATIVE_HOST_ENTRYPOINT));

    const manifest = JSON.parse(await readFile(path.join(deployed.releaseDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.entrypoint, NATIVE_HOST_ENTRYPOINT);
    const entry = manifest.files.find((file) => file.path === NATIVE_HOST_ENTRYPOINT);
    assert.equal(entry.mode, '0700');

    const current = await verifyNativeHostBoundary(runtimeRoot);
    assert.equal(current.artifactId, deployed.artifactId);
    assert.equal(current.entrypoint, deployed.entrypoint);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('Native host boundary refuses to deploy inside its writable source repository', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'webmcp-native-host-runtime-'));
  try {
    const sourceRoot = await createSourceRepository(parent);
    await assert.rejects(
      deployNativeHostBoundary({ sourceRoot, runtimeRoot: path.join(sourceRoot, 'runtime') }),
      /outside every WebMCP-writable root/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
