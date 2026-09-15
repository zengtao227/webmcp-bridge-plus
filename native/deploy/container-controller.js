#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  buildNativeContainerRun,
  NATIVE_CONTAINER_NAME,
  NATIVE_ELEVATED_LEASE_LABEL,
  NATIVE_GIT_KEY_PATH,
  NATIVE_GIT_KNOWN_HOSTS_PATH,
} from './container-policy.js';
import { defaultProtectedPaths } from './control-plane-paths.js';
import { loadImagePin } from './image-pin.js';
import { DEFAULT_WORKSPACE_CONFIG, loadWorkspaceConfig, normalizeWorkspaceConfig } from './workspace-config.js';

const execFileAsync = promisify(execFile);
export class ContainerControllerError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ContainerControllerError';
    this.code = code;
  }
}

function fail(message, code, options = {}) {
  throw new ContainerControllerError(message, code, options);
}

export async function inspectNativeImage(imagePin, { dockerBin = 'docker', execFileImpl = execFileAsync } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileImpl(dockerBin, ['image', 'inspect', imagePin.image], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    fail('Unable to inspect the pinned Native image.', 'NATIVE_IMAGE_UNAVAILABLE', { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    fail('Docker image inspect returned invalid JSON.', 'INVALID_IMAGE_INSPECT', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
    fail('Docker image inspect returned an unexpected payload.', 'INVALID_IMAGE_INSPECT');
  }
  if (String(parsed[0].Id ?? '').toLowerCase() !== imagePin.image.toLowerCase()) {
    fail('Docker resolved the Native image pin to a different image ID.', 'NATIVE_IMAGE_ID_MISMATCH');
  }
  const sourceLabel = parsed[0]?.Config?.Labels?.['com.webmcp.native.source-sha256'];
  if (sourceLabel !== imagePin.sourceSha256) {
    fail('Pinned Native image does not match the reviewed source digest.', 'NATIVE_IMAGE_SOURCE_MISMATCH');
  }
  return parsed[0];
}

export async function inspectNativeContainer({ dockerBin = 'docker', execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl(dockerBin, ['inspect', NATIVE_CONTAINER_NAME], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
      fail('Docker inspect returned an unexpected container payload.', 'INVALID_CONTAINER_INSPECT');
    }
    return parsed[0];
  } catch (error) {
    if (error instanceof ContainerControllerError) {
      throw error;
    }
    const stderr = String(error?.stderr ?? '');
    if (/No such (?:object|container)/i.test(stderr)) {
      return null;
    }
    if (error instanceof SyntaxError) {
      fail('Docker inspect returned invalid JSON.', 'INVALID_CONTAINER_INSPECT', { cause: error });
    }
    fail('Unable to inspect the Native container.', 'DOCKER_INSPECT_FAILED', { cause: error });
  }
}

export function verifyContainer(container, expected) {
  const labels = container?.Config?.Labels ?? {};
  if (labels['com.webmcp.native.policy-sha256'] !== expected.policyDigest) {
    fail('Existing Native container policy does not match the reviewed configuration.', 'CONTAINER_POLICY_MISMATCH');
  }
  if (labels['com.webmcp.native.image'] !== expected.image) {
    fail('Existing Native container image label does not match the reviewed image.', 'CONTAINER_IMAGE_MISMATCH');
  }
  if (String(container?.Image ?? '').toLowerCase() !== expected.image.toLowerCase()) {
    fail('Existing Native container actual image does not match the reviewed image.', 'CONTAINER_IMAGE_MISMATCH');
  }
  const elevatedLeaseId = labels[NATIVE_ELEVATED_LEASE_LABEL] ?? null;
  if (elevatedLeaseId !== expected.elevationLeaseId) {
    fail('Existing Native container elevation state does not match the authorized lease.', 'CONTAINER_ELEVATION_MISMATCH');
  }
  const expectedUser = `${expected.hostUid}:${expected.hostGid}`;
  if (container?.Config?.User !== expectedUser) {
    fail('Existing Native container runtime identity does not match the host owner.', 'CONTAINER_IDENTITY_MISMATCH');
  }
  if (container?.HostConfig?.Privileged === true) {
    fail('Existing Native container is unexpectedly privileged.', 'CONTAINER_HARDENING_MISMATCH');
  }
  const capAdd = container?.HostConfig?.CapAdd ?? [];
  if (!Array.isArray(capAdd) || capAdd.length > 0) {
    fail('Existing Native container has unauthorized added capabilities.', 'CONTAINER_HARDENING_MISMATCH');
  }
  const devices = container?.HostConfig?.Devices ?? [];
  if (!Array.isArray(devices) || devices.length > 0) {
    fail('Existing Native container has unauthorized device access.', 'CONTAINER_HARDENING_MISMATCH');
  }
  const capDrop = container?.HostConfig?.CapDrop ?? [];
  if (!Array.isArray(capDrop) || !capDrop.some((value) => String(value).toUpperCase() === 'ALL')) {
    fail('Existing Native container is missing the required capability drop.', 'CONTAINER_HARDENING_MISMATCH');
  }
  const securityOpt = container?.HostConfig?.SecurityOpt ?? [];
  if (!Array.isArray(securityOpt) || !securityOpt.some((value) => String(value).startsWith('no-new-privileges'))) {
    fail('Existing Native container is missing no-new-privileges.', 'CONTAINER_HARDENING_MISMATCH');
  }
  const networkMode = container?.HostConfig?.NetworkMode;
  if (expected.networkEnabled === false && networkMode !== 'none') {
    fail('Existing Native container network policy does not match the reviewed configuration.', 'CONTAINER_NETWORK_MISMATCH');
  }
  if (expected.networkEnabled === true && !['default', 'bridge'].includes(networkMode)) {
    fail('Existing Native container network policy does not match the reviewed configuration.', 'CONTAINER_NETWORK_MISMATCH');
  }
  const mounts = Array.isArray(container?.Mounts) ? container.Mounts : [];
  const workspaceMount = mounts.find((mount) => mount?.Destination === '/workspace');
  if (
    !workspaceMount
    || workspaceMount.Type !== 'bind'
    || path.resolve(workspaceMount.Source ?? '') !== expected.canonicalRoot
    || workspaceMount.RW !== true
  ) {
    fail('Existing Native container workspace mount does not match the selected writable host root.', 'CONTAINER_WORKSPACE_MISMATCH');
  }

  for (const mask of expected.maskPlan) {
    const mount = mounts.find((candidate) => candidate?.Destination === mask.destination);
    const valid = mask.type === 'file'
      ? mount?.Type === 'bind' && path.resolve(mount?.Source ?? '') === '/dev/null' && mount?.RW === false
      : mount?.Type === 'tmpfs' && mount?.RW === false;
    if (!valid) {
      fail('Existing Native container control-plane mask does not match the reviewed configuration.', 'CONTAINER_MASK_MISMATCH');
    }
  }

  for (const [destination, expectedSource] of [
    [NATIVE_GIT_KEY_PATH, expected.gitCredentialSource],
    [NATIVE_GIT_KNOWN_HOSTS_PATH, expected.gitKnownHostsSource],
  ]) {
    const mount = mounts.find((candidate) => candidate?.Destination === destination);
    if (expectedSource === null) {
      if (mount) {
        fail('Existing Native container exposes an unauthorized Git secret mount.', 'CONTAINER_GIT_MOUNT_MISMATCH');
      }
      continue;
    }
    if (mount?.Type !== 'bind' || path.resolve(mount.Source ?? '') !== expectedSource || mount.RW !== false) {
      fail('Existing Native container Git secret mount does not match the reviewed configuration.', 'CONTAINER_GIT_MOUNT_MISMATCH');
    }
  }

  const allowedDestinations = new Set([
    '/workspace',
    ...expected.maskPlan.map((mask) => mask.destination),
    ...(expected.gitCredentialSource === null ? [] : [NATIVE_GIT_KEY_PATH]),
    ...(expected.gitKnownHostsSource === null ? [] : [NATIVE_GIT_KNOWN_HOSTS_PATH]),
  ]);
  if (mounts.length !== allowedDestinations.size || mounts.some((mount) => !allowedDestinations.has(mount?.Destination))) {
    fail('Existing Native container has an unauthorized mount.', 'CONTAINER_MOUNT_MISMATCH');
  }
}

async function resolveNativeContainerPolicy({
  configPath = DEFAULT_WORKSPACE_CONFIG,
  workspaceConfig = null,
  imagePinPath,
  gitCredentialPath = null,
  gitKnownHostsPath = null,
  protectedPaths = null,
  elevationLeaseId = null,
  dockerBin = 'docker',
  execFileImpl = execFileAsync,
  platform = process.platform,
  hostUid = typeof process.getuid === 'function' ? process.getuid() : null,
  hostGid = typeof process.getgid === 'function' ? process.getgid() : null,
} = {}) {
  if (typeof imagePinPath !== 'string' || !path.isAbsolute(imagePinPath)) {
    fail('imagePinPath must be an absolute host path.', 'IMAGE_PIN_REQUIRED');
  }

  const [config, imagePin] = await Promise.all([
    workspaceConfig === null
      ? loadWorkspaceConfig(configPath, { platform })
      : Promise.resolve(normalizeWorkspaceConfig(workspaceConfig, { platform })),
    loadImagePin(imagePinPath),
  ]);
  await inspectNativeImage(imagePin, { dockerBin, execFileImpl });
  const defaults = await defaultProtectedPaths({ configPath, platform });
  const effectiveProtected = [...new Set([...(protectedPaths ?? []), ...defaults, imagePinPath])];
  const policy = await buildNativeContainerRun({
    config,
    image: imagePin.image,
    protectedPaths: effectiveProtected,
    gitCredentialPath,
    gitKnownHostsPath,
    elevationLeaseId,
    platform,
    hostUid,
    hostGid,
  });
  const expected = Object.freeze({
    image: imagePin.image,
    policyDigest: policy.policyDigest,
    canonicalRoot: policy.canonicalRoot,
    hostUid,
    hostGid,
    networkEnabled: policy.config.networkEnabled,
    gitCredentialSource: policy.gitCredentialSource,
    gitKnownHostsSource: policy.gitKnownHostsSource,
    maskPlan: policy.maskPlan,
    elevationLeaseId: policy.elevationLeaseId,
  });
  return Object.freeze({ config, imagePin, policy, expected });
}

export async function inspectNativeContainerState(options = {}) {
  const resolved = await resolveNativeContainerPolicy(options);
  const container = await inspectNativeContainer(options);
  if (!container) {
    return Object.freeze({
      present: false,
      running: false,
      policyDigest: resolved.policy.policyDigest,
      canonicalRoot: resolved.policy.canonicalRoot,
      elevationLeaseId: resolved.expected.elevationLeaseId,
    });
  }
  verifyContainer(container, resolved.expected);
  return Object.freeze({
    present: true,
    running: container?.State?.Running === true,
    policyDigest: resolved.policy.policyDigest,
    canonicalRoot: resolved.policy.canonicalRoot,
    elevationLeaseId: resolved.expected.elevationLeaseId,
  });
}

export async function removeNativeContainer(options = {}) {
  const resolved = await resolveNativeContainerPolicy(options);
  const {
    dockerBin = 'docker',
    execFileImpl = execFileAsync,
  } = options;
  const container = await inspectNativeContainer({ dockerBin, execFileImpl });
  if (!container) {
    return Object.freeze({ action: 'absent' });
  }
  verifyContainer(container, resolved.expected);
  try {
    await execFileImpl(dockerBin, ['rm', '-f', NATIVE_CONTAINER_NAME], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    fail('Unable to remove the verified Native container.', 'CONTAINER_REMOVE_FAILED', { cause: error });
  }
  return Object.freeze({ action: 'removed' });
}

export async function removeStaleElevatedContainer({
  imagePinPath,
  expectedLeaseId = null,
  dockerBin = 'docker',
  execFileImpl = execFileAsync,
  hostUid = typeof process.getuid === 'function' ? process.getuid() : null,
  hostGid = typeof process.getgid === 'function' ? process.getgid() : null,
} = {}) {
  if (typeof imagePinPath !== 'string' || !path.isAbsolute(imagePinPath)) {
    fail('imagePinPath must be an absolute host path.', 'IMAGE_PIN_REQUIRED');
  }
  const imagePin = await loadImagePin(imagePinPath);
  await inspectNativeImage(imagePin, { dockerBin, execFileImpl });
  const container = await inspectNativeContainer({ dockerBin, execFileImpl });
  if (!container) {
    return Object.freeze({ action: 'absent' });
  }
  const labels = container?.Config?.Labels ?? {};
  const leaseId = labels[NATIVE_ELEVATED_LEASE_LABEL] ?? null;
  if (expectedLeaseId !== null && leaseId !== expectedLeaseId) {
    fail('Elevated Native container does not match the expected lease identity.', 'ELEVATED_CONTAINER_UNVERIFIED');
  }
  if (leaseId === null) {
    return Object.freeze({ action: 'normal' });
  }
  const expectedUser = `${hostUid}:${hostGid}`;
  const capDrop = container?.HostConfig?.CapDrop ?? [];
  const securityOpt = container?.HostConfig?.SecurityOpt ?? [];
  const workspaceMount = Array.isArray(container?.Mounts)
    ? container.Mounts.find((mount) => mount?.Destination === '/workspace')
    : null;
  const gitMount = Array.isArray(container?.Mounts)
    ? container.Mounts.find((mount) => [NATIVE_GIT_KEY_PATH, NATIVE_GIT_KNOWN_HOSTS_PATH].includes(mount?.Destination))
    : null;
  const containerId = container?.Id;
  const capAdd = container?.HostConfig?.CapAdd ?? [];
  const devices = container?.HostConfig?.Devices ?? [];
  const safelyIdentified = /^[0-9a-f]{64}$/i.test(containerId ?? '')
    && /^[0-9a-f]{64}$/.test(leaseId)
    && /^[0-9a-f]{64}$/.test(labels['com.webmcp.native.policy-sha256'] ?? '')
    && labels['com.webmcp.native.image'] === imagePin.image
    && String(container?.Image ?? '').toLowerCase() === imagePin.image.toLowerCase()
    && container?.Config?.User === expectedUser
    && container?.HostConfig?.Privileged !== true
    && Array.isArray(capAdd)
    && capAdd.length === 0
    && Array.isArray(devices)
    && devices.length === 0
    && Array.isArray(capDrop)
    && capDrop.some((value) => String(value).toUpperCase() === 'ALL')
    && Array.isArray(securityOpt)
    && securityOpt.some((value) => String(value).startsWith('no-new-privileges'))
    && container?.HostConfig?.NetworkMode === 'none'
    && workspaceMount?.RW === true
    && path.isAbsolute(workspaceMount?.Source ?? '')
    && !gitMount;
  if (!safelyIdentified) {
    fail('Stale elevated Native container cannot be identified safely.', 'ELEVATED_CONTAINER_UNVERIFIED');
  }
  try {
    await execFileImpl(dockerBin, ['rm', '-f', containerId], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    fail('Unable to remove the stale elevated Native container.', 'CONTAINER_REMOVE_FAILED', { cause: error });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remaining = await inspectNativeContainer({ dockerBin, execFileImpl });
    if (!remaining) {
      return Object.freeze({ action: 'removed', leaseId, containerId });
    }
    if (remaining?.Id !== containerId) {
      fail('A different Native container appeared before elevated revocation could be confirmed.', 'ELEVATED_CONTAINER_UNVERIFIED');
    }
  }
  fail('Elevated Native container removal could not be confirmed.', 'CONTAINER_REMOVE_UNCONFIRMED');
}

export async function ensureNativeContainer(options = {}) {
  const resolved = await resolveNativeContainerPolicy(options);
  const {
    dockerBin = 'docker',
    execFileImpl = execFileAsync,
  } = options;

  let container = await inspectNativeContainer({ dockerBin, execFileImpl });
  if (container) {
    verifyContainer(container, resolved.expected);
    if (container?.State?.Running === true) {
      return Object.freeze({ action: 'unchanged', policyDigest: resolved.policy.policyDigest });
    }
    try {
      await execFileImpl(dockerBin, ['start', NATIVE_CONTAINER_NAME], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      fail('Unable to restart the verified Native container.', 'CONTAINER_START_FAILED', { cause: error });
    }
    container = await inspectNativeContainer({ dockerBin, execFileImpl });
    if (!container || container?.State?.Running !== true) {
      fail('Native container did not become running after start.', 'CONTAINER_START_FAILED');
    }
    verifyContainer(container, resolved.expected);
    return Object.freeze({ action: 'started', policyDigest: resolved.policy.policyDigest });
  }

  try {
    await execFileImpl(resolved.policy.command, resolved.policy.args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    fail('Unable to create the Native container.', 'CONTAINER_CREATE_FAILED', { cause: error });
  }
  container = await inspectNativeContainer({ dockerBin, execFileImpl });
  if (!container || container?.State?.Running !== true) {
    fail('Native container was not running after creation.', 'CONTAINER_CREATE_FAILED');
  }
  verifyContainer(container, resolved.expected);
  return Object.freeze({ action: 'created', policyDigest: resolved.policy.policyDigest });
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_WORKSPACE_CONFIG,
    imagePinPath: null,
    gitCredentialPath: null,
    gitKnownHostsPath: null,
    status: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}.`);
      }
      return argv[index];
    };
    if (arg === '--config') {
      options.configPath = next();
    } else if (arg === '--image-pin') {
      options.imagePinPath = next();
    } else if (arg === '--git-credential') {
      options.gitCredentialPath = next();
    } else if (arg === '--git-known-hosts') {
      options.gitKnownHostsPath = next();
    } else if (arg === '--status') {
      options.status = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.imagePinPath) {
    throw new Error('--image-pin is required.');
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    if (options.status) {
      const container = await inspectNativeContainer();
      process.stdout.write(`${JSON.stringify({
        present: Boolean(container),
        running: container?.State?.Running === true,
      })}\n`);
      return;
    }
    const result = await ensureNativeContainer(options);
    process.stdout.write(`Native WebMCP container: ${result.action}\n`);
  } catch (error) {
    process.stderr.write(`Native WebMCP container ensure failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (isMain) {
  await main();
}
