import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildElevatedWorkspaceConfig,
  createElevatedLease,
  evaluateElevatedLease,
  getLoginSessionId,
  loadElevatedLease,
  MAX_ELEVATED_LEASE_MS,
  parseElevatedDuration,
  persistElevatedLease,
} from '../native/deploy/elevated-access.js';
import {
  applyElevatedTransition,
  applyElevationRevoke,
  assertTrustedElevationControl,
  elevatedStatusWebMcp,
  parseInstallerArgs,
  requestLocalElevationApproval,
  resolveElevationRootInput,
} from '../native/deploy/installer.js';

const BOOT_ID = 'b'.repeat(64);
const LOGIN_ID = 'd'.repeat(64);
const LEASE_ID = 'a'.repeat(64);
const NORMAL = Object.freeze({
  version: 1,
  hostRoot: '/Users/alice/Projects',
  mode: 'workspace',
  networkEnabled: true,
  gitPublicationEnabled: false,
});

function lease(overrides = {}) {
  return createElevatedLease({
    normalConfig: NORMAL,
    elevatedRoot: '/Users/alice',
    bootSessionId: BOOT_ID,
    loginSessionId: LOGIN_ID,
    leaseId: LEASE_ID,
    now: 1_000_000,
    platform: 'darwin',
    ...overrides,
  });
}

test('macOS GUI login identity is derived from one unambiguous audit session and fails closed otherwise', async () => {
  const expected = await getLoginSessionId({
    platform: 'darwin',
    uid: 501,
    execFileImpl: async (command, args) => {
      assert.equal(command, 'launchctl');
      assert.deepEqual(args, ['print', 'gui/501']);
      return { stdout: 'security context = {\n  asid = 100008\n}\nservice = { asid = 100008 }\n' };
    },
  });
  assert.match(expected, /^[0-9a-f]{64}$/);
  await assert.rejects(getLoginSessionId({
    platform: 'darwin',
    uid: 501,
    execFileImpl: async () => ({ stdout: 'asid = 100008\nasid = 100009\n' }),
  }), (error) => error?.code === 'LOGIN_SESSION_UNAVAILABLE');
});

test('temporary elevation is capped at one hour and accepts shorter owner-selected durations', () => {
  assert.equal(parseElevatedDuration('30m'), 30 * 60 * 1000);
  assert.equal(parseElevatedDuration('1h'), MAX_ELEVATED_LEASE_MS);
  assert.throws(() => parseElevatedDuration('61m'), /no longer than 1 hour/);
  assert.throws(() => parseElevatedDuration('2h'), /no longer than 1 hour/);
  assert.throws(() => parseElevatedDuration('0m'), /greater than zero/);

  const short = lease({ durationMs: 10 * 60 * 1000 });
  assert.equal(short.expiresAt - short.issuedAt, 10 * 60 * 1000);
  assert.throws(() => lease({ durationMs: MAX_ELEVATED_LEASE_MS + 1 }), /no longer than 1 hour/);
});

test('elevated scope always uses advanced mode with network and Git publication disabled', () => {
  const elevated = buildElevatedWorkspaceConfig(NORMAL, '/Users/alice', { platform: 'darwin' });
  assert.equal(elevated.hostRoot, '/Users/alice');
  assert.equal(elevated.mode, 'advanced');
  assert.equal(elevated.networkEnabled, false);
  assert.equal(elevated.gitPublicationEnabled, false);
  assert.throws(
    () => buildElevatedWorkspaceConfig(NORMAL, '/', { platform: 'darwin' }),
    /Docker Desktop does not expose the macOS root/,
  );
});

test('expired, rebooted, login-restarted and normal-config-mismatched leases fail closed', () => {
  const value = lease();
  const common = {
    normalConfig: NORMAL,
    bootSessionId: BOOT_ID,
    loginSessionId: LOGIN_ID,
    platform: 'darwin',
  };
  assert.equal(evaluateElevatedLease(value, {
    ...common,
    now: value.issuedAt + 1,
  }).state, 'active');
  assert.equal(evaluateElevatedLease(value, {
    ...common,
    now: value.expiresAt,
  }).state, 'expired');
  assert.equal(evaluateElevatedLease(value, {
    ...common,
    bootSessionId: 'c'.repeat(64),
    now: value.issuedAt + 1,
  }).state, 'rebooted');
  assert.equal(evaluateElevatedLease(value, {
    ...common,
    loginSessionId: 'e'.repeat(64),
    now: value.issuedAt + 1,
  }).state, 'login_restarted');
  assert.equal(evaluateElevatedLease(value, {
    ...common,
    normalConfig: { ...NORMAL, hostRoot: '/Users/alice/Other' },
    now: value.issuedAt + 1,
  }).state, 'config_changed');
});

test('lease state is protected and corrupted state is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-elevated-'));
  const file = path.join(root, 'elevated-lease.json');
  try {
    const initial = lease();
    await persistElevatedLease(file, initial);
    const loaded = await loadElevatedLease(file, {
      normalConfig: NORMAL,
      bootSessionId: BOOT_ID,
      loginSessionId: LOGIN_ID,
      now: initial.issuedAt + 1,
      platform: 'darwin',
    });
    assert.equal(loaded.state, 'active');

    await writeFile(file, '{broken', { mode: 0o600 });
    assert.equal((await loadElevatedLease(file, {
      normalConfig: NORMAL,
      bootSessionId: BOOT_ID,
      loginSessionId: LOGIN_ID,
      now: initial.issuedAt + 1,
      platform: 'darwin',
    })).state, 'invalid');

    await persistElevatedLease(file, initial);
    await chmod(file, 0o644);
    assert.equal((await loadElevatedLease(file, {
      normalConfig: NORMAL,
      bootSessionId: BOOT_ID,
      loginSessionId: LOGIN_ID,
      now: initial.issuedAt + 1,
      platform: 'darwin',
    })).state, 'invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('elevation status verifies runtime state and does not require GUI identity when no lease exists', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'webmcp-elevated-status-'));
  const configDir = path.join(home, '.config', 'webmcp');
  const configPath = path.join(configDir, 'workspace.json');
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(NORMAL)}\n`, 'utf8');
  try {
    let identityCalls = 0;
    const verified = await elevatedStatusWebMcp({
      home,
      execFileImpl: async () => {
        identityCalls += 1;
        throw new Error('GUI identity should not be queried');
      },
      inspectContainerStateImpl: async (options) => {
        assert.equal(options.elevationLeaseId, undefined);
        return { present: true, running: true };
      },
    });
    assert.equal(verified.mode, 'normal');
    assert.equal(verified.leaseState, 'absent');
    assert.equal(verified.runtimeState, 'running');
    assert.equal(verified.runtimeVerified, true);
    assert.equal(identityCalls, 0);

    const absent = await elevatedStatusWebMcp({
      home,
      execFileImpl: async () => { throw new Error('GUI identity should not be queried'); },
      inspectContainerStateImpl: async () => ({ present: false, running: false }),
    });
    assert.equal(absent.mode, 'unknown');
    assert.equal(absent.expectedMode, 'normal');
    assert.equal(absent.runtimeState, 'absent');

    const unverified = await elevatedStatusWebMcp({
      home,
      execFileImpl: async () => { throw new Error('GUI identity should not be queried'); },
      inspectContainerStateImpl: async () => { throw new Error('container policy drift'); },
    });
    assert.equal(unverified.mode, 'unknown');
    assert.equal(unverified.expectedMode, 'normal');
    assert.equal(unverified.runtimeState, 'unverified');
    assert.match(unverified.reason, /policy drift/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('host CLI has elevation commands but no non-interactive approval bypass', () => {
  const parsed = parseInstallerArgs(['elevate', '--root', '/Users/alice', '--duration', '30m']);
  assert.equal(parsed.command, 'elevate');
  assert.equal(parsed.options.root, '/Users/alice');
  assert.equal(parsed.options.duration, '30m');
  assert.throws(() => parseInstallerArgs(['elevate', '--yes']), /Unknown option/);
  assert.equal(parseInstallerArgs(['elevate-status']).command, 'elevate-status');
  assert.equal(parseInstallerArgs(['elevate-stop']).command, 'elevate-stop');
});

test('non-TTY elevation accepts an explicit root but never invents one', () => {
  assert.equal(resolveElevationRootInput('/Users/alice', { isTTY: false }), '/Users/alice');
  assert.equal(resolveElevationRootInput(null, { isTTY: true }), null);
  assert.throws(
    () => resolveElevationRootInput(null, { isTTY: false }),
    (error) => error?.code === 'WORKSPACE_ROOT_REQUIRED',
  );
});

test('local grant approval requires the macOS GUI dialog and cannot be replaced by a CLI yes flag', async () => {
  let call = null;
  await requestLocalElevationApproval({
    root: '/Users/alice/Documents',
    durationMs: 30 * 60 * 1000,
    execFileImpl: async (command, args, options) => {
      call = { command, args, options };
      return { stdout: 'ELEVATE\n', stderr: '' };
    },
  });
  assert.equal(call.command, '/usr/bin/osascript');
  assert.deepEqual(call.args.slice(0, 1), ['-e']);
  assert.equal(call.options.env.WEBMCP_ELEVATE_ROOT, '/Users/alice/Documents');
  assert.equal(call.options.env.WEBMCP_ELEVATE_DURATION, '30 minutes');
  assert.equal(Object.hasOwn(call.options.env, 'PATH'), false);

  await assert.rejects(requestLocalElevationApproval({
    root: '/Users/alice/Documents',
    durationMs: 30 * 60 * 1000,
    execFileImpl: async () => ({ stdout: 'CANCEL\n', stderr: '' }),
  }), (error) => error?.code === 'LOCAL_ELEVATION_APPROVAL_REQUIRED');
});

test('elevation control accepts only the verified immutable host-runtime installer path', async () => {
  const home = '/Users/alice';
  const trustedModule = '/trusted/current/native/deploy/installer.js';
  let verifiedRoot = null;
  const result = await assertTrustedElevationControl({
    home,
    modulePath: trustedModule,
    verifyHostRuntimeImpl: async (runtimeRoot) => { verifiedRoot = runtimeRoot; },
    realpathImpl: async (candidate) => {
      if (candidate === trustedModule) return '/canonical/installer.js';
      if (candidate.endsWith('/host-runtime/current/native/deploy/installer.js')) return '/canonical/installer.js';
      throw new Error(`unexpected realpath: ${candidate}`);
    },
  });
  assert.equal(verifiedRoot, '/Users/alice/.local/share/webmcp/host-runtime');
  assert.equal(result.modulePath, '/canonical/installer.js');

  await assert.rejects(assertTrustedElevationControl({
    home,
    modulePath: '/Users/alice/Projects/webmcp-bridge/native/deploy/installer.js',
    verifyHostRuntimeImpl: async () => {},
    realpathImpl: async (candidate) => candidate,
  }), (error) => error?.code === 'UNTRUSTED_ELEVATION_CONTROL_PATH');
});

test('failed elevated transition rolls back to normal mode and restarts only after normal policy is restored', async () => {
  const events = [];
  const action = (name, error = null) => async () => {
    events.push(name);
    if (error) throw error;
  };
  await assert.rejects(applyElevatedTransition({
    stopService: action('stop'),
    removeNormalContainer: action('remove-normal'),
    persistLease: action('persist-lease'),
    ensureElevatedContainer: action('ensure-elevated', new Error('elevated create failed')),
    startService: action('start'),
    clearLease: action('clear-lease'),
    removeElevatedContainer: action('remove-elevated'),
    ensureNormalContainer: action('ensure-normal'),
  }), /elevated create failed/);
  assert.deepEqual(events, [
    'stop',
    'remove-normal',
    'persist-lease',
    'ensure-elevated',
    'stop',
    'clear-lease',
    'remove-elevated',
    'ensure-normal',
    'start',
  ]);
});

test('failed post-activation verification is still inside the grant rollback transaction', async () => {
  const events = [];
  const action = (name) => async () => { events.push(name); };
  await assert.rejects(applyElevatedTransition({
    stopService: action('stop'),
    removeNormalContainer: action('remove-normal'),
    persistLease: action('persist-lease'),
    ensureElevatedContainer: action('ensure-elevated'),
    startService: action('start'),
    verifyElevated: async () => {
      events.push('verify-elevated');
      throw new Error('post-activation verification failed');
    },
    clearLease: action('clear-lease'),
    removeElevatedContainer: action('remove-elevated'),
    ensureNormalContainer: action('ensure-normal'),
  }), /post-activation verification failed/);
  assert.deepEqual(events, [
    'stop',
    'remove-normal',
    'persist-lease',
    'ensure-elevated',
    'start',
    'verify-elevated',
    'stop',
    'clear-lease',
    'remove-elevated',
    'ensure-normal',
    'start',
  ]);
});

test('failed rollback is reported as a release blocker rather than weakening the boundary', async () => {
  let starts = 0;
  await assert.rejects(applyElevatedTransition({
    stopService: async () => {},
    removeNormalContainer: async () => {},
    persistLease: async () => {},
    ensureElevatedContainer: async () => { throw new Error('create failed'); },
    startService: async () => { starts += 1; },
    clearLease: async () => {},
    removeElevatedContainer: async () => {},
    ensureNormalContainer: async () => { throw new Error('normal restore failed'); },
  }), (error) => error?.code === 'ELEVATION_ROLLBACK_FAILED');
  assert.equal(starts, 0);
});

test('failed local revoke keeps the service stopped and never restarts elevated access', async () => {
  const events = [];
  await assert.rejects(applyElevationRevoke({
    stopService: async () => { events.push('stop'); },
    clearLease: async () => { events.push('clear'); },
    removeElevatedContainer: async () => { events.push('remove'); },
    ensureNormalContainer: async () => {
      events.push('ensure-normal');
      throw new Error('normal container unavailable');
    },
    startService: async () => { events.push('start'); },
  }), (error) => error?.code === 'ELEVATION_REVOKE_FAILED');
  assert.deepEqual(events, ['stop', 'clear', 'remove', 'ensure-normal']);
});
