import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'extension', 'manifest.json');
const distPath = path.join(root, 'dist', 'extension');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const forbiddenPermissions = new Set([
  'debugger',
  'nativeMessaging',
]);

for (const permission of manifest.permissions ?? []) {
  if (forbiddenPermissions.has(permission)) {
    throw new Error(`Forbidden Chrome permission in manifest: ${permission}`);
  }
}

const hostPermissions = manifest.host_permissions ?? [];
if (
  hostPermissions.length !== 1 ||
  hostPermissions[0] !== 'https://chat.deepseek.com/*'
) {
  throw new Error('MVP host_permissions must contain only https://chat.deepseek.com/*');
}

for (const origin of [
  ...(manifest.host_permissions ?? []),
  ...(manifest.optional_host_permissions ?? []),
]) {
  if (origin === '<all_urls>' || origin === 'http://*/*' || origin === 'https://*/*') {
    throw new Error(`Broad host permission is forbidden in MVP baseline: ${origin}`);
  }
}

await rm(distPath, { recursive: true, force: true });
await mkdir(distPath, { recursive: true });
await cp(path.join(root, 'extension'), distPath, { recursive: true });
await mkdir(path.join(distPath, 'gateway'), { recursive: true });
await cp(path.join(root, 'gateway'), path.join(distPath, 'gateway'), { recursive: true });

console.log('Built dist/extension with manifest and Secret Firewall modules.');
