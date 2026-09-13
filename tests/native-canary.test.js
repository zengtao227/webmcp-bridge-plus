import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startNativeCanary, stopNativeCanary } from '../native/deploy/canary.js';

async function withCanaryFiles(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-native-canary-'));
  const client = path.join(root, 'tunnel-client');
  const key = path.join(root, 'runtime-key');
  const entrypoint = path.join(root, 'native-host');
  const profileDir = path.join(root, 'profiles');
  await writeFile(client, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(client, 0o700);
  await writeFile(key, 'fake-runtime-key', { encoding: 'utf8', mode: 0o600 });
  await writeFile(entrypoint, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(entrypoint, 0o700);
  try {
    await run({ root, client, key, entrypoint, profileDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Native canary uses a dedicated alias and the immutable Native host entrypoint', async () => {
  await withCanaryFiles(async ({ client, key, entrypoint, profileDir }) => {
    const calls = [];
    const result = await startNativeCanary({
      tunnelClient: client,
      tunnelId: `tunnel_${'a'.repeat(32)}`,
      runtimeKeyFile: key,
      runtimeEntrypoint: entrypoint,
      profileDir,
      execFileImpl: async (command, args) => {
        calls.push([command, [...args]]);
        if (args[0] === 'runtimes' && args[1] === 'status') {
          return { stdout: JSON.stringify({ process_running: true, ready: true }), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    assert.equal(result.alias, 'webmcp-native-canary');
    const connect = calls.find(([, args]) => args[0] === 'runtimes' && args[1] === 'connect');
    assert.ok(connect);
    const args = connect[1];
    const canonicalEntrypoint = await realpath(entrypoint);
    const canonicalKey = await realpath(key);
    assert.equal(args[args.indexOf('--mcp-command') + 1], canonicalEntrypoint);
    assert.equal(args[args.indexOf('--runtime-api-key') + 1], `file:${canonicalKey}`);
    assert.equal(args[args.indexOf('--alias') + 1], 'webmcp-native-canary');
  });
});

test('Native canary fails closed and stops its dedicated runtime when readiness fails', async () => {
  await withCanaryFiles(async ({ client, key, entrypoint, profileDir }) => {
    const calls = [];
    await assert.rejects(startNativeCanary({
      tunnelClient: client,
      tunnelId: `tunnel_${'b'.repeat(32)}`,
      runtimeKeyFile: key,
      runtimeEntrypoint: entrypoint,
      profileDir,
      execFileImpl: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === 'runtimes' && args[1] === 'status') {
          return { stdout: JSON.stringify({ process_running: true, ready: false }), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    }), /not both running and ready/);
    const stops = calls.filter((args) => args[0] === 'runtimes' && args[1] === 'stop');
    assert.ok(stops.length >= 2, 'canary should stop before connect and again after failed readiness');
  });
});

test('Native canary stop only accepts the dedicated canary alias namespace', async () => {
  await withCanaryFiles(async ({ client }) => {
    const calls = [];
    const result = await stopNativeCanary({
      tunnelClient: client,
      alias: 'webmcp-native-canary-review',
      execFileImpl: async (_command, args) => {
        calls.push([...args]);
        return { stdout: '', stderr: '' };
      },
    });
    assert.equal(result.stopped, true);
    assert.deepEqual(calls[0], ['runtimes', 'stop', 'webmcp-native-canary-review']);

    await assert.rejects(stopNativeCanary({
      tunnelClient: client,
      alias: 'devspace',
      execFileImpl: async () => ({ stdout: '', stderr: '' }),
    }), /alias is invalid/);
  });
});
