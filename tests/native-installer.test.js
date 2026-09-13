import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  assertLaunchDependenciesOutsideWorkspace,
  assertMacDependencies,
  assertSecretSourceOutsideWorkspace,
  DEFAULT_NATIVE_BASE_IMAGE,
  buildNativeLaunchAgent,
  classifyInstallArtifacts,
  installerPaths,
  launchAgentXml,
  parseInstallerArgs,
  publicInstallationStatus,
  reconfiguredWorkspaceConfig,
  uninstallManagedPaths,
  validateNativeLaunchAgent,
} from '../native/deploy/installer.js';
import { buildControlPlaneMaskPlan } from '../native/deploy/workspace-config.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER_PATH = path.join(REPO_ROOT, 'native', 'deploy', 'installer.js');
const BASE_IMAGE = 'node:22-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TUNNEL_ID = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function completeKinds() {
  return {
    workspaceConfig: 'file',
    imagePin: 'file',
    hostRuntimeRoot: 'directory',
    tunnelClient: 'file',
    tunnelStateHome: 'directory',
    profile: 'file',
    plist: 'file',
  };
}

test('installer classifies fresh, complete, partial, and unsafe host state without inventing persistent metadata', () => {
  const freshKinds = Object.fromEntries(Object.keys(completeKinds()).map((key) => [key, 'absent']));
  assert.equal(classifyInstallArtifacts(freshKinds).state, 'fresh');
  assert.equal(classifyInstallArtifacts(completeKinds(), { containerPresent: true, launchdState: 'loaded' }).state, 'candidate');
  assert.equal(classifyInstallArtifacts(completeKinds(), { containerPresent: false, launchdState: 'absent' }).state, 'candidate');
  assert.equal(classifyInstallArtifacts({ ...completeKinds(), profile: 'absent' }, { containerPresent: true }).state, 'partial');
  assert.equal(classifyInstallArtifacts({ ...completeKinds(), plist: 'symlink' }, { containerPresent: true }).state, 'unsafe');
  assert.equal(classifyInstallArtifacts(completeKinds(), { containerPresent: true, launchdState: 'unknown' }).state, 'unsafe');
});

test('status output exposes health facts without raw tunnel-client status payload', () => {
  const status = publicInstallationStatus({
    state: 'installed',
    details: {
      config: { hostRoot: '/Users/alice/Projects', mode: 'workspace' },
      container: { running: true },
      launchdState: 'loaded',
      tunnelReady: true,
      hostRuntime: { artifactId: `${'a'.repeat(40)}-${'b'.repeat(64)}` },
    },
  });
  assert.equal(status.tunnelReady, true);
  assert.equal(status.launchAgentLoaded, true);
  assert.equal(Object.hasOwn(status, 'tunnel'), false);
  assert.doesNotMatch(JSON.stringify(status), /secretish_internal_field|must-not-leak/);
});

test('installer ships one reviewed immutable Native base image default', () => {
  assert.match(DEFAULT_NATIVE_BASE_IMAGE, /^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/);
  assert.equal(DEFAULT_NATIVE_BASE_IMAGE, 'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5');
});

test('installer CLI accepts a workspace path with spaces and requires no per-project registry input', () => {
  const parsed = parseInstallerArgs([
    'install',
    '--root', '/Users/alice/My Projects',
    '--base-image', BASE_IMAGE,
    '--tunnel-id', TUNNEL_ID,
    '--runtime-key-file', '/tmp/native key',
    '--tunnel-client', '/tmp/tunnel client',
  ]);
  assert.equal(parsed.command, 'install');
  assert.equal(parsed.options.root, '/Users/alice/My Projects');
  assert.equal(parsed.options.baseImage, BASE_IMAGE);
  assert.equal(parsed.options.tunnelId, TUNNEL_ID);
  assert.equal(Object.hasOwn(parsed.options, 'project'), false);
  assert.equal(Object.hasOwn(parsed.options, 'registry'), false);
});

test('installer CLI executes main through its direct real path', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [INSTALLER_PATH, 'help'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.match(stdout, /Base WebMCP installer/);
  assert.equal(stderr, '');
});

test('installer CLI executes main through a current-style symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-installer-current-'));
  const linkedInstaller = path.join(root, 'current', 'native', 'deploy', 'installer.js');
  try {
    await mkdir(path.dirname(linkedInstaller), { recursive: true });
    await symlink(INSTALLER_PATH, linkedInstaller);
    const { stdout, stderr } = await execFileAsync(process.execPath, [linkedInstaller, 'help'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, /Base WebMCP installer/);
    assert.equal(stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('importing installer module does not execute main', async () => {
  const installerUrl = pathToFileURL(INSTALLER_PATH).href;
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(installerUrl)}); process.stdout.write('imported\\n');`,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stdout, 'imported\n');
  assert.equal(stderr, '');
});

test('Native LaunchAgent uses only the managed tunnel-client, isolated tunnel HOME, and fixed Native profile', () => {
  const paths = installerPaths('/Users/alice');
  const pathEnv = '/opt/homebrew/bin:/usr/bin:/bin';
  const agent = buildNativeLaunchAgent(paths, { pathEnv });
  assert.deepEqual(agent.ProgramArguments, [
    '/Users/alice/.local/share/webmcp/bin/tunnel-client',
    'run',
    '--profile-dir',
    '/Users/alice/.config/tunnel-client',
    '--profile',
    'native',
  ]);
  assert.equal(agent.EnvironmentVariables.HOME, '/Users/alice/.local/share/webmcp/native-tunnel-home');
  assert.equal(agent.EnvironmentVariables.PATH, pathEnv);
  const xml = launchAgentXml(agent);
  assert.match(xml, /com\.webmcp\.native-tunnel/);
  assert.doesNotMatch(xml, /webmcp-bridge\/native\/deploy\/installer\.js/);
  assert.doesNotMatch(xml, /DevSpace|dsup\.sh/);
});

test('LaunchAgent validation accepts the established Native cutover HOME/log layout', async () => {
  const bin = await realpath(await mkdtemp(path.join(os.tmpdir(), 'webmcp-launchagent-bin-')));
  try {
    for (const name of ['node', 'docker']) {
      const file = path.join(bin, name);
      await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(file, 0o700);
    }
    const paths = installerPaths('/Users/alice');
    const agent = buildNativeLaunchAgent(paths, { pathEnv: bin });
    const result = await validateNativeLaunchAgent({
      ...agent,
      EnvironmentVariables: { PATH: bin },
      StandardOutPath: '/Users/alice/Library/Logs/webmcp-native-tunnel.log',
      StandardErrorPath: '/Users/alice/Library/Logs/webmcp-native-tunnel.err',
    }, paths);
    assert.equal(result.tunnelHome, '/Users/alice');
    assert.equal(result.nodeBin, path.join(bin, 'node'));
    assert.equal(result.dockerBin, path.join(bin, 'docker'));
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});

test('LaunchAgent validation rejects an unknown tunnel HOME even when other fields match', async () => {
  const paths = installerPaths('/Users/alice');
  const agent = buildNativeLaunchAgent(paths, { pathEnv: '/definitely/missing' });
  await assert.rejects(validateNativeLaunchAgent({
    ...agent,
    EnvironmentVariables: { ...agent.EnvironmentVariables, HOME: '/tmp/untrusted-tunnel-home' },
  }, paths), /drifted/);
});

test('LaunchAgent validation fails closed on command drift', async () => {
  const paths = installerPaths('/Users/alice');
  const agent = buildNativeLaunchAgent(paths, { pathEnv: '/definitely/missing' });
  await assert.rejects(validateNativeLaunchAgent({
    ...agent,
    ProgramArguments: ['/tmp/other-client', ...agent.ProgramArguments.slice(1)],
  }, paths), /drifted/);
});

test('reconfigure changes only the selected root and preserves established mode/capabilities', () => {
  const current = {
    version: 1,
    hostRoot: '/Users/alice/Projects',
    mode: 'workspace',
    networkEnabled: true,
    gitPublicationEnabled: false,
  };
  assert.deepEqual(reconfiguredWorkspaceConfig(current, '/Users/alice/Code'), {
    ...current,
    hostRoot: '/Users/alice/Code',
  });
});

test('uninstall scope excludes the remote tunnel credential and does not claim Docker image ownership', () => {
  const paths = installerPaths('/Users/alice');
  const managed = uninstallManagedPaths(paths);
  assert.ok(managed.includes(paths.plist));
  assert.ok(managed.includes(paths.profile));
  assert.ok(managed.includes(paths.hostRuntimeRoot));
  assert.ok(managed.includes(paths.tunnelClient));
  assert.equal(managed.includes(paths.runtimeKey), false);
});

test('dependency preflight fails before partial installation when an actual required dependency is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-installer-deps-'));
  try {
    for (const name of ['git', 'plutil', 'launchctl', 'tunnel-client']) {
      const file = path.join(root, name);
      await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(file, 0o700);
    }
    await assert.rejects(assertMacDependencies({
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.18.0',
      uid: 501,
      pathValue: root,
      standardPath: '',
      execFileImpl: async () => ({ stdout: '', stderr: '' }),
    }), (error) => error?.code === 'MISSING_DEPENDENCY' && /Docker/.test(error.message));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('LaunchAgent host executables cannot resolve from inside the model-writable workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-installer-workspace-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'webmcp-installer-bin-'));
  try {
    const insideNode = path.join(root, 'bin', 'node');
    const outsideDocker = path.join(outside, 'docker');
    await mkdir(path.dirname(insideNode), { recursive: true });
    for (const file of [insideNode, outsideDocker]) {
      await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(file, 0o700);
    }
    await assert.rejects(assertLaunchDependenciesOutsideWorkspace(root, {
      node: insideNode,
      docker: outsideDocker,
    }), (error) => error?.code === 'UNSAFE_HOST_EXECUTABLE_LOCATION');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('runtime key source cannot remain inside the model-writable workspace', async () => {
  // realpath() here matches assertSecretSourceOutsideWorkspace's own canonicalization,
  // since macOS resolves os.tmpdir() through a /private symlink.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'webmcp-installer-secret-root-')));
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'webmcp-installer-secret-outside-')));
  try {
    const insideKey = path.join(root, 'runtime.key');
    const outsideKey = path.join(outside, 'runtime.key');
    await writeFile(insideKey, 'fake-secret', { mode: 0o600 });
    await writeFile(outsideKey, 'fake-secret', { mode: 0o600 });
    await assert.rejects(assertSecretSourceOutsideWorkspace(insideKey, root), (error) => error?.code === 'UNSAFE_RUNTIME_KEY_SOURCE');
    assert.equal(await assertSecretSourceOutsideWorkspace(outsideKey, root), outsideKey);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('dependency preflight accepts the supported macOS shape without installing anything', async () => {
  // realpath() here matches resolveExecutable's own canonicalization, since macOS
  // resolves os.tmpdir() through a /private symlink.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'webmcp-installer-deps-')));
  try {
    for (const name of ['git', 'docker', 'plutil', 'launchctl', 'tunnel-client']) {
      const file = path.join(root, name);
      await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(file, 0o700);
    }
    const result = await assertMacDependencies({
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.18.0',
      uid: 501,
      pathValue: root,
      standardPath: '',
      execFileImpl: async () => ({ stdout: '', stderr: '' }),
    });
    assert.equal(result.dockerBin, path.join(root, 'docker'));
    assert.equal(result.tunnelClientSource, path.join(root, 'tunnel-client'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('control-plane identity validation rejects selecting the control-plane root through a symlink alias', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-installer-control-'));
  const control = path.join(root, 'control');
  const alias = path.join(root, 'control-alias');
  try {
    await mkdir(control);
    await symlink(control, alias, 'dir');
    await assert.rejects(buildControlPlaneMaskPlan({
      hostRoot: alias,
      protectedPaths: [control],
    }), /must not be the WebMCP control-plane root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
