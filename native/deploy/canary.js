#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_ALIAS = 'webmcp-native-canary';
const DEFAULT_PROFILE = 'webmcp-native-canary';

export class NativeCanaryError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'NativeCanaryError';
    this.code = code;
  }
}

function fail(message, code, options = {}) {
  throw new NativeCanaryError(message, code, options);
}

function assertToken(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${label} is invalid.`, 'INVALID_CANARY_OPTIONS');
  }
  return value;
}

async function assertRegularFile(filePath, label, { executable = false } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    fail(`${label} must be an absolute path.`, 'INVALID_CANARY_OPTIONS');
  }
  try {
    const canonical = await realpath(filePath);
    const info = await lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink()) {
      fail(`${label} must resolve to a regular file.`, 'CANARY_FILE_UNAVAILABLE');
    }
    await access(canonical, executable ? fsConstants.X_OK : fsConstants.R_OK);
    return canonical;
  } catch (error) {
    if (error instanceof NativeCanaryError) throw error;
    fail(`${label} is unavailable.`, 'CANARY_FILE_UNAVAILABLE', { cause: error });
  }
}

function parseStatus(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    fail('tunnel-client returned invalid canary status JSON.', 'INVALID_CANARY_STATUS', { cause: error });
  }
  if (parsed?.process_running !== true || parsed?.ready !== true) {
    fail('Native canary runtime is not both running and ready.', 'CANARY_NOT_READY');
  }
  return parsed;
}

export async function startNativeCanary({
  tunnelClient,
  tunnelId,
  runtimeKeyFile,
  runtimeEntrypoint,
  profileDir,
  alias = DEFAULT_ALIAS,
  profile = DEFAULT_PROFILE,
  execFileImpl = execFileAsync,
} = {}) {
  const client = await assertRegularFile(tunnelClient, 'tunnel-client', { executable: true });
  const keyFile = await assertRegularFile(runtimeKeyFile, 'Runtime API key file');
  const entrypoint = await assertRegularFile(runtimeEntrypoint, 'Native host entrypoint', { executable: true });
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) {
    fail('profileDir must be an absolute path.', 'INVALID_CANARY_OPTIONS');
  }
  assertToken(tunnelId, 'tunnelId', /^tunnel_[0-9a-f]{32}$/);
  assertToken(alias, 'alias', /^webmcp-native-canary(?:-[a-z0-9][a-z0-9-]{0,31})?$/);
  assertToken(profile, 'profile', /^[a-z0-9][a-z0-9_-]{0,63}$/);

  await execFileImpl(client, ['runtimes', 'stop', alias], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }).catch(() => {});

  try {
    await execFileImpl(client, [
      'runtimes', 'connect',
      '--alias', alias,
      '--profile', profile,
      '--profile-dir', profileDir,
      '--tunnel-id', tunnelId,
      '--runtime-api-key', `file:${keyFile}`,
      '--mcp-command', entrypoint,
    ], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });

    const { stdout } = await execFileImpl(client, ['runtimes', 'status', alias, '--json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const status = parseStatus(stdout);
    return Object.freeze({ alias, profile, status });
  } catch (error) {
    await execFileImpl(client, ['runtimes', 'stop', alias], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).catch(() => {});
    if (error instanceof NativeCanaryError) throw error;
    fail('Unable to start the Native Secure MCP Tunnel canary.', 'CANARY_START_FAILED', { cause: error });
  }
}

export async function stopNativeCanary({
  tunnelClient,
  alias = DEFAULT_ALIAS,
  execFileImpl = execFileAsync,
} = {}) {
  const client = await assertRegularFile(tunnelClient, 'tunnel-client', { executable: true });
  assertToken(alias, 'alias', /^webmcp-native-canary(?:-[a-z0-9][a-z0-9-]{0,31})?$/);
  await execFileImpl(client, ['runtimes', 'stop', alias], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return Object.freeze({ alias, stopped: true });
}

function parseArgs(argv) {
  const options = { alias: DEFAULT_ALIAS, profile: DEFAULT_PROFILE, stop: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stop') {
      options.stop = true;
      continue;
    }
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}.`);
      return argv[index];
    };
    if (arg === '--tunnel-client') options.tunnelClient = path.resolve(next());
    else if (arg === '--tunnel-id') options.tunnelId = next();
    else if (arg === '--runtime-key-file') options.runtimeKeyFile = path.resolve(next());
    else if (arg === '--runtime-entrypoint') options.runtimeEntrypoint = path.resolve(next());
    else if (arg === '--profile-dir') options.profileDir = path.resolve(next());
    else if (arg === '--alias') options.alias = next();
    else if (arg === '--profile') options.profile = next();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.tunnelClient) throw new Error('--tunnel-client is required.');
  if (options.stop) return options;
  for (const [field, flag] of [
    ['tunnelId', '--tunnel-id'],
    ['runtimeKeyFile', '--runtime-key-file'],
    ['runtimeEntrypoint', '--runtime-entrypoint'],
    ['profileDir', '--profile-dir'],
  ]) {
    if (!options[field]) throw new Error(`${flag} is required.`);
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.stop
      ? await stopNativeCanary(options)
      : await startNativeCanary(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Native canary failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (isMain) {
  await main();
}
