import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createHostId,
  defaultPlusControlPaths,
  ensureHostIdentity,
  loadHostIdentity,
  parseHostIdentity,
} from '../../plus/control/host-identity.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const HOST_ID = 'host_123e4567e89b42d3a456426614174000';

test('host identity is stable opaque identity and never derives from hostname', () => {
  assert.equal(createHostId({ randomUUIDImpl: () => UUID }), HOST_ID);
  assert.equal(defaultPlusControlPaths('/Users/alice').hostIdentity, '/Users/alice/.local/share/webmcp-plus/host-identity.json');
  assert.throws(
    () => createHostId({ randomUUIDImpl: () => 'macbook-pro' }),
    (error) => error?.code === 'INVALID_GENERATED_HOST_ID',
  );
});

test('host identity parser is strict and rejects hidden authority fields', () => {
  const valid = JSON.stringify({
    version: 1,
    hostId: HOST_ID,
    createdAt: '2026-09-13T12:00:00.000Z',
  });
  assert.equal(parseHostIdentity(valid).hostId, HOST_ID);

  for (const value of [
    { version: 1, hostId: HOST_ID, createdAt: '2026-09-13T12:00:00.000Z', token: 'secret' },
    { version: 1, hostId: 'macbook-pro', createdAt: '2026-09-13T12:00:00.000Z' },
    { version: 2, hostId: HOST_ID, createdAt: '2026-09-13T12:00:00.000Z' },
    { version: 1, hostId: HOST_ID, createdAt: '2026-09-13T12:00:00Z' },
  ]) {
    assert.throws(
      () => parseHostIdentity(JSON.stringify(value)),
      (error) => error?.code === 'INVALID_HOST_IDENTITY',
    );
  }
});

test('ensureHostIdentity creates once with owner-only mode and reuses the same identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-plus-host-id-'));
  const filePath = path.join(root, 'control', 'host-identity.json');
  const now = () => new Date('2026-09-13T12:00:00.000Z');

  const first = await ensureHostIdentity({ filePath, now, randomUUIDImpl: () => UUID });
  const second = await ensureHostIdentity({
    filePath,
    now: () => new Date('2030-01-01T00:00:00.000Z'),
    randomUUIDImpl: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.identity, first.identity);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await loadHostIdentity(filePath)).hostId, HOST_ID);
});

test('host identity loader rejects non-owner-only mode and unexpected ownership', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-plus-host-id-owner-'));
  const filePath = path.join(root, 'host-identity.json');
  await writeFile(filePath, JSON.stringify({
    version: 1,
    hostId: HOST_ID,
    createdAt: '2026-09-13T12:00:00.000Z',
  }), { mode: 0o600 });

  await chmod(filePath, 0o644);
  await assert.rejects(
    loadHostIdentity(filePath),
    (error) => error?.code === 'HOST_IDENTITY_UNSAFE',
  );

  await chmod(filePath, 0o600);
  const info = await stat(filePath);
  const originalGetuid = process.getuid;
  process.getuid = () => info.uid + 1;
  try {
    await assert.rejects(
      loadHostIdentity(filePath),
      (error) => error?.code === 'HOST_IDENTITY_UNSAFE',
    );
  } finally {
    process.getuid = originalGetuid;
  }
});

test('host identity loader rejects symlink substitution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webmcp-plus-host-id-link-'));
  const target = path.join(root, 'target.json');
  const link = path.join(root, 'host-identity.json');
  await writeFile(target, JSON.stringify({
    version: 1,
    hostId: HOST_ID,
    createdAt: '2026-09-13T12:00:00.000Z',
  }));
  await symlink(target, link);

  await assert.rejects(
    loadHostIdentity(link),
    (error) => error?.code === 'HOST_IDENTITY_UNSAFE',
  );
});
