import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_IDENTITY_BYTES = 4096;
const HOST_ID_PATTERN = /^host_[0-9a-f]{32}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class HostIdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HostIdentityError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new HostIdentityError(message, code);
}

export function defaultPlusControlPaths(home = os.homedir()) {
  const root = path.join(home, '.local', 'share', 'webmcp-plus');
  return Object.freeze({
    root,
    hostIdentity: path.join(root, 'host-identity.json'),
    hostRegistry: path.join(root, 'host-registry.json'),
  });
}

export function createHostId({ randomUUIDImpl = randomUUID } = {}) {
  const value = randomUUIDImpl().toLowerCase();
  if (!UUID_V4_PATTERN.test(value)) {
    fail('Host identity generator returned an invalid UUID v4.', 'INVALID_GENERATED_HOST_ID');
  }
  return `host_${value.replaceAll('-', '')}`;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) {
    fail('Host identity createdAt must be a bounded ISO timestamp.', 'INVALID_HOST_IDENTITY');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('Host identity createdAt must be canonical ISO-8601 UTC.', 'INVALID_HOST_IDENTITY');
  }
  return value;
}

export function parseHostIdentity(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_IDENTITY_BYTES) {
    fail('Host identity must be bounded UTF-8 JSON.', 'INVALID_HOST_IDENTITY');
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('Host identity must be valid JSON.', 'INVALID_HOST_IDENTITY');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Host identity must be a JSON object.', 'INVALID_HOST_IDENTITY');
  }
  if (Object.keys(value).sort().join(',') !== 'createdAt,hostId,version') {
    fail('Host identity contains unsupported fields.', 'INVALID_HOST_IDENTITY');
  }
  if (value.version !== 1 || !HOST_ID_PATTERN.test(value.hostId)) {
    fail('Host identity has an unsupported version or hostId.', 'INVALID_HOST_IDENTITY');
  }

  return Object.freeze({
    version: 1,
    hostId: value.hostId,
    createdAt: canonicalTimestamp(value.createdAt),
  });
}

export function formatHostIdentity(identity) {
  const parsed = parseHostIdentity(JSON.stringify(identity));
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export async function loadHostIdentity(filePath) {
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!Number.isInteger(expectedUid) || expectedUid < 0) {
    fail('Host identity expected owner is unavailable.', 'HOST_IDENTITY_UNSAFE');
  }
  let info;
  let text;
  try {
    info = await lstat(filePath);
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.uid !== expectedUid
      || (info.mode & 0o777) !== 0o600
    ) {
      fail('Host identity must be a current-owner mode-0600 regular non-symlink file.', 'HOST_IDENTITY_UNSAFE');
    }
    if (info.size > MAX_IDENTITY_BYTES) {
      fail('Host identity is too large.', 'INVALID_HOST_IDENTITY');
    }
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof HostIdentityError) throw error;
    if (error?.code === 'ENOENT') return null;
    fail('Unable to read host identity.', 'HOST_IDENTITY_UNAVAILABLE');
  }
  return parseHostIdentity(text);
}

export async function ensureHostIdentity({
  filePath = defaultPlusControlPaths().hostIdentity,
  now = () => new Date(),
  randomUUIDImpl = randomUUID,
} = {}) {
  const existing = await loadHostIdentity(filePath);
  if (existing) return Object.freeze({ created: false, identity: existing });

  const identity = Object.freeze({
    version: 1,
    hostId: createHostId({ randomUUIDImpl }),
    createdAt: now().toISOString(),
  });
  const content = formatHostIdentity(identity);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const tempPath = `${filePath}.${createHostId({ randomUUIDImpl }).slice(5)}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await link(tempPath, filePath);
    await chmod(filePath, 0o600);
    return Object.freeze({ created: true, identity });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const raced = await loadHostIdentity(filePath);
      if (raced) return Object.freeze({ created: false, identity: raced });
    }
    throw error;
  } finally {
    await unlink(tempPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}
