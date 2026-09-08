import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'),
);

test('manifest keeps the MVP permission baseline narrow', () => {
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://chat.deepseek.com/*']);
  assert.equal('optional_host_permissions' in manifest, false);
});

test('manifest injects only on DeepSeek with separate MAIN and ISOLATED worlds', () => {
  assert.equal(manifest.content_scripts.length, 2);
  assert.deepEqual(
    manifest.content_scripts.map(({ matches, run_at: runAt, world }) => ({ matches, runAt, world })),
    [
      {
        matches: ['https://chat.deepseek.com/*'],
        runAt: 'document_start',
        world: 'MAIN',
      },
      {
        matches: ['https://chat.deepseek.com/*'],
        runAt: 'document_start',
        world: 'ISOLATED',
      },
    ],
  );
  assert.deepEqual(manifest.background, {
    service_worker: 'background.js',
    type: 'module',
  });
});

test('manifest does not contain prohibited powers or broad origins', () => {
  const allPermissions = [
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
  ];
  const allOrigins = [
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
  ];

  assert.equal(allPermissions.includes('nativeMessaging'), false);
  assert.equal(allPermissions.includes('debugger'), false);
  assert.equal(allOrigins.includes('<all_urls>'), false);
  assert.equal(allOrigins.includes('http://*/*'), false);
  assert.equal(allOrigins.includes('https://*/*'), false);
});
