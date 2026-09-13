import { lstat, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_WORKSPACE_CONFIG } from './workspace-config.js';

async function existing(paths) {
  const result = [];
  for (const candidate of paths) {
    try {
      await lstat(candidate);
      result.push(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return result;
}

export async function defaultProtectedPaths({
  home = os.homedir(),
  configPath = DEFAULT_WORKSPACE_CONFIG,
  platform = process.platform,
} = {}) {
  const configDirectory = path.dirname(configPath);
  const plusControlDirectory = path.join(home, '.local', 'share', 'webmcp-plus');
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(plusControlDirectory, { recursive: true, mode: 0o700 });

  const candidates = [
    configDirectory,
    path.join(home, 'Doc', 'devspace-container'),
    path.join(home, '.config', 'tunnel-client'),
    path.join(home, '.local', 'share', 'webmcp'),
    plusControlDirectory,
  ];
  if (platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'tunnel-client'),
      path.join(home, 'Library', 'LaunchAgents', 'com.webmcp.devspace-tunnel.plist'),
      path.join(home, 'Library', 'LaunchAgents', 'com.webmcp.devspace-recovery.plist'),
      path.join(home, 'Library', 'LaunchAgents', 'com.webmcp.native-tunnel.plist'),
      path.join(home, 'Library', 'LaunchAgents', 'com.webmcp.native-recovery.plist'),
    );
  }
  return existing([...new Set(candidates.map((candidate) => path.resolve(candidate)))]);
}
