import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const realEntrypoint = fileURLToPath(new URL('../native/host/start.js', import.meta.url));

test('Native host entrypoint executes through a current-style symlink instead of silently exiting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-host-start-'));
  try {
    const linkedEntrypoint = path.join(root, 'current', 'native', 'host', 'start.js');
    await mkdir(path.dirname(linkedEntrypoint), { recursive: true });
    await symlink(realEntrypoint, linkedEntrypoint);

    await assert.rejects(
      execFileAsync(process.execPath, [linkedEntrypoint], {
        env: {
          ...process.env,
          WEBMCP_WORKSPACE_CONFIG: path.join(root, 'missing-workspace.json'),
          WEBMCP_NATIVE_IMAGE_PIN: path.join(root, 'missing-image.json'),
        },
        encoding: 'utf8',
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Native WebMCP host boundary failed:/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
