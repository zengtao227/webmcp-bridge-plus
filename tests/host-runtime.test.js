import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  deployHostRuntime,
  HOST_RUNTIME_PAYLOAD,
  HostRuntimeError,
  inspectSource,
  verifyCurrent,
  verifyRelease,
} from '../adapter/deploy/deploy-host-runtime.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINIMAL_PAYLOAD = Object.freeze([
  'package.json',
  'adapter/bin/start.js',
]);

async function git(cwd, args) {
  const { stdout = '' } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

async function createCleanRepository(root) {
  const sourceRoot = path.join(root, 'repo-under-test');
  const currentRuntimeChanges = [
    'adapter/deploy/deploy-host-runtime.js',
    'adapter/deploy/install-launchd.sh',
    'adapter/src/core.js',
    'adapter/src/project-registry.js',
  ];
  await execFileAsync('git', ['clone', '--quiet', '--no-hardlinks', REPO_ROOT, sourceRoot], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

  for (const relativePath of currentRuntimeChanges) {
    await copyFile(path.join(REPO_ROOT, relativePath), path.join(sourceRoot, relativePath));
  }

  // The clone may already contain every runtime change (as it does in CI).
  // Always create a distinct, valid candidate commit so upgrade fixtures have
  // both HEAD and HEAD^ without depending on a dirty caller worktree.
  await appendFile(
    path.join(sourceRoot, 'adapter', 'src', 'project-registry.js'),
    '\n// Test-only host runtime candidate revision.\n',
  );

  await git(sourceRoot, ['add', ...currentRuntimeChanges]);
  await git(sourceRoot, [
    '-c', 'user.name=Host Runtime Test',
    '-c', 'user.email=host-runtime@example.invalid',
    'commit', '-qm', 'test current runtime changes',
  ]);
  return sourceRoot;
}

async function withTempDir(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-host-runtime-test-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createFixture(root, { extraFiles = {} } = {}) {
  const projectRoot = path.join(root, 'project');
  const sourceRoot = path.join(projectRoot, 'repo');
  const runtimeRoot = path.join(root, 'host-runtime');
  await mkdir(path.join(sourceRoot, 'adapter', 'bin'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'package.json'), '{"type":"module"}\n');
  await writeFile(
    path.join(sourceRoot, 'adapter', 'bin', 'start.js'),
    '#!/usr/bin/env node\nprocess.stdin.resume();\n',
  );
  await chmod(path.join(sourceRoot, 'adapter', 'bin', 'start.js'), 0o755);
  for (const [relativePath, contents] of Object.entries(extraFiles)) {
    const target = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await git(sourceRoot, ['init', '-q']);
  await git(sourceRoot, ['add', '.']);
  await git(sourceRoot, [
    '-c', 'user.name=Host Runtime Test',
    '-c', 'user.email=host-runtime@example.invalid',
    'commit', '-qm', 'fixture',
  ]);
  return {
    projectRoot,
    sourceRoot,
    runtimeRoot,
    defaultWritableRoot: projectRoot,
  };
}

async function walk(root, current = '') {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const relativePath = current ? path.join(current, entry.name) : entry.name;
    const target = path.join(root, relativePath);
    const stat = await lstat(target);
    output.push({ relativePath, stat });
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      output.push(...await walk(root, relativePath));
    }
  }
  return output;
}

function assertHostRuntimeCode(code) {
  return (error) => {
    assert.ok(error instanceof HostRuntimeError);
    assert.equal(error.code, code);
    return true;
  };
}

async function waitForAlive(child, stderr) {
  const outcome = await Promise.race([
    once(child, 'exit').then(([code, signal]) => ({ type: 'exit', code, signal })),
    delay(250).then(() => ({ type: 'alive' })),
  ]);
  assert.equal(
    outcome.type,
    'alive',
    `snapshot adapter exited early: ${JSON.stringify(outcome)} stderr=${stderr.join('')}`,
  );
}

async function writeExecutable(target, contents) {
  await writeFile(target, contents);
  await chmod(target, 0o755);
}

async function prepareInstallerScenario(root, overrides = {}) {
  const sourceRepo = await createCleanRepository(root);
  const candidateCommit = (await git(sourceRepo, ['rev-parse', 'HEAD'])).trim();
  const previousCommit = (await git(sourceRepo, ['rev-parse', 'HEAD^'])).trim();
  const home = path.join(root, 'home');
  const defaultWritableRoot = path.join(home, 'Doc', 'My code');
  const runtimeRoot = path.join(home, 'Doc', 'devspace-container', 'runtime', 'webmcp-adapter');
  const profileDir = path.join(home, '.config', 'tunnel-client');
  const runtimeDir = path.join(home, 'Library', 'Application Support', 'tunnel-client');
  const secretDir = path.join(home, '.config', 'webmcp-test-secrets');
  const keyFile = path.join(secretDir, 'runtime-key');
  const healthFile = path.join(runtimeDir, 'health', 'devspace.url');
  const plistDir = path.join(home, 'Library', 'LaunchAgents');
  const plist = path.join(plistDir, 'com.webmcp.devspace-tunnel.plist');
  const legacyPlist = path.join(plistDir, 'com.webmcp.devspace-adapter.plist');
  const liveProfile = path.join(profileDir, 'devspace.yaml');
  const fakeBin = path.join(root, 'fake-bin');
  const tmpDir = path.join(root, 'tmp');
  const fakeLog = path.join(root, 'fake.log');
  const launchdState = path.join(root, 'launchd-state');
  const legacyLaunchdState = path.join(root, 'legacy-launchd-state');
  const legacyBootoutCount = path.join(root, 'legacy-bootout-count');
  const bootstrapCount = path.join(root, 'bootstrap-count');

  await mkdir(defaultWritableRoot, { recursive: true });
  await mkdir(path.dirname(runtimeRoot), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(secretDir, { recursive: true });
  await mkdir(plistDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  await writeFile(keyFile, 'test-runtime-key\n');

  // Model a real upgrade: the previous release and candidate must be distinct,
  // independently verified artifacts. Reusing one artifact under a renamed
  // releases/previous alias conflates artifact identity with current-target
  // normalization and behaves differently across filesystem implementations.
  await git(sourceRepo, ['checkout', '--quiet', previousCommit]);
  const initial = await deployHostRuntime({
    sourceRoot: sourceRepo,
    runtimeRoot,
    defaultWritableRoot,
  });
  const previousCurrentTarget = path.join('releases', initial.artifactId);
  const previousArtifactId = initial.artifactId;
  await verifyCurrent(runtimeRoot);

  await git(sourceRepo, ['checkout', '--quiet', candidateCommit]);
  const candidateSource = await inspectSource({ sourceRoot: sourceRepo });
  assert.notEqual(
    candidateSource.artifactId,
    previousArtifactId,
    'installer fixture requires distinct previous and candidate artifacts',
  );

  const oldProfile = 'old-live-profile\n';
  const oldPlist = 'old-launch-agent-plist\n';
  const oldLegacyPlist = 'old-legacy-http-launch-agent-plist\n';
  await writeFile(liveProfile, oldProfile);
  await writeFile(plist, oldPlist);
  await writeFile(legacyPlist, oldLegacyPlist);
  await writeFile(launchdState, 'running');
  await writeFile(
    legacyLaunchdState,
    overrides.FAKE_LEGACY_INITIAL_STATE === 'running' ? 'running' : 'stopped',
  );
  await writeFile(legacyBootoutCount, '0');
  await writeFile(bootstrapCount, '0');
  await writeFile(fakeLog, '');

  const fakeLaunchctl = path.join(fakeBin, 'launchctl');
  await writeExecutable(fakeLaunchctl, `#!/usr/bin/env bash
set -euo pipefail
printf 'launchctl %s\\n' "$*" >> "$FAKE_LOG"
command_name="$1"
all_args="$*"
is_main=0
is_legacy=0
case "$all_args" in
  *com.webmcp.devspace-tunnel*) is_main=1 ;;
  *com.webmcp.devspace-adapter*) is_legacy=1 ;;
esac
state=stopped
if [ -f "$FAKE_LAUNCHD_STATE" ]; then
  state="$(cat "$FAKE_LAUNCHD_STATE")"
fi
legacy_state=stopped
if [ -f "$FAKE_LEGACY_LAUNCHD_STATE" ]; then
  legacy_state="$(cat "$FAKE_LEGACY_LAUNCHD_STATE")"
fi
case "$command_name" in
  print)
    if [ "$is_main" -eq 1 ]; then
      if [ "$FAKE_JOB_QUERY_ERROR" = 1 ]; then
        exit 5
      fi
      if [ "$FAKE_JOB_FORCE_ABSENT" = 1 ]; then
        exit 113
      fi
      count="$(cat "$FAKE_BOOTSTRAP_COUNT")"
      if [ "$FAKE_JOB_QUERY_ERROR_AFTER_BOOTSTRAP" = 1 ] && [ "$count" -ge 1 ]; then
        exit 5
      fi
      if [ "$state" = running ]; then
        echo '    pid = 4242'
        exit 0
      fi
      exit 113
    fi
    if [ "$is_legacy" -eq 1 ]; then
      if [ "$FAKE_LEGACY_QUERY_ERROR" = 1 ]; then
        exit 5
      fi
      legacy_bootouts="$(cat "$FAKE_LEGACY_BOOTOUT_COUNT")"
      if [ "$FAKE_LEGACY_QUERY_ERROR_AFTER_BOOTOUT" = 1 ] && [ "$legacy_bootouts" -ge 1 ]; then
        exit 5
      fi
      [ "$legacy_state" = running ] && exit 0
      exit 113
    fi
    exit 113
    ;;
  bootout)
    if [ "$is_main" -eq 1 ]; then
      if [ "$FAKE_BOOTOUT_FAIL" = 1 ]; then
        exit 1
      fi
      printf stopped > "$FAKE_LAUNCHD_STATE"
      exit 0
    fi
    if [ "$is_legacy" -eq 1 ]; then
      if [ "$FAKE_LEGACY_BOOTOUT_FAIL" = 1 ]; then
        exit 1
      fi
      legacy_bootouts="$(cat "$FAKE_LEGACY_BOOTOUT_COUNT")"
      legacy_bootouts=$((legacy_bootouts + 1))
      printf '%s' "$legacy_bootouts" > "$FAKE_LEGACY_BOOTOUT_COUNT"
      if [ "$FAKE_LEGACY_STAYS_LOADED" != 1 ]; then
        printf stopped > "$FAKE_LEGACY_LAUNCHD_STATE"
      fi
      exit 0
    fi
    exit 0
    ;;
  enable)
    exit 0
    ;;
  bootstrap)
    count="$(cat "$FAKE_BOOTSTRAP_COUNT")"
    count=$((count + 1))
    printf '%s' "$count" > "$FAKE_BOOTSTRAP_COUNT"
    if [ "$FAKE_BOOTSTRAP_FAIL_ALWAYS" = 1 ]; then
      exit 1
    fi
    if [ "$FAKE_BOOTSTRAP_FAIL_ONCE" = 1 ] && [ "$count" -eq 1 ]; then
      exit 1
    fi
    printf running > "$FAKE_LAUNCHD_STATE"
    if [ "$FAKE_READY" = 1 ]; then
      mkdir -p "$(dirname "$FAKE_HEALTH_FILE")"
      printf 'http://127.0.0.1:45678\\n' > "$FAKE_HEALTH_FILE"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

  const fakeTunnelClient = path.join(fakeBin, 'tunnel-client');
  await writeExecutable(fakeTunnelClient, `#!/usr/bin/env bash
set -euo pipefail
printf 'tunnel-client %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" != runtimes ]; then
  exit 0
fi
action="$2"
shift 2
case "$action" in
  connect)
    profile=devspace
    profile_dir=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --profile) profile="$2"; shift 2 ;;
        --profile-dir) profile_dir="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    mkdir -p "$profile_dir"
    printf 'new-live-profile\\n' > "$profile_dir/$profile.yaml"
    if [ "$FAKE_CONNECT_FAIL" = 1 ]; then
      exit 1
    fi
    ;;
  status)
    printf '{"process_running":true,"ready":true}\\n'
    ;;
  stop|rm)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

  const fakePlutil = path.join(fakeBin, 'plutil');
  await writeExecutable(fakePlutil, `#!/usr/bin/env bash
set -euo pipefail
printf 'plutil %s\\n' "$*" >> "$FAKE_LOG"
if [ "$FAKE_PLUTIL_FAIL" = 1 ]; then
  exit 1
fi
exit 0
`);

  const fakeCurl = path.join(fakeBin, 'curl');
  await writeExecutable(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >> "$FAKE_LOG"
if [ "$FAKE_READY" = 1 ]; then
  printf ready
  exit 0
fi
exit 1
`);

  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: tmpDir,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    WEBMCP_RUNTIME_NODE_BIN: process.execPath,
    WEBMCP_HOST_RUNTIME_ROOT: runtimeRoot,
    DEVSPACE_PROJECT_ROOT: '',
    TUNNEL_CLIENT_BIN: fakeTunnelClient,
    TUNNEL_PROFILE_DIR: profileDir,
    TUNNEL_RUNTIME_DIR: runtimeDir,
    TUNNEL_SECRET_DIR: secretDir,
    TUNNEL_RUNTIME_KEY_FILE: keyFile,
    TUNNEL_HEALTH_URL_FILE: healthFile,
    TUNNEL_ID: `tunnel_${'a'.repeat(32)}`,
    PLUTIL_BIN: fakePlutil,
    PYTHON3_BIN: '/usr/bin/python3',
    WEBMCP_READY_ATTEMPTS: '1',
    WEBMCP_READY_DELAY_SECONDS: '0',
    FAKE_LOG: fakeLog,
    FAKE_LAUNCHD_STATE: launchdState,
    FAKE_LEGACY_LAUNCHD_STATE: legacyLaunchdState,
    FAKE_LEGACY_BOOTOUT_COUNT: legacyBootoutCount,
    FAKE_BOOTSTRAP_COUNT: bootstrapCount,
    FAKE_HEALTH_FILE: healthFile,
    FAKE_CONNECT_FAIL: '0',
    FAKE_PLUTIL_FAIL: '0',
    FAKE_BOOTSTRAP_FAIL_ONCE: '0',
    FAKE_BOOTSTRAP_FAIL_ALWAYS: '0',
    FAKE_BOOTOUT_FAIL: '0',
    FAKE_JOB_QUERY_ERROR: '0',
    FAKE_JOB_QUERY_ERROR_AFTER_BOOTSTRAP: '0',
    FAKE_JOB_FORCE_ABSENT: '0',
    FAKE_LEGACY_QUERY_ERROR: '0',
    FAKE_LEGACY_QUERY_ERROR_AFTER_BOOTOUT: '0',
    FAKE_LEGACY_BOOTOUT_FAIL: '0',
    FAKE_LEGACY_STAYS_LOADED: '0',
    FAKE_LEGACY_INITIAL_STATE: 'stopped',
    FAKE_READY: '0',
    ...overrides,
  };

  return {
    env,
    home,
    runtimeRoot,
    liveProfile,
    plist,
    legacyPlist,
    healthFile,
    fakeLog,
    launchdState,
    legacyLaunchdState,
    legacyBootoutCount,
    bootstrapCount,
    previousCurrentTarget,
    oldProfile,
    oldPlist,
    oldLegacyPlist,
    sourceRepo,
    previousArtifactId,
    candidateArtifactId: candidateSource.artifactId,
    installer: path.join(sourceRepo, 'adapter', 'deploy', 'install-launchd.sh'),
  };
}

async function runInstallerScenario(root, overrides = {}, args = []) {
  const scenario = await prepareInstallerScenario(root, overrides);
  const installer = scenario.installer;
  try {
    const { stdout, stderr } = await execFileAsync('bash', [installer, ...args], {
      env: scenario.env,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ...scenario, code: 0, stdout, stderr };
  } catch (error) {
    return {
      ...scenario,
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function assertPreviousActivationState(scenario) {
  assert.equal(
    await readlink(path.join(scenario.runtimeRoot, 'current')),
    scenario.previousCurrentTarget,
  );
  assert.equal(await readFile(scenario.liveProfile, 'utf8'), scenario.oldProfile);
  assert.equal(await readFile(scenario.plist, 'utf8'), scenario.oldPlist);
  assert.equal(await readFile(scenario.launchdState, 'utf8'), 'running');
}

test('builds and verifies a host-only snapshot from the real tracked adapter runtime', async () => {
  await withTempDir(async (tempRoot) => {
    const sourceRoot = await createCleanRepository(tempRoot);
    const runtimeRoot = path.join(tempRoot, 'runtime');
    const result = await deployHostRuntime({
      sourceRoot,
      runtimeRoot,
      projectRoot: sourceRoot,
      defaultWritableRoot: sourceRoot,
    });

    const verified = await verifyRelease(result.releaseDir, {
      expectedArtifactId: result.artifactId,
      expectedPayloadSha256: result.payloadSha256,
    });
    assert.equal(
      await readlink(path.join(runtimeRoot, 'current')),
      path.join('releases', result.artifactId),
    );
    assert.equal(verified.manifest.gitCommit, await git(sourceRoot, ['rev-parse', 'HEAD']).then((value) => value.trim()));
    assert.deepEqual(
      verified.manifest.files.map((file) => file.path).sort(),
      [...HOST_RUNTIME_PAYLOAD].sort(),
    );

    const objects = await walk(result.releaseDir);
    for (const object of objects) {
      assert.equal(object.stat.isSymbolicLink(), false, `snapshot contains symlink: ${object.relativePath}`);
      if (object.stat.isFile() && object.relativePath !== 'config/devspace-projects.yaml') {
        const bytes = await readFile(path.join(result.releaseDir, object.relativePath));
        assert.equal(
          bytes.includes(Buffer.from(sourceRoot, 'utf8')),
          false,
          `snapshot contains writable-repository backreference: ${object.relativePath}`,
        );
      }
    }
    assert.equal(HOST_RUNTIME_PAYLOAD.includes('adapter/src/recovery.js'), false);
    assert.equal(HOST_RUNTIME_PAYLOAD.includes('gateway/tool-executor/index.js'), false);
    const manifestText = await readFile(path.join(result.releaseDir, 'manifest.json'), 'utf8');
    assert.doesNotMatch(manifestText, /sourceRoot|repositoryRoot|\/work\/My code\/webmcp-bridge\/adapter\/bin\/start\.js/);
  });
});

test('deployer CLI executes when invoked through a filesystem path alias', async () => {
  await withTempDir(async (tempRoot) => {
    const sourceRoot = await createCleanRepository(tempRoot);
    const sourceAlias = path.join(tempRoot, 'repo-alias');
    const runtimeRoot = path.join(tempRoot, 'runtime');
    const fakeHome = path.join(tempRoot, 'home');
    await mkdir(path.join(fakeHome, 'Doc', 'My code'), { recursive: true });
    await symlink(sourceRoot, sourceAlias, 'dir');

    const { stdout } = await execFileAsync(process.execPath, [
      path.join(sourceAlias, 'adapter', 'deploy', 'deploy-host-runtime.js'),
      '--source-root', sourceAlias,
      '--runtime-root', runtimeRoot,
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
      maxBuffer: 8 * 1024 * 1024,
    });

    const result = JSON.parse(stdout);
    assert.equal(
      await readlink(path.join(runtimeRoot, 'current')),
      path.join('releases', result.artifactId),
    );
  });
});

test('starts the real adapter from the snapshot with adapter/gateway/config dependencies intact', async () => {
  await withTempDir(async (tempRoot) => {
    const sourceRoot = await createCleanRepository(tempRoot);
    const runtimeRoot = path.join(tempRoot, 'runtime');
    const result = await deployHostRuntime({
      sourceRoot,
      runtimeRoot,
      projectRoot: sourceRoot,
      defaultWritableRoot: sourceRoot,
    });

    const stderr = [];
    const env = {
      ...process.env,
      ADAPTER_TRANSPORT: 'stdio',
      DEVSPACE_OWNER_TOKEN_REF: 'env:SNAPSHOT_OWNER_TOKEN',
      SNAPSHOT_OWNER_TOKEN: 'snapshot-owner-token-for-host-runtime-test',
      DEVSPACE_HOST_ID: 'macbook-pro',
    };
    delete env.DEVSPACE_PROJECT_REGISTRY_PATH;
    const child = spawn(result.entrypoint, [], {
      cwd: result.releaseDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    try {
      await waitForAlive(child, stderr);
    } finally {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(1000)]);
    }
    assert.doesNotMatch(stderr.join(''), /ERR_MODULE_NOT_FOUND|Cannot find module|project registry error/i);
  });
});

test('fails closed for dirty, missing, malformed, and untracked payload sources', async () => {
  await withTempDir(async (root) => {
    const fixture = await createFixture(root);

    await writeFile(path.join(fixture.sourceRoot, 'package.json'), '{"type":"commonjs"}\n');
    await assert.rejects(
      inspectSource({ sourceRoot: fixture.sourceRoot, payloadPaths: MINIMAL_PAYLOAD }),
      assertHostRuntimeCode('DIRTY_RUNTIME_SOURCE'),
    );
    await git(fixture.sourceRoot, ['checkout', '--', 'package.json']);

    await rm(path.join(fixture.sourceRoot, 'package.json'));
    await assert.rejects(
      inspectSource({ sourceRoot: fixture.sourceRoot, payloadPaths: MINIMAL_PAYLOAD }),
      assertHostRuntimeCode('MISSING_RUNTIME_SOURCE'),
    );
    await git(fixture.sourceRoot, ['checkout', '--', 'package.json']);

    const startPath = path.join(fixture.sourceRoot, 'adapter', 'bin', 'start.js');
    await rm(startPath);
    await symlink('/dev/null', startPath);
    await assert.rejects(
      inspectSource({ sourceRoot: fixture.sourceRoot, payloadPaths: MINIMAL_PAYLOAD }),
      assertHostRuntimeCode('MALFORMED_RUNTIME_SOURCE'),
    );
    await rm(startPath);
    await git(fixture.sourceRoot, ['checkout', '--', 'adapter/bin/start.js']);

    const untracked = 'adapter/bin/untracked.js';
    await writeFile(path.join(fixture.sourceRoot, untracked), 'export {};\n');
    await assert.rejects(
      inspectSource({
        sourceRoot: fixture.sourceRoot,
        payloadPaths: [...MINIMAL_PAYLOAD, untracked],
      }),
      assertHostRuntimeCode('DIRTY_RUNTIME_SOURCE'),
    );
  });
});

test('rejects lexical and canonical absolute repository backreferences across path aliases', async () => {
  await withTempDir(async (root) => {
    const fixture = await createFixture(root);
    const aliasRoot = path.join(root, 'repo-alias');
    await symlink(fixture.sourceRoot, aliasRoot, 'dir');
    assert.notEqual(aliasRoot, await realpath(aliasRoot));

    const commitBackreference = async (absolutePath, message) => {
      await writeFile(
        path.join(fixture.sourceRoot, 'adapter', 'bin', 'start.js'),
        `#!/usr/bin/env node\nconst unsafe = ${JSON.stringify(absolutePath)};\nprocess.stdin.resume();\n`,
      );
      await chmod(path.join(fixture.sourceRoot, 'adapter', 'bin', 'start.js'), 0o755);
      await git(fixture.sourceRoot, ['add', 'adapter/bin/start.js']);
      await git(fixture.sourceRoot, [
        '-c', 'user.name=Host Runtime Test',
        '-c', 'user.email=host-runtime@example.invalid',
        'commit', '-qm', message,
      ]);
    };

    await commitBackreference(aliasRoot, 'lexical alias backreference');
    await assert.rejects(
      inspectSource({ sourceRoot: aliasRoot, payloadPaths: MINIMAL_PAYLOAD }),
      assertHostRuntimeCode('REPOSITORY_BACKREFERENCE'),
    );

    await commitBackreference(await realpath(aliasRoot), 'canonical backreference');
    await assert.rejects(
      inspectSource({ sourceRoot: aliasRoot, payloadPaths: MINIMAL_PAYLOAD }),
      assertHostRuntimeCode('REPOSITORY_BACKREFERENCE'),
    );
  });
});

test('rejects a runtime root inside the DevSpace-writable project tree', async () => {
  await withTempDir(async (root) => {
    const fixture = await createFixture(root);
    await assert.rejects(
      deployHostRuntime({
        sourceRoot: fixture.sourceRoot,
        runtimeRoot: path.join(fixture.projectRoot, 'runtime'),
        projectRoot: fixture.projectRoot,
        defaultWritableRoot: fixture.defaultWritableRoot,
        payloadPaths: MINIMAL_PAYLOAD,
      }),
      assertHostRuntimeCode('UNSAFE_RUNTIME_ROOT'),
    );
  });
});

test('an unrelated or narrower project root cannot shrink the default writable boundary', async () => {
  await withTempDir(async (root) => {
    const fixture = await createFixture(root);
    const unrelatedRoot = path.join(root, 'unrelated-project-root');
    await mkdir(unrelatedRoot, { recursive: true });

    await assert.rejects(
      deployHostRuntime({
        sourceRoot: fixture.sourceRoot,
        runtimeRoot: path.join(fixture.defaultWritableRoot, 'runtime-bypass-attempt'),
        projectRoot: unrelatedRoot,
        defaultWritableRoot: fixture.defaultWritableRoot,
        payloadPaths: MINIMAL_PAYLOAD,
      }),
      assertHostRuntimeCode('UNSAFE_RUNTIME_ROOT'),
    );
  });
});

test('missing or malformed writable roots fail closed', async () => {
  await withTempDir(async (root) => {
    const fixture = await createFixture(root);
    await assert.rejects(
      deployHostRuntime({
        ...fixture,
        defaultWritableRoot: path.join(root, 'missing-default-root'),
        payloadPaths: MINIMAL_PAYLOAD,
      }),
      assertHostRuntimeCode('UNSAFE_WRITABLE_ROOT'),
    );

    const fileRoot = path.join(root, 'not-a-directory');
    await writeFile(fileRoot, 'not a writable root\n');
    await assert.rejects(
      deployHostRuntime({
        ...fixture,
        writableRoots: [fileRoot],
        payloadPaths: MINIMAL_PAYLOAD,
      }),
      assertHostRuntimeCode('UNSAFE_WRITABLE_ROOT'),
    );
  });
});

test('build failure leaves the existing current release unchanged', async () => {
  await withTempDir(async (root) => {
    const fixture = await createFixture(root);
    const first = await deployHostRuntime({
      ...fixture,
      payloadPaths: MINIMAL_PAYLOAD,
    });
    const currentBefore = await readlink(path.join(fixture.runtimeRoot, 'current'));

    await writeFile(
      path.join(fixture.sourceRoot, 'adapter', 'bin', 'start.js'),
      '#!/usr/bin/env node\nprocess.stdin.resume();\n// v2\n',
    );
    await git(fixture.sourceRoot, ['add', 'adapter/bin/start.js']);
    await git(fixture.sourceRoot, [
      '-c', 'user.name=Host Runtime Test',
      '-c', 'user.email=host-runtime@example.invalid',
      'commit', '-qm', 'v2',
    ]);

    let writes = 0;
    await assert.rejects(
      deployHostRuntime({
        ...fixture,
        payloadPaths: MINIMAL_PAYLOAD,
        writePayloadFile: async (_sourcePath, destinationPath, file) => {
          writes += 1;
          if (writes === 2) throw new Error('simulated copy failure');
          await writeFile(destinationPath, file.bytes, { mode: Number.parseInt(file.mode, 8) });
        },
      }),
      assertHostRuntimeCode('HOST_RUNTIME_DEPLOY_FAILED'),
    );

    assert.equal(await readlink(path.join(fixture.runtimeRoot, 'current')), currentBefore);
    const current = await verifyCurrent(fixture.runtimeRoot);
    assert.equal(current.artifactId, first.artifactId);
  });
});

test('switches current atomically to a second verified release and preserves the old release', async () => {
  await withTempDir(async (root) => {
    const fixture = await createFixture(root);
    const first = await deployHostRuntime({
      ...fixture,
      payloadPaths: MINIMAL_PAYLOAD,
    });

    await writeFile(
      path.join(fixture.sourceRoot, 'adapter', 'bin', 'start.js'),
      '#!/usr/bin/env node\nprocess.stdin.resume();\n// second release\n',
    );
    await chmod(path.join(fixture.sourceRoot, 'adapter', 'bin', 'start.js'), 0o755);
    await git(fixture.sourceRoot, ['add', 'adapter/bin/start.js']);
    await git(fixture.sourceRoot, [
      '-c', 'user.name=Host Runtime Test',
      '-c', 'user.email=host-runtime@example.invalid',
      'commit', '-qm', 'second',
    ]);

    const oldTarget = await readlink(path.join(fixture.runtimeRoot, 'current'));
    let replacementObserved = false;
    const second = await deployHostRuntime({
      ...fixture,
      payloadPaths: MINIMAL_PAYLOAD,
      replaceCurrent: async (temporaryCurrent, currentPath) => {
        assert.equal(
          await readlink(currentPath),
          oldTarget,
          'old current must remain valid until the single rename replacement',
        );
        replacementObserved = true;
        await rename(temporaryCurrent, currentPath);
      },
    });
    assert.equal(replacementObserved, true);
    assert.notEqual(second.artifactId, first.artifactId);
    const current = await verifyCurrent(fixture.runtimeRoot);
    assert.equal(current.artifactId, second.artifactId);
    assert.equal(second.previousArtifactId, first.artifactId);
    await verifyRelease(first.releaseDir, { expectedArtifactId: first.artifactId });
    await verifyRelease(second.releaseDir, { expectedArtifactId: second.artifactId });
  });
});

test('rejects a current switch that leaves a same-artifact non-canonical alias in place', async () => {
  await withTempDir(async (root) => {
    const fixture = await createFixture(root);
    const first = await deployHostRuntime({
      ...fixture,
      payloadPaths: MINIMAL_PAYLOAD,
    });
    const currentPath = path.join(fixture.runtimeRoot, 'current');
    const aliasRelease = path.join(fixture.runtimeRoot, 'releases', 'previous');
    await rename(first.releaseDir, aliasRelease);
    await rm(currentPath);
    await symlink(path.join('releases', 'previous'), currentPath, 'dir');

    const aliasCurrent = await verifyCurrent(fixture.runtimeRoot);
    assert.equal(aliasCurrent.artifactId, first.artifactId);

    await assert.rejects(
      deployHostRuntime({
        ...fixture,
        payloadPaths: MINIMAL_PAYLOAD,
        replaceCurrent: async (temporaryCurrent) => {
          // Simulate a platform/filesystem replacement that reports success but
          // leaves the old alias in place. Artifact identity alone must not be
          // accepted as proof that current was canonicalized.
          await rm(temporaryCurrent);
        },
      }),
      assertHostRuntimeCode('CURRENT_SWITCH_FAILED'),
    );
    assert.equal(await readlink(currentPath), path.join('releases', 'previous'));
  });
});

test('rejects a corrupted release manifest, payload digest, or deployed file mode', async () => {
  await withTempDir(async (root) => {
    const fixture = await createFixture(root);
    const result = await deployHostRuntime({
      ...fixture,
      payloadPaths: MINIMAL_PAYLOAD,
    });
    const packagePath = path.join(result.releaseDir, 'package.json');
    await chmod(packagePath, 0o644);
    await assert.rejects(
      verifyRelease(result.releaseDir),
      assertHostRuntimeCode('RUNTIME_MANIFEST_MISMATCH'),
    );
    await chmod(packagePath, 0o600);
    await writeFile(packagePath, '{"tampered":true}\n');
    await assert.rejects(
      verifyRelease(result.releaseDir),
      assertHostRuntimeCode('RUNTIME_MANIFEST_MISMATCH'),
    );
  });
});

test('Tunnel installer and sample profile point only at the host-only current snapshot', async () => {
  const installer = await readFile(
    path.join(REPO_ROOT, 'adapter', 'deploy', 'install-launchd.sh'),
    'utf8',
  );
  assert.match(installer, /RUNTIME_ENTRY="\$HOST_RUNTIME_ROOT\/current\/adapter\/bin\/start\.js"/);
  assert.match(installer, /DEFAULT_WRITABLE_ROOT="\$HOME\/Doc\/My code"/);
  assert.match(installer, /EXTRA_WRITABLE_ROOT="\$\{DEVSPACE_PROJECT_ROOT:-\}"/);
  assert.match(installer, /--mcp-command "\$RUNTIME_ENTRY"/);
  assert.doesNotMatch(installer, /--mcp-command "\$REPO\/adapter\/bin\/start\.js"/);
  assert.doesNotMatch(installer, /ln -sfn "\$ENTRY"/);
  assert.doesNotMatch(installer, /LAUNCHER="\$LAUNCHER_DIR\/webmcp-devspace-adapter"/);

  const sampleProfile = await readFile(
    path.join(REPO_ROOT, 'adapter', 'deploy', 'tunnel-profile.devspace.yaml'),
    'utf8',
  );
  assert.match(sampleProfile, /devspace-container\/runtime\/webmcp-adapter\/current\/adapter\/bin\/start\.js/);
  assert.doesNotMatch(sampleProfile, /\.local\/bin\/webmcp-devspace-adapter/);
  assert.doesNotMatch(sampleProfile, /My code\/webmcp-bridge\/adapter\/bin\/start\.js/);
});

test('Phase A --status distinguishes absent exit 113 from query failure', async () => {
  await withTempDir(async (root) => {
    const absent = await runInstallerScenario(
      root,
      { FAKE_JOB_FORCE_ABSENT: '1' },
      ['--status'],
    );
    assert.notEqual(absent.code, 0);
    assert.match(absent.stderr, /未加载 LaunchAgent/);
    assert.doesNotMatch(absent.stderr, /无法确认 LaunchAgent 状态/);
  });

  await withTempDir(async (root) => {
    const unknown = await runInstallerScenario(
      root,
      { FAKE_JOB_QUERY_ERROR: '1' },
      ['--status'],
    );
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /无法确认 LaunchAgent 状态/);
    assert.doesNotMatch(unknown.stderr, /未加载 LaunchAgent/);
  });
});

test('Phase A unknown launchctl job state fails closed before activation changes', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, { FAKE_JOB_QUERY_ERROR: '1' });
    assert.notEqual(scenario.code, 0);
    await assertPreviousActivationState(scenario);
    assert.match(scenario.stderr, /无法确认 LaunchAgent 状态/);
    assert.match(scenario.stderr, /无法保存原 LaunchAgent 状态/);
    const log = await readFile(scenario.fakeLog, 'utf8');
    assert.doesNotMatch(log, /launchctl bootout/);
    assert.doesNotMatch(log, /tunnel-client runtimes connect/);
    assert.doesNotMatch(scenario.stderr, /bounded rollback 已恢复/);
  });
});

test('connect failure restores previous current, profile, plist, and running LaunchAgent', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, { FAKE_CONNECT_FAIL: '1' });
    assert.notEqual(scenario.code, 0);
    await assertPreviousActivationState(scenario);
    assert.match(scenario.stderr, /bounded rollback 已恢复 previous current\/profile\/plist/);
    const log = await readFile(scenario.fakeLog, 'utf8');
    assert.match(log, /tunnel-client runtimes connect/);
  });
});

test('plist validation failure happens before switching and preserves previous activation state', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, { FAKE_PLUTIL_FAIL: '1' });
    assert.notEqual(scenario.code, 0);
    await assertPreviousActivationState(scenario);
    assert.match(scenario.stderr, /plist candidate 校验失败/);
    const log = await readFile(scenario.fakeLog, 'utf8');
    assert.doesNotMatch(log, /tunnel-client runtimes connect/);
    assert.doesNotMatch(scenario.stderr, /bounded rollback 已恢复/);
  });
});

test('bootstrap failure uses the same bounded rollback and reboots the previous LaunchAgent', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, {
      FAKE_BOOTSTRAP_FAIL_ONCE: '1',
      FAKE_READY: '1',
    });
    assert.notEqual(scenario.code, 0);
    await assertPreviousActivationState(scenario);
    assert.match(scenario.stderr, /LaunchAgent bootstrap 失败/);
    assert.match(scenario.stderr, /bounded rollback 已恢复 previous current\/profile\/plist/);
    assert.equal(await readFile(scenario.bootstrapCount, 'utf8'), '2');
  });
});

test('readiness timeout restores previous current, profile, plist, and running LaunchAgent', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, { FAKE_READY: '0' });
    assert.notEqual(scenario.code, 0);
    await assertPreviousActivationState(scenario);
    assert.match(scenario.stderr, /限定 readiness 窗口内 ready/);
    assert.match(scenario.stderr, /bounded rollback 已恢复 previous current\/profile\/plist/);
    assert.equal(await readFile(scenario.bootstrapCount, 'utf8'), '2');
  });
});

test('successful activation keeps the host-only current entrypoint and commits the new state', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, { FAKE_READY: '1' });
    const currentTarget = await readlink(path.join(scenario.runtimeRoot, 'current'));
    const log = await readFile(scenario.fakeLog, 'utf8');
    const diagnostics = [
      `stdout=${JSON.stringify(scenario.stdout)}`,
      `stderr=${JSON.stringify(scenario.stderr)}`,
      `log=${JSON.stringify(log)}`,
      `previousTarget=${scenario.previousCurrentTarget}`,
      `currentTarget=${currentTarget}`,
      `previousArtifactId=${scenario.previousArtifactId}`,
      `candidateArtifactId=${scenario.candidateArtifactId}`,
    ].join(' ');

    assert.equal(scenario.code, 0, diagnostics);
    assert.notEqual(currentTarget, scenario.previousCurrentTarget, diagnostics);
    assert.equal(
      currentTarget,
      path.join('releases', scenario.candidateArtifactId),
      diagnostics,
    );
    assert.equal(await readFile(scenario.liveProfile, 'utf8'), 'new-live-profile\n');
    assert.notEqual(await readFile(scenario.plist, 'utf8'), scenario.oldPlist);
    assert.equal(await readFile(scenario.launchdState, 'utf8'), 'running');

    const hostEntrypoint = path.join(
      scenario.runtimeRoot,
      'current',
      'adapter',
      'bin',
      'start.js',
    );
    assert.ok(log.includes(`--mcp-command ${hostEntrypoint}`));
    assert.equal(log.includes(`--mcp-command ${path.join(scenario.sourceRepo, 'adapter', 'bin', 'start.js')}`), false);
  });
});

test('legacy HTTP query unknown fails after new Tunnel is ready and preserves legacy plist', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, {
      FAKE_READY: '1',
      FAKE_LEGACY_QUERY_ERROR: '1',
    });
    assert.notEqual(scenario.code, 0);
    assert.equal(await readFile(scenario.launchdState, 'utf8'), 'running');
    assert.equal(await readFile(scenario.legacyPlist, 'utf8'), scenario.oldLegacyPlist);
    assert.match(scenario.stderr, /新 Secure MCP Tunnel 已 ready，但 legacy HTTP adapter 未能确认停用/);
    assert.doesNotMatch(scenario.stdout, /✔ Secure MCP Tunnel 已由 launchd 常驻/);
  });
});

test('legacy HTTP bootout failure fails after new Tunnel is ready and preserves legacy plist', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, {
      FAKE_READY: '1',
      FAKE_LEGACY_INITIAL_STATE: 'running',
      FAKE_LEGACY_BOOTOUT_FAIL: '1',
    });
    assert.notEqual(scenario.code, 0);
    assert.equal(await readFile(scenario.launchdState, 'utf8'), 'running');
    assert.equal(await readFile(scenario.legacyLaunchdState, 'utf8'), 'running');
    assert.equal(await readFile(scenario.legacyPlist, 'utf8'), scenario.oldLegacyPlist);
    assert.match(scenario.stderr, /无法停止 legacy HTTP LaunchAgent/);
    assert.doesNotMatch(scenario.stdout, /✔ Secure MCP Tunnel 已由 launchd 常驻/);
  });
});

test('legacy HTTP post-bootout loaded or unknown state fails closed without rolling back new Tunnel', async () => {
  for (const overrides of [
    {
      FAKE_LEGACY_INITIAL_STATE: 'running',
      FAKE_LEGACY_STAYS_LOADED: '1',
    },
    {
      FAKE_LEGACY_INITIAL_STATE: 'running',
      FAKE_LEGACY_QUERY_ERROR_AFTER_BOOTOUT: '1',
    },
  ]) {
    await withTempDir(async (root) => {
      const scenario = await runInstallerScenario(root, {
        FAKE_READY: '1',
        ...overrides,
      });
      assert.notEqual(scenario.code, 0);
      assert.equal(await readFile(scenario.launchdState, 'utf8'), 'running');
      assert.equal(await readFile(scenario.legacyPlist, 'utf8'), scenario.oldLegacyPlist);
      assert.match(scenario.stderr, /新 Secure MCP Tunnel 已 ready，但 legacy HTTP adapter 未能确认停用/);
      assert.doesNotMatch(scenario.stdout, /✔ Secure MCP Tunnel 已由 launchd 常驻/);
    });
  }
});

test('legacy HTTP already absent allows successful install and disables legacy plist', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, { FAKE_READY: '1' });
    assert.equal(scenario.code, 0, scenario.stderr);
    assert.equal(await readFile(scenario.launchdState, 'utf8'), 'running');
    await assert.rejects(readFile(scenario.legacyPlist, 'utf8'), { code: 'ENOENT' });
    assert.equal(
      await readFile(`${scenario.legacyPlist}.disabled`, 'utf8'),
      scenario.oldLegacyPlist,
    );
    assert.match(scenario.stdout, /✔ Secure MCP Tunnel 已由 launchd 常驻/);
  });
});

test('legacy HTTP loaded then booted out and confirmed absent allows successful install', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, {
      FAKE_READY: '1',
      FAKE_LEGACY_INITIAL_STATE: 'running',
    });
    assert.equal(scenario.code, 0, scenario.stderr);
    assert.equal(await readFile(scenario.launchdState, 'utf8'), 'running');
    assert.equal(await readFile(scenario.legacyLaunchdState, 'utf8'), 'stopped');
    assert.equal(await readFile(scenario.legacyBootoutCount, 'utf8'), '1');
    await assert.rejects(readFile(scenario.legacyPlist, 'utf8'), { code: 'ENOENT' });
    assert.equal(
      await readFile(`${scenario.legacyPlist}.disabled`, 'utf8'),
      scenario.oldLegacyPlist,
    );
    assert.match(scenario.stdout, /✔ Secure MCP Tunnel 已由 launchd 常驻/);
  });
});

test('Phase A rollback job query error exits 70 and never claims recovery', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, {
      FAKE_BOOTSTRAP_FAIL_ONCE: '1',
      FAKE_JOB_QUERY_ERROR_AFTER_BOOTSTRAP: '1',
      FAKE_READY: '1',
    });
    assert.equal(scenario.code, 70);
    assert.equal(
      await readlink(path.join(scenario.runtimeRoot, 'current')),
      scenario.previousCurrentTarget,
    );
    assert.equal(await readFile(scenario.liveProfile, 'utf8'), scenario.oldProfile);
    assert.equal(await readFile(scenario.plist, 'utf8'), scenario.oldPlist);
    assert.equal(await readFile(scenario.launchdState, 'utf8'), 'stopped');
    assert.match(scenario.stderr, /ROLLBACK FAILED:/);
    assert.match(scenario.stderr, /无法确认失败的新 LaunchAgent 状态/);
    assert.doesNotMatch(scenario.stderr, /bounded rollback 已恢复 previous current\/profile\/plist/);
  });
});

test('rollback failure is reported explicitly and never claims the old service was restored', async () => {
  await withTempDir(async (root) => {
    const scenario = await runInstallerScenario(root, {
      FAKE_BOOTSTRAP_FAIL_ALWAYS: '1',
      FAKE_READY: '1',
    });
    assert.equal(scenario.code, 70);
    assert.equal(
      await readlink(path.join(scenario.runtimeRoot, 'current')),
      scenario.previousCurrentTarget,
    );
    assert.equal(await readFile(scenario.liveProfile, 'utf8'), scenario.oldProfile);
    assert.equal(await readFile(scenario.plist, 'utf8'), scenario.oldPlist);
    assert.equal(await readFile(scenario.launchdState, 'utf8'), 'stopped');
    assert.match(scenario.stderr, /ROLLBACK FAILED:/);
    assert.doesNotMatch(scenario.stderr, /bounded rollback 已恢复 previous current\/profile\/plist/);
  });
});
