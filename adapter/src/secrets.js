import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class SecretRefError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SecretRefError';
    this.code = code;
  }
}

function normalizeResolved(value, code) {
  if (typeof value !== 'string') {
    throw new SecretRefError('Secret reference did not resolve to a string.', code);
  }
  const secret = value.trim();
  if (secret.length === 0) {
    throw new SecretRefError('Secret reference resolved to an empty value.', code);
  }
  return secret;
}

async function resolveFromKeychain(service, execImpl) {
  if (process.platform !== 'darwin') {
    throw new SecretRefError('keychain: references require macOS.', 'KEYCHAIN_UNSUPPORTED');
  }
  // -w prints only the password, so the service name never appears in output.
  const { stdout } = await execImpl('security', ['find-generic-password', '-w', '-s', service]);
  return normalizeResolved(stdout, 'SECRET_REF_MISSING');
}

export async function resolveSecretRef(ref, { env = process.env, execImpl = execFileAsync } = {}) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 4096) {
    throw new SecretRefError('Secret reference is invalid.', 'INVALID_SECRET_REF');
  }

  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const value = env[name];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SecretRefError(`Environment secret ${name} is not set.`, 'SECRET_REF_MISSING');
    }
    return normalizeResolved(value, 'SECRET_REF_MISSING');
  }

  if (ref.startsWith('file:')) {
    const target = ref.slice(5);
    if (!target.startsWith('/')) {
      throw new SecretRefError('file: secret references must use an absolute path.', 'INVALID_SECRET_REF');
    }
    let contents;
    try {
      contents = await readFile(target, 'utf8');
    } catch (error) {
      throw new SecretRefError('Secret file could not be read.', 'SECRET_REF_MISSING', { cause: error });
    }
    return normalizeResolved(contents, 'SECRET_REF_MISSING');
  }

  if (ref.startsWith('keychain:')) {
    const service = ref.slice(9);
    if (service.length === 0) {
      throw new SecretRefError('keychain: secret references require a service name.', 'INVALID_SECRET_REF');
    }
    return resolveFromKeychain(service, execImpl);
  }

  throw new SecretRefError(
    'Secret reference must use env:<NAME>, file:<absolute-path> or keychain:<service>.',
    'UNSUPPORTED_SECRET_REF',
  );
}
