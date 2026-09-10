import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(
  REPO_ROOT,
  'adapter',
  'deploy',
  'install-devspace-recovery-launchd.sh',
);

async function withTempDir(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-recovery-launchd-test-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeExecutable(target, contents = '#!/usr/bin/env bash\nexit 0\n') {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  await chmod(target, 0o755);
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function createHarness(root, {
  homeName = 'home with spaces',
  dsupMode = 'valid',
  existingPlist = false,
  running = false,
  plutilFailCandidate = false,
  plutilFailExisting = false,
  bootstrapFailOnce = false,
  bootstrapFailAlways = false,
  bootoutFail = false,
  bootoutDelayQueries = 0,
  jobQueryError = false,
  jobQueryErrorAfterBootstrap = false,
  launchdDomainAvailable = true,
} = {}) {
  const home = path.join(root, homeName);
  const docRoot = path.join(home, 'Doc');
  const projectRoot = path.join(docRoot, 'My code');
  const controlPlane = path.join(docRoot, 'devspace-container');
  const dsup = path.join(controlPlane, 'dsup.sh');
  const plistDir = path.join(home, 'Library', 'LaunchAgents');
  const plist = path.join(plistDir, 'com.webmcp.devspace-recovery.plist');
  const logDir = path.join(home, 'Library', 'Logs');
  const fakeBin = path.join(root, 'fake-bin');
  const tmpDir = path.join(root, 'tmp');
  const fakeLog = path.join(root, 'fake.log');
  const launchdState = path.join(root, 'launchd-state');
  const bootoutPending = path.join(root, 'bootout-pending');
  const bootstrapCount = path.join(root, 'bootstrap-count');

  await mkdir(projectRoot, { recursive: true });
  await mkdir(plistDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  await writeFile(fakeLog, '');
  await writeFile(launchdState, running ? 'running' : 'stopped');
  await writeFile(bootoutPending, '0');
  await writeFile(bootstrapCount, '0');

  if (dsupMode === 'inside-project') {
    const insideControlPlane = path.join(projectRoot, 'attacker-control-plane');
    await writeExecutable(path.join(insideControlPlane, 'dsup.sh'));
    await symlink(insideControlPlane, controlPlane, 'dir');
  } else {
    await mkdir(controlPlane, { recursive: true });
    if (dsupMode === 'valid' || dsupMode === 'non-executable') {
      await writeFile(dsup, '#!/usr/bin/env bash\nexit 0\n');
      await chmod(dsup, dsupMode === 'valid' ? 0o755 : 0o644);
    } else if (dsupMode === 'hard-link') {
      const attackerScript = path.join(projectRoot, 'attacker-script.sh');
      await writeExecutable(attackerScript, '#!/usr/bin/env bash\n# HARD_LINK_SECRET_MARKER\nexit 0\n');
      await link(attackerScript, dsup);
    } else if (dsupMode === 'symlink') {
      const safeTarget = path.join(root, 'safe-control-plane', 'dsup.sh');
      await writeExecutable(safeTarget);
      await symlink(safeTarget, dsup);
    } else if (dsupMode !== 'missing') {
      throw new Error(`unknown dsupMode: ${dsupMode}`);
    }
  }

  const oldPlist = 'previous-valid-plist\n';
  if (existingPlist) {
    await writeFile(plist, oldPlist);
  }

  const fakeLaunchctl = path.join(fakeBin, 'launchctl');
  await writeExecutable(fakeLaunchctl, `#!/usr/bin/env bash
set -euo pipefail
printf 'launchctl %s\\n' "$*" >> "$FAKE_LOG"
command_name="\${1:-}"
target="\${2:-}"
case "$command_name" in
  print)
    if [ "$target" = "$FAKE_DOMAIN" ]; then
      [ "$FAKE_DOMAIN_AVAILABLE" = 1 ] && exit 0
      exit 1
    fi
    if [ "$target" = "$FAKE_DOMAIN/$FAKE_LABEL" ]; then
      if [ "$FAKE_JOB_QUERY_ERROR" = 1 ]; then
        exit 5
      fi
      count="$(cat "$FAKE_BOOTSTRAP_COUNT")"
      if [ "$FAKE_JOB_QUERY_ERROR_AFTER_BOOTSTRAP" = 1 ] && [ "$count" -ge 1 ]; then
        exit 5
      fi
      if [ "$(cat "$FAKE_LAUNCHD_STATE")" = pending ]; then
        remaining="$(cat "$FAKE_BOOTOUT_PENDING")"
        if [ "$remaining" -gt 0 ]; then
          printf '%s' "$((remaining - 1))" > "$FAKE_BOOTOUT_PENDING"
          exit 0
        fi
        printf stopped > "$FAKE_LAUNCHD_STATE"
      fi
      [ "$(cat "$FAKE_LAUNCHD_STATE")" = running ] && exit 0
      exit 113
    fi
    exit 1
    ;;
  bootout)
    if [ "$target" = "$FAKE_DOMAIN/$FAKE_LABEL" ]; then
      if [ "$FAKE_BOOTOUT_FAIL" = 1 ]; then
        exit 1
      fi
      if [ "$FAKE_BOOTOUT_DELAY_QUERIES" -gt 0 ]; then
        printf pending > "$FAKE_LAUNCHD_STATE"
        printf '%s' "$FAKE_BOOTOUT_DELAY_QUERIES" > "$FAKE_BOOTOUT_PENDING"
      else
        printf stopped > "$FAKE_LAUNCHD_STATE"
      fi
      exit 0
    fi
    exit 1
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
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

  const fakePlutil = path.join(fakeBin, 'plutil');
  await writeExecutable(fakePlutil, `#!/usr/bin/env bash
set -euo pipefail
printf 'plutil %s\\n' "$*" >> "$FAKE_LOG"
case "\${2:-}" in
  *.candidate.*)
    [ "$FAKE_PLUTIL_FAIL_CANDIDATE" = 1 ] && exit 1
    ;;
  *)
    [ "$FAKE_PLUTIL_FAIL_EXISTING" = 1 ] && exit 1
    ;;
esac
exit 0
`);

  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const label = 'com.webmcp.devspace-recovery';
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: tmpDir,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    LAUNCHCTL_BIN: fakeLaunchctl,
    PLUTIL_BIN: fakePlutil,
    PYTHON3_BIN: '/usr/bin/python3',
    FAKE_LOG: fakeLog,
    FAKE_LAUNCHD_STATE: launchdState,
    FAKE_BOOTOUT_PENDING: bootoutPending,
    FAKE_BOOTSTRAP_COUNT: bootstrapCount,
    FAKE_BOOTSTRAP_FAIL_ONCE: bootstrapFailOnce ? '1' : '0',
    FAKE_BOOTSTRAP_FAIL_ALWAYS: bootstrapFailAlways ? '1' : '0',
    FAKE_BOOTOUT_FAIL: bootoutFail ? '1' : '0',
    FAKE_BOOTOUT_DELAY_QUERIES: String(bootoutDelayQueries),
    FAKE_JOB_QUERY_ERROR: jobQueryError ? '1' : '0',
    FAKE_JOB_QUERY_ERROR_AFTER_BOOTSTRAP: jobQueryErrorAfterBootstrap ? '1' : '0',
    FAKE_PLUTIL_FAIL_CANDIDATE: plutilFailCandidate ? '1' : '0',
    FAKE_PLUTIL_FAIL_EXISTING: plutilFailExisting ? '1' : '0',
    FAKE_DOMAIN_AVAILABLE: launchdDomainAvailable ? '1' : '0',
    FAKE_DOMAIN: domain,
    FAKE_LABEL: label,
    WEBMCP_RECOVERY_STOP_ATTEMPTS: '10',
    WEBMCP_RECOVERY_STOP_DELAY_SECONDS: '0',
  };

  return {
    env,
    home,
    projectRoot,
    controlPlane,
    dsup,
    plist,
    oldPlist,
    fakeLog,
    launchdState,
    bootstrapCount,
    domain,
    label,
  };
}

async function runInstaller(harness, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [INSTALLER, ...args], {
      env: harness.env,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

function plistProgramArguments(plistText) {
  const match = plistText.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  assert.ok(match, 'ProgramArguments array should exist');
  return [...match[1].matchAll(/<string>([^<]*)<\/string>/g)].map((item) => item[1]);
}

test('plist ProgramArguments point exactly to host-only dsup.sh --ensure', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root);
    const result = await runInstaller(harness);
    assert.equal(result.code, 0, result.stderr);

    const plistText = await readFile(harness.plist, 'utf8');
    assert.deepEqual(plistProgramArguments(plistText), [harness.dsup, '--ensure']);
    assert.match(plistText, /<key>StandardOutPath<\/key>/);
    assert.match(plistText, /Library\/Logs\/webmcp-devspace-recovery\.log/);
    assert.match(plistText, /Library\/Logs\/webmcp-devspace-recovery\.err/);
  });
});

test('host path containing spaces remains one exact ProgramArguments entry', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, { homeName: 'home path with spaces' });
    const result = await runInstaller(harness);
    assert.equal(result.code, 0, result.stderr);
    const plistText = await readFile(harness.plist, 'utf8');
    assert.deepEqual(plistProgramArguments(plistText), [harness.dsup, '--ensure']);
    assert.match(harness.dsup, / /);
  });
});

test('plist contains no node, repository path, /work path, or recovery controller', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root);
    const result = await runInstaller(harness);
    assert.equal(result.code, 0, result.stderr);
    const plistText = await readFile(harness.plist, 'utf8');
    assert.doesNotMatch(plistText, /node/i);
    assert.doesNotMatch(plistText, /webmcp-bridge/);
    assert.doesNotMatch(plistText, /\/work\//);
    assert.doesNotMatch(plistText, /recovery\.js|ensure-devspace\.js/);
  });
});

test('plist uses RunAtLoad and StartInterval without KeepAlive', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root);
    const result = await runInstaller(harness);
    assert.equal(result.code, 0, result.stderr);
    const plistText = await readFile(harness.plist, 'utf8');
    assert.match(plistText, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plistText, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.doesNotMatch(plistText, /<key>KeepAlive<\/key>/);
  });
});

test('missing dsup.sh is rejected before plist creation', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, { dsupMode: 'missing' });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /dsup\.sh 不存在/);
    assert.equal(await exists(harness.plist), false);
  });
});

test('non-executable dsup.sh is rejected', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, { dsupMode: 'non-executable' });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /dsup\.sh 不可执行/);
    assert.equal(await exists(harness.plist), false);
  });
});

test('symlink dsup.sh is rejected', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, { dsupMode: 'symlink' });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /拒绝符号链接 dsup\.sh/);
    assert.equal(await exists(harness.plist), false);
  });
});

test('dsup.sh resolving inside $HOME/Doc/My code is rejected', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, { dsupMode: 'inside-project' });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /DevSpace-writable project root 内/);
    assert.equal(await exists(harness.plist), false);
  });
});

test('hard-linked dsup.sh shared with the writable project root is rejected', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, { dsupMode: 'hard-link' });
    const canonicalDsup = await realpath(harness.dsup);
    const canonicalProjectRoot = await realpath(harness.projectRoot);
    const relativeFromProject = path.relative(canonicalProjectRoot, canonicalDsup);

    // macOS commonly exposes temporary paths lexically under /var while
    // realpath canonicalizes them under /private/var. Compare canonical
    // boundaries, not lexical spelling, while still proving the visible dsup
    // path is the host control-plane location.
    assert.equal(harness.dsup, path.join(harness.controlPlane, 'dsup.sh'));
    assert.match(harness.dsup, /Doc\/devspace-container\/dsup\.sh$/);
    assert.ok(
      relativeFromProject === '..'
        || relativeFromProject.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeFromProject),
      `canonical dsup unexpectedly resolved inside project root: ${relativeFromProject}`,
    );

    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /link count 非 1/);
    assert.doesNotMatch(result.stderr, /HARD_LINK_SECRET_MARKER/);
    assert.equal(await exists(harness.plist), false);
  });
});

test('job print exit 113 is treated as absent', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, { running: false });
    const result = await runInstaller(harness);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'running');
    assert.doesNotMatch(await readFile(harness.fakeLog, 'utf8'), /launchctl bootout/);
  });
});

test('unknown job query fails closed before plist or service switching', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, {
      existingPlist: true,
      running: true,
      jobQueryError: true,
    });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /launchctl 无法确认 LaunchAgent 状态/);
    assert.match(result.stderr, /无法保存 previous LaunchAgent 状态/);
    assert.equal(await readFile(harness.plist, 'utf8'), harness.oldPlist);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'running');
    assert.doesNotMatch(await readFile(harness.fakeLog, 'utf8'), /launchctl bootout/);
  });
});

test('running service without recoverable plist is rejected before switching', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, { running: true, existingPlist: false });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /没有可恢复的 plist/);
    assert.equal(await exists(harness.plist), false);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'running');
    assert.doesNotMatch(await readFile(harness.fakeLog, 'utf8'), /launchctl bootout/);
  });
});

test('malformed existing plist fails before any service switching', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, {
      existingPlist: true,
      running: true,
      plutilFailExisting: true,
    });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /existing plist 无法通过 plutil 校验/);
    assert.equal(await readFile(harness.plist, 'utf8'), harness.oldPlist);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'running');
    assert.doesNotMatch(await readFile(harness.fakeLog, 'utf8'), /launchctl bootout/);
  });
});

test('plutil candidate failure leaves previous plist and running service untouched', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, {
      existingPlist: true,
      running: true,
      plutilFailCandidate: true,
    });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /plist candidate 校验失败/);
    assert.equal(await readFile(harness.plist, 'utf8'), harness.oldPlist);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'running');
    assert.doesNotMatch(await readFile(harness.fakeLog, 'utf8'), /launchctl bootout/);
  });
});

test('bootout failure with service still loaded leaves previous state untouched', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, {
      existingPlist: true,
      running: true,
      bootoutFail: true,
    });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /无法停止 previous LaunchAgent/);
    assert.equal(await readFile(harness.plist, 'utf8'), harness.oldPlist);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'running');
    assert.doesNotMatch(result.stderr, /已恢复 previous plist\/LaunchAgent 状态/);
  });
});

test('activation tolerates bounded asynchronous launchd removal after bootout', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, {
      existingPlist: true,
      running: true,
      bootoutDelayQueries: 2,
    });
    const result = await runInstaller(harness);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'running');
    assert.equal(await readFile(harness.bootstrapCount, 'utf8'), '1');
    assert.match(await readFile(harness.fakeLog, 'utf8'), /launchctl bootout/);
  });
});

test('bootstrap failure restores previous plist and running LaunchAgent', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, {
      existingPlist: true,
      running: true,
      bootstrapFailOnce: true,
    });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /launchctl bootstrap 失败/);
    assert.match(result.stderr, /已恢复 previous plist\/LaunchAgent 状态/);
    assert.equal(await readFile(harness.plist, 'utf8'), harness.oldPlist);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'running');
    assert.equal(await readFile(harness.bootstrapCount, 'utf8'), '2');
  });
});

test('rollback job query error exits 70 and does not claim recovery', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, {
      existingPlist: true,
      running: true,
      bootstrapFailOnce: true,
      jobQueryErrorAfterBootstrap: true,
    });
    const result = await runInstaller(harness);
    assert.equal(result.code, 70);
    assert.match(result.stderr, /ROLLBACK FAILED/);
    assert.doesNotMatch(result.stderr, /已恢复 previous plist\/LaunchAgent 状态/);
    assert.equal(await readFile(harness.plist, 'utf8'), harness.oldPlist);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'stopped');
  });
});

test('rollback bootstrap failure exits 70 and does not claim recovery', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, {
      existingPlist: true,
      running: true,
      bootstrapFailAlways: true,
    });
    const result = await runInstaller(harness);
    assert.equal(result.code, 70);
    assert.match(result.stderr, /ROLLBACK FAILED/);
    assert.match(result.stderr, /无法重新 bootstrap previous LaunchAgent/);
    assert.doesNotMatch(result.stderr, /已恢复 previous plist\/LaunchAgent 状态/);
    assert.equal(await readFile(harness.plist, 'utf8'), harness.oldPlist);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'stopped');
  });
});

test('repeated installation is idempotent and does not restart an identical loaded job', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root);
    const first = await runInstaller(harness);
    assert.equal(first.code, 0, first.stderr);
    const firstPlist = await readFile(harness.plist, 'utf8');
    assert.equal(await readFile(harness.bootstrapCount, 'utf8'), '1');

    const second = await runInstaller(harness);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /已是目标配置/);
    assert.equal(await readFile(harness.plist, 'utf8'), firstPlist);
    assert.equal(await readFile(harness.bootstrapCount, 'utf8'), '1');
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'running');
  });
});

test('uninstall tolerates bounded asynchronous launchd removal after bootout', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root);
    const installed = await runInstaller(harness);
    assert.equal(installed.code, 0, installed.stderr);

    harness.env.FAKE_BOOTOUT_DELAY_QUERIES = '2';
    const uninstalled = await runInstaller(harness, ['--uninstall']);
    assert.equal(uninstalled.code, 0, uninstalled.stderr);
    assert.equal(await exists(harness.plist), false);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'stopped');
  });
});

test('uninstall is idempotent', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root);
    const install = await runInstaller(harness);
    assert.equal(install.code, 0, install.stderr);

    const first = await runInstaller(harness, ['--uninstall']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(await exists(harness.plist), false);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'stopped');

    const second = await runInstaller(harness, ['--uninstall']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(await exists(harness.plist), false);
    assert.equal(await readFile(harness.launchdState, 'utf8'), 'stopped');
  });
});

test('unavailable launchctl user domain fails closed before installation', async () => {
  await withTempDir(async (root) => {
    const harness = await createHarness(root, { launchdDomainAvailable: false });
    const result = await runInstaller(harness);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /launchctl 无法读取 per-user domain/);
    assert.equal(await exists(harness.plist), false);
  });
});
