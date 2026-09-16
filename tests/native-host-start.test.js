import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realEntrypoint = fileURLToPath(new URL('../native/host/start.js', import.meta.url));

test('Native host entrypoint executes through a current-style symlink instead of silently exiting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-host-start-'));
  try {
    const linkedEntrypoint = path.join(root, 'current', 'native', 'host', 'start.js');
    await mkdir(path.dirname(linkedEntrypoint), { recursive: true });
    await symlink(realEntrypoint, linkedEntrypoint);

    // A degraded boundary waits a bounded window for a request it can refuse, so
    // the caller closes stdin here instead of leaving it open for that window.
    const child = spawn(process.execPath, [linkedEntrypoint], {
      env: {
        ...process.env,
        WEBMCP_WORKSPACE_CONFIG: path.join(root, 'missing-workspace.json'),
        WEBMCP_NATIVE_IMAGE_PIN: path.join(root, 'missing-image.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdin.end();

    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 1);
    assert.match(stderr, /Native WebMCP host boundary failed:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a host boundary that cannot verify its container refuses the request instead of exiting silently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-host-start-'));
  try {
    const child = spawn(process.execPath, [realEntrypoint], {
      env: {
        ...process.env,
        WEBMCP_WORKSPACE_CONFIG: path.join(root, 'missing-workspace.json'),
        WEBMCP_NATIVE_IMAGE_PIN: path.join(root, 'missing-image.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.stdin.write('{"jsonrpc":"2.0","id":"call-1","method":"tools/call","params":{"name":"read"}}\n');

    const code = await new Promise((resolve) => child.on('close', resolve));

    assert.equal(code, 1);
    assert.match(stderr, /Native WebMCP host boundary failed:/);
    const frames = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].id, 'call-1');
    assert.equal(frames[0].error.code, -32001);
    assert.match(frames[0].error.message, /host boundary is unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
