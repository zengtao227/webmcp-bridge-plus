import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureNativeContainer,
  inspectNativeContainer,
  removeStaleElevatedContainer,
} from '../native/deploy/container-controller.js';
import { parseImagePin } from '../native/deploy/image-pin.js';

const IMAGE = 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SOURCE_SHA256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const CONTAINER_ID = '1'.repeat(64);

function missingContainerError() {
  const error = new Error('inspect failed');
  error.stderr = 'Error: No such object: webmcp-native';
  return error;
}

function dockerHarness() {
  let container = null;
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push([command, [...args]]);
    if (args[0] === 'image' && args[1] === 'inspect') {
      return {
        stdout: JSON.stringify([{
          Id: IMAGE,
          Config: {
            User: '65532:65532',
            Labels: { 'com.webmcp.native.source-sha256': SOURCE_SHA256 },
          },
        }]),
        stderr: '',
      };
    }
    if (args[0] === 'inspect') {
      if (!container) {
        throw missingContainerError();
      }
      return { stdout: JSON.stringify([container]), stderr: '' };
    }
    if (args[0] === 'run') {
      const labelValues = args
        .map((arg, index) => (arg === '--label' ? args[index + 1] : null))
        .filter(Boolean);
      const labels = Object.fromEntries(labelValues.map((value) => {
        const separator = value.indexOf('=');
        return [value.slice(0, separator), value.slice(separator + 1)];
      }));
      const userIndex = args.indexOf('--user');
      const mount = args.find((arg) => typeof arg === 'string' && arg.includes('dst=/workspace,bind-recursive=disabled'));
      const source = mount.match(/(?:^|,)src=([^,]+)/)[1];
      const networkIndex = args.indexOf('--network');
      container = {
        Id: CONTAINER_ID,
        Image: IMAGE,
        Config: { Labels: labels, User: args[userIndex + 1] },
        HostConfig: {
          Privileged: false,
          CapAdd: [],
          CapDrop: ['ALL'],
          Devices: [],
          SecurityOpt: ['no-new-privileges'],
          NetworkMode: networkIndex === -1 ? 'default' : args[networkIndex + 1],
        },
        State: { Running: true },
        Mounts: [{ Source: source, Destination: '/workspace', RW: true }],
      };
      return { stdout: 'container-id\n', stderr: '' };
    }
    if (args[0] === 'start') {
      container.State.Running = true;
      return { stdout: 'webmcp-native\n', stderr: '' };
    }
    if (args[0] === 'rm') {
      container = null;
      return { stdout: 'webmcp-native\n', stderr: '' };
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };
  return {
    execFileImpl,
    calls,
    get container() { return container; },
    set container(value) { container = value; },
  };
}

async function withState(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-controller-root-'));
  const state = await mkdtemp(path.join(os.tmpdir(), 'webmcp-controller-state-'));
  const configPath = path.join(state, 'workspace.json');
  const imagePinPath = path.join(state, 'image-pin.json');
  await writeFile(configPath, `${JSON.stringify({ version: 1, hostRoot: root, mode: 'workspace' })}\n`, 'utf8');
  await writeFile(imagePinPath, `${JSON.stringify({
    version: 2,
    image: IMAGE,
    sourceSha256: SOURCE_SHA256,
  })}\n`, 'utf8');
  try {
    await run({ root, state, configPath, imagePinPath });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
}

test('image pin binds an immutable image identity to a reviewed source digest', () => {
  assert.deepEqual(parseImagePin(JSON.stringify({
    version: 2,
    image: IMAGE,
    sourceSha256: SOURCE_SHA256,
  })), {
    version: 2,
    image: IMAGE,
    sourceSha256: SOURCE_SHA256,
  });
  assert.throws(() => parseImagePin(JSON.stringify({
    version: 2,
    image: 'example/webmcp:latest',
    sourceSha256: SOURCE_SHA256,
  })), /immutable sha256/);
  assert.throws(() => parseImagePin(JSON.stringify({ version: 1, image: IMAGE })), /only version, image, and sourceSha256|version must be 2/);
});

test('container controller creates only when absent and then reuses the exact reviewed policy', async () => {
  await withState(async ({ configPath, imagePinPath }) => {
    const docker = dockerHarness();
    const first = await ensureNativeContainer({
      configPath,
      imagePinPath,
      execFileImpl: docker.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    });
    assert.equal(first.action, 'created');
    assert.ok(docker.calls.some(([, args]) => args[0] === 'run'));

    const callsBefore = docker.calls.length;
    const second = await ensureNativeContainer({
      configPath,
      imagePinPath,
      execFileImpl: docker.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    });
    assert.equal(second.action, 'unchanged');
    assert.equal(docker.calls.slice(callsBefore).some(([, args]) => args[0] === 'run'), false);
  });
});

test('container controller restarts a stopped exact-policy container without recreating it', async () => {
  await withState(async ({ configPath, imagePinPath }) => {
    const docker = dockerHarness();
    await ensureNativeContainer({
      configPath,
      imagePinPath,
      execFileImpl: docker.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    });
    docker.container.State.Running = false;
    const result = await ensureNativeContainer({
      configPath,
      imagePinPath,
      execFileImpl: docker.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    });
    assert.equal(result.action, 'started');
    assert.ok(docker.calls.some(([, args]) => args[0] === 'start'));
  });
});

test('container controller fails closed on policy drift and never replaces the container', async () => {
  await withState(async ({ configPath, imagePinPath }) => {
    const docker = dockerHarness();
    await ensureNativeContainer({
      configPath,
      imagePinPath,
      execFileImpl: docker.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    });
    docker.container.Config.Labels['com.webmcp.native.policy-sha256'] = 'tampered';
    const callsBefore = docker.calls.length;
    await assert.rejects(ensureNativeContainer({
      configPath,
      imagePinPath,
      execFileImpl: docker.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    }), /policy does not match/);
    assert.equal(docker.calls.slice(callsBefore).some(([, args]) => ['run', 'rm'].includes(args[0])), false);
  });
});

test('container verifier rejects actual image and unauthorized privilege expansion', async () => {
  await withState(async ({ configPath, imagePinPath }) => {
    const cases = [
      ['actual image', (container) => { container.Image = `sha256:${'a'.repeat(64)}`; }],
      ['privileged mode', (container) => { container.HostConfig.Privileged = true; }],
      ['added capability', (container) => { container.HostConfig.CapAdd = ['SYS_ADMIN']; }],
      ['device access', (container) => { container.HostConfig.Devices = [{ PathOnHost: '/dev/null' }]; }],
    ];
    for (const [label, mutate] of cases) {
      const docker = dockerHarness();
      await ensureNativeContainer({
        configPath,
        imagePinPath,
        execFileImpl: docker.execFileImpl,
        platform: 'linux',
        hostUid: 1000,
        hostGid: 1000,
      });
      mutate(docker.container);
      await assert.rejects(ensureNativeContainer({
        configPath,
        imagePinPath,
        execFileImpl: docker.execFileImpl,
        platform: 'linux',
        hostUid: 1000,
        hostGid: 1000,
      }), undefined, label);
    }
  });
});

test('stale temporary elevated container is removed only when its hardened controller identity is still recognizable', async () => {
  await withState(async ({ root, configPath, imagePinPath }) => {
    const docker = dockerHarness();
    const leaseId = 'a'.repeat(64);
    await ensureNativeContainer({
      configPath,
      workspaceConfig: { version: 1, hostRoot: root, mode: 'advanced' },
      imagePinPath,
      elevationLeaseId: leaseId,
      execFileImpl: docker.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    });
    assert.equal(docker.container.Config.Labels['com.webmcp.native.elevated-lease'], leaseId);
    const result = await removeStaleElevatedContainer({
      imagePinPath,
      execFileImpl: docker.execFileImpl,
      hostUid: 1000,
      hostGid: 1000,
    });
    assert.equal(result.action, 'removed');
    assert.equal(result.containerId, CONTAINER_ID);
    assert.equal(docker.container, null);
    assert.ok(docker.calls.some(([, args]) => args[0] === 'rm' && args[2] === CONTAINER_ID));
    assert.ok(docker.calls.filter(([, args]) => args[0] === 'inspect').length >= 3, 'cleanup must re-inspect after removal');
  });
});

test('stale elevated cleanup requires the expected lease identity and confirmed absence', async () => {
  await withState(async ({ root, configPath, imagePinPath }) => {
    const leaseId = 'a'.repeat(64);
    const wrongLeaseId = 'b'.repeat(64);
    const mismatch = dockerHarness();
    await ensureNativeContainer({
      configPath,
      workspaceConfig: { version: 1, hostRoot: root, mode: 'advanced' },
      imagePinPath,
      elevationLeaseId: leaseId,
      execFileImpl: mismatch.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    });
    const callsBeforeMismatch = mismatch.calls.length;
    await assert.rejects(removeStaleElevatedContainer({
      imagePinPath,
      expectedLeaseId: wrongLeaseId,
      execFileImpl: mismatch.execFileImpl,
      hostUid: 1000,
      hostGid: 1000,
    }), /expected lease identity/);
    assert.equal(mismatch.calls.slice(callsBeforeMismatch).some(([, args]) => args[0] === 'rm'), false);

    const unconfirmed = dockerHarness();
    await ensureNativeContainer({
      configPath,
      workspaceConfig: { version: 1, hostRoot: root, mode: 'advanced' },
      imagePinPath,
      elevationLeaseId: leaseId,
      execFileImpl: unconfirmed.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    });
    const noRemoval = async (command, args) => {
      if (args[0] === 'rm') {
        unconfirmed.calls.push([command, [...args]]);
        return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
      }
      return unconfirmed.execFileImpl(command, args);
    };
    await assert.rejects(removeStaleElevatedContainer({
      imagePinPath,
      expectedLeaseId: leaseId,
      execFileImpl: noRemoval,
      hostUid: 1000,
      hostGid: 1000,
    }), /removal could not be confirmed/);
  });
});

test('stale elevated cleanup fails closed when hardening identity is ambiguous', async () => {
  await withState(async ({ root, configPath, imagePinPath }) => {
    const docker = dockerHarness();
    await ensureNativeContainer({
      configPath,
      workspaceConfig: { version: 1, hostRoot: root, mode: 'advanced' },
      imagePinPath,
      elevationLeaseId: 'a'.repeat(64),
      execFileImpl: docker.execFileImpl,
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    });
    docker.container.HostConfig.CapDrop = [];
    const callsBefore = docker.calls.length;
    await assert.rejects(removeStaleElevatedContainer({
      imagePinPath,
      execFileImpl: docker.execFileImpl,
      hostUid: 1000,
      hostGid: 1000,
    }), /cannot be identified safely/);
    assert.equal(docker.calls.slice(callsBefore).some(([, args]) => args[0] === 'rm'), false);
  });
});

test('container controller rejects a pinned image whose embedded reviewed-source digest mismatches the pin', async () => {
  await withState(async ({ configPath, imagePinPath }) => {
    let containerInspected = false;
    await assert.rejects(ensureNativeContainer({
      configPath,
      imagePinPath,
      execFileImpl: async (_command, args) => {
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              Id: IMAGE,
              Config: {
                User: '65532:65532',
                Labels: { 'com.webmcp.native.source-sha256': 'a'.repeat(64) },
              },
            }]),
            stderr: '',
          };
        }
        if (args[0] === 'inspect') {
          containerInspected = true;
        }
        throw new Error(`unexpected docker call: ${args.join(' ')}`);
      },
      platform: 'linux',
      hostUid: 1000,
      hostGid: 1000,
    }), /does not match the reviewed source digest/);
    assert.equal(containerInspected, false, 'container lookup must not happen after a bad image pin');
  });
});

test('inspect treats only Docker no-such-container as absent', async () => {
  assert.equal(await inspectNativeContainer({
    execFileImpl: async () => { throw missingContainerError(); },
  }), null);

  await assert.rejects(inspectNativeContainer({
    execFileImpl: async () => {
      const error = new Error('daemon unavailable');
      error.stderr = 'Cannot connect to the Docker daemon';
      throw error;
    },
  }), /Unable to inspect/);
});
