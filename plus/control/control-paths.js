import os from 'node:os';
import path from 'node:path';

export function defaultPlusControlPaths(home = os.homedir()) {
  const root = path.join(home, '.local', 'share', 'webmcp-plus');
  return Object.freeze({
    root,
    hostRegistry: path.join(root, 'host-registry.json'),
  });
}
