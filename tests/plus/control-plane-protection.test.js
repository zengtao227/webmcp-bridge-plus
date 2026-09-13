import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultProtectedPaths } from '../../native/deploy/control-plane-paths.js';

test('Plus control-plane directory is created owner-only and always protected from broad workspace mounts', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'webmcp-plus-home-'));
  const configPath = path.join(home, '.config', 'webmcp', 'workspace.json');
  const plusControl = path.join(home, '.local', 'share', 'webmcp-plus');

  const protectedPaths = await defaultProtectedPaths({ home, configPath, platform: 'darwin' });

  assert.ok(protectedPaths.includes(plusControl));
  assert.equal((await stat(plusControl)).mode & 0o777, 0o700);
});
