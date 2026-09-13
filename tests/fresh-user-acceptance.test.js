import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FreshUserAcceptanceError,
  parseFreshUserAcceptanceArgs,
  runFreshUserAcceptance,
} from '../scripts/fresh-user-acceptance.mjs';

test('fresh-user acceptance parser requires only the owner inputs needed by the Base installer', () => {
  const parsed = parseFreshUserAcceptanceArgs([
    '--root', '/Users/alice/Projects',
    '--tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef',
    '--runtime-key-file', '/Users/alice/.keys/webmcp',
    '--tunnel-client', '/usr/local/bin/tunnel-client',
  ]);

  assert.deepEqual(parsed, {
    help: false,
    root: '/Users/alice/Projects',
    tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
    runtimeKeyFile: '/Users/alice/.keys/webmcp',
    tunnelClient: '/usr/local/bin/tunnel-client',
  });
  assert.equal(parseFreshUserAcceptanceArgs(['--help']).help, true);
  assert.throws(
    () => parseFreshUserAcceptanceArgs(['--root', '/Users/alice/Projects']),
    /requires --tunnel-id/,
  );
  assert.throws(
    () => parseFreshUserAcceptanceArgs(['--root', '/x', '--tunnel-id', 't', '--runtime-key-file', '/k', '--yes']),
    /Unknown option/,
  );
});

test('fresh-user acceptance refuses non-macOS execution before any installer call', async () => {
  let calls = 0;
  await assert.rejects(
    runFreshUserAcceptance({
      root: '/Users/alice/Projects',
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      runtimeKeyFile: '/Users/alice/.keys/webmcp',
      platform: 'linux',
      execFileImpl: async () => {
        calls += 1;
        return { stdout: '', stderr: '' };
      },
      realpathImpl: async (value) => value,
    }),
    (error) => error instanceof FreshUserAcceptanceError && error.code === 'UNSUPPORTED_PLATFORM',
  );
  assert.equal(calls, 0);
});

test('fresh-user acceptance refuses any non-fresh installation and performs no mutation', async () => {
  const calls = [];
  await assert.rejects(
    runFreshUserAcceptance({
      root: '/Users/alice/Projects',
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      runtimeKeyFile: '/Users/alice/.keys/webmcp',
      platform: 'darwin',
      repoRoot: '/repo',
      nodeBin: '/usr/bin/node',
      realpathImpl: async (value) => value,
      execFileImpl: async (file, args) => {
        calls.push([file, args]);
        return { stdout: '{"state":"installed","root":"/Users/alice/Projects"}\n', stderr: '' };
      },
    }),
    (error) => error instanceof FreshUserAcceptanceError && error.code === 'NOT_FRESH_INSTALLATION',
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['/usr/bin/node', ['/repo/native/deploy/installer.js', 'status']]);
});

test('fresh-user acceptance delegates exact install/doctor/status sequence to the Base installer', async () => {
  const calls = [];
  const responses = [
    { stdout: '{"state":"fresh"}\n', stderr: '' },
    { stdout: '{"action":"installed","root":"/Users/alice/Projects"}\nNext owner action: connect the WebMCP App in ChatGPT.\n', stderr: '' },
    { stdout: '{"state":"installed","root":"/Users/alice/Projects","mode":"workspace","tunnelReady":true,"containerRunning":true,"hostArtifactId":"artifact-1"}\n', stderr: '' },
    { stdout: '{"state":"installed","root":"/Users/alice/Projects","mode":"workspace","containerRunning":true,"launchAgentLoaded":true,"tunnelReady":true,"hostArtifactId":"artifact-1"}\n', stderr: '' },
  ];

  const result = await runFreshUserAcceptance({
    root: '/Users/alice/Projects',
    tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
    runtimeKeyFile: '/Users/alice/.keys/webmcp',
    tunnelClient: '/opt/webmcp/tunnel-client',
    platform: 'darwin',
    repoRoot: '/repo',
    nodeBin: '/usr/bin/node',
    realpathImpl: async (value) => value,
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return responses.shift();
    },
  });

  assert.deepEqual(calls.map((call) => call.args), [
    ['/repo/native/deploy/installer.js', 'status'],
    [
      '/repo/native/deploy/installer.js',
      'install',
      '--root', '/Users/alice/Projects',
      '--tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef',
      '--runtime-key-file', '/Users/alice/.keys/webmcp',
      '--tunnel-client', '/opt/webmcp/tunnel-client',
    ],
    ['/repo/native/deploy/installer.js', 'doctor'],
    ['/repo/native/deploy/installer.js', 'status'],
  ]);
  assert.equal(calls.some((call) => call.args.includes('uninstall')), false);
  assert.equal(result.state, 'local-acceptance-passed');
  assert.equal(result.root, '/Users/alice/Projects');
  assert.equal(result.tunnelReady, true);
  assert.match(result.nextOwnerAction, /open_workspace\("\/workspace"\)/);
});

test('fresh-user acceptance fails if doctor or final status is not healthy', async () => {
  const doctorResponses = [
    { stdout: '{"state":"fresh"}\n', stderr: '' },
    { stdout: '{"action":"installed"}\nNext owner action: connect the WebMCP App in ChatGPT.\n', stderr: '' },
    { stdout: '{"state":"installed","root":"/Users/alice/Projects","mode":"workspace","tunnelReady":false,"containerRunning":true,"hostArtifactId":"artifact-1"}\n', stderr: '' },
  ];

  await assert.rejects(
    runFreshUserAcceptance({
      root: '/Users/alice/Projects',
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      runtimeKeyFile: '/Users/alice/.keys/webmcp',
      platform: 'darwin',
      repoRoot: '/repo',
      nodeBin: '/usr/bin/node',
      realpathImpl: async (value) => value,
      execFileImpl: async () => doctorResponses.shift(),
    }),
    (error) => error instanceof FreshUserAcceptanceError && error.code === 'DOCTOR_NOT_HEALTHY',
  );
});
