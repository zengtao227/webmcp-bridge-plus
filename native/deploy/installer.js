#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildNativeImage } from './build-image.js';
import { configureWorkspace } from './configure-workspace.js';
import {
  ensureNativeContainer,
  inspectNativeContainer,
  inspectNativeContainerState,
  removeNativeContainer,
  removeStaleElevatedContainer,
} from './container-controller.js';
import { defaultProtectedPaths } from './control-plane-paths.js';
import { NATIVE_CONTAINER_NAME, NATIVE_ELEVATED_LEASE_LABEL } from './container-policy.js';
import {
  buildElevatedWorkspaceConfig,
  clearElevatedLease,
  ElevatedAccessError,
  createElevatedLease,
  defaultElevatedLeasePath,
  elevatedLeasePublicStatus,
  getBootSessionId,
  getLoginSessionId,
  loadElevatedLease,
  MAX_ELEVATED_LEASE_MS,
  parseElevatedDuration,
  persistElevatedLease,
} from './elevated-access.js';
import {
  defaultNativeHostRuntimeRoot,
  deployNativeHostBoundary,
  verifyNativeHostBoundary,
} from './deploy-host-boundary.js';
import { loadImagePin } from './image-pin.js';
import {
  loadWorkspaceConfig,
  persistWorkspaceConfig,
  verifyWorkspaceMount,
} from './workspace-config.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TUNNEL_ALIAS = 'webmcp-native';
const TUNNEL_PROFILE = 'native';
const LAUNCH_AGENT_LABEL = 'com.webmcp.native-tunnel';
const STANDARD_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const PINNED_IMAGE_PATTERN = /^.+@sha256:[0-9a-f]{64}$/i;
export const DEFAULT_NATIVE_BASE_IMAGE = 'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';

export class InstallerError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'InstallerError';
    this.code = code;
  }
}

function fail(message, code, options = {}) {
  throw new InstallerError(message, code, options);
}

export function installerPaths(home = os.homedir()) {
  const webmcpData = path.join(home, '.local', 'share', 'webmcp');
  const tunnelStateHome = path.join(webmcpData, 'native-tunnel-home');
  const profileDir = path.join(home, '.config', 'tunnel-client');
  const runtimeDir = path.join(home, 'Library', 'Application Support', 'tunnel-client');
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  const logs = path.join(webmcpData, 'logs');
  return Object.freeze({
    home,
    workspaceConfig: path.join(home, '.config', 'webmcp', 'workspace.json'),
    imagePin: path.join(webmcpData, 'native-image.json'),
    elevatedLease: defaultElevatedLeasePath(home),
    hostRuntimeRoot: defaultNativeHostRuntimeRoot(home),
    hostEntrypoint: path.join(defaultNativeHostRuntimeRoot(home), 'current', 'native', 'host', 'start.js'),
    ownerControlEntrypoint: path.join(defaultNativeHostRuntimeRoot(home), 'current', 'native', 'deploy', 'installer.js'),
    tunnelClient: path.join(webmcpData, 'bin', 'tunnel-client'),
    tunnelStateHome,
    profileDir,
    profile: path.join(profileDir, `${TUNNEL_PROFILE}.yaml`),
    runtimeKey: path.join(runtimeDir, 'secrets', 'native-runtime-api-key'),
    plist: path.join(launchAgents, `${LAUNCH_AGENT_LABEL}.plist`),
    stdoutLog: path.join(logs, 'webmcp-native-tunnel.log'),
    stderrLog: path.join(logs, 'webmcp-native-tunnel.err'),
  });
}

function expandUserPath(value, home) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('Workspace root must be a non-empty path.', 'INVALID_WORKSPACE_ROOT');
  }
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  if (value.startsWith('~')) {
    fail('Only the current-user ~ form is supported for workspace roots.', 'INVALID_WORKSPACE_ROOT');
  }
  return path.resolve(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function assertLaunchDependenciesOutsideWorkspace(hostRoot, dependencies) {
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(hostRoot);
    const info = await lstat(canonicalRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a real directory');
  } catch (error) {
    fail(`Workspace root cannot be resolved to a real directory: ${hostRoot}`, 'INVALID_WORKSPACE_ROOT', { cause: error });
  }
  for (const [label, dependency] of Object.entries(dependencies)) {
    const canonicalDependency = await regularFile(dependency, label, { executable: true });
    if (isWithin(canonicalRoot, canonicalDependency)) {
      fail(`${label} must not execute from inside the model-writable workspace root.`, 'UNSAFE_HOST_EXECUTABLE_LOCATION');
    }
  }
  return canonicalRoot;
}

export async function assertSecretSourceOutsideWorkspace(sourcePath, workspaceRoot, protectedDestination = null) {
  if (!sourcePath) return null;
  const source = await regularFile(path.resolve(sourcePath), 'Runtime API key source');
  const canonicalRoot = await realpath(workspaceRoot);
  let allowed = null;
  if (protectedDestination && await pathKind(protectedDestination) === 'file') {
    allowed = await realpath(protectedDestination);
  }
  if (isWithin(canonicalRoot, source) && source !== allowed) {
    fail('Runtime API key source must not remain inside the model-writable workspace root.', 'UNSAFE_RUNTIME_KEY_SOURCE');
  }
  return source;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildNativeLaunchAgent(paths, { pathEnv = STANDARD_PATH } = {}) {
  return Object.freeze({
    Label: LAUNCH_AGENT_LABEL,
    ProgramArguments: Object.freeze([
      paths.tunnelClient,
      'run',
      '--profile-dir',
      paths.profileDir,
      '--profile',
      TUNNEL_PROFILE,
    ]),
    EnvironmentVariables: Object.freeze({
      HOME: paths.tunnelStateHome,
      PATH: pathEnv,
    }),
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 30,
    StandardOutPath: paths.stdoutLog,
    StandardErrorPath: paths.stderrLog,
  });
}

export function launchAgentXml(agent) {
  const strings = (values) => values.map((value) => `      <string>${xmlEscape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xmlEscape(agent.Label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${strings(agent.ProgramArguments)}\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key>\n    <string>${xmlEscape(agent.EnvironmentVariables.HOME)}</string>\n    <key>PATH</key>\n    <string>${xmlEscape(agent.EnvironmentVariables.PATH)}</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>ThrottleInterval</key>\n  <integer>${agent.ThrottleInterval}</integer>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(agent.StandardOutPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(agent.StandardErrorPath)}</string>\n</dict>\n</plist>\n`;
}

async function pathKind(candidate) {
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isFile()) return 'file';
    if (info.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    throw error;
  }
}

export function classifyInstallArtifacts(kinds, { containerPresent = false, launchdState = 'absent' } = {}) {
  const expectedFiles = ['workspaceConfig', 'imagePin', 'tunnelClient', 'profile', 'plist'];
  const expectedDirectories = ['hostRuntimeRoot', 'tunnelStateHome'];
  const unsafe = [
    ...expectedFiles.filter((key) => !['absent', 'file'].includes(kinds[key])),
    ...expectedDirectories.filter((key) => !['absent', 'directory'].includes(kinds[key])),
  ];
  if (unsafe.length > 0 || launchdState === 'unknown') {
    return Object.freeze({ state: 'unsafe', unsafe: Object.freeze(unsafe) });
  }
  const presentCount = [...expectedFiles, ...expectedDirectories]
    .filter((key) => kinds[key] !== 'absent').length;
  if (presentCount === 0 && !containerPresent && launchdState === 'absent') {
    return Object.freeze({ state: 'fresh', unsafe: Object.freeze([]) });
  }
  const complete = expectedFiles.every((key) => kinds[key] === 'file')
    && expectedDirectories.every((key) => kinds[key] === 'directory');
  if (!complete) {
    return Object.freeze({ state: 'partial', unsafe: Object.freeze([]) });
  }
  return Object.freeze({ state: 'candidate', unsafe: Object.freeze([]) });
}

async function regularFile(candidate, label, { executable = false, mode = null } = {}) {
  let canonical;
  let info;
  try {
    canonical = await realpath(candidate);
    info = await lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not regular');
    await access(canonical, executable ? fsConstants.X_OK : fsConstants.R_OK);
  } catch (error) {
    fail(`${label} must resolve to a ${executable ? 'readable executable' : 'readable regular'} file: ${candidate}`, 'INVALID_INSTALL_FILE', { cause: error });
  }
  if (mode !== null && (info.mode & 0o777) !== mode) {
    fail(`${label} must have mode ${mode.toString(8)}: ${candidate}`, 'UNSAFE_INSTALL_FILE_MODE');
  }
  return canonical;
}

async function writeAtomic(filePath, content, mode = 0o600) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await rm(temporary, { force: true });
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode, flag: 'wx' });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function resolveExecutable(name, pathValue = process.env.PATH ?? '') {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      const canonical = await realpath(candidate);
      const info = await lstat(canonical);
      if (info.isFile() && !info.isSymbolicLink()) return canonical;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return null;
}

function launchPath(nodeBin, dockerBin) {
  return [...new Set([
    path.dirname(nodeBin),
    path.dirname(dockerBin),
    ...STANDARD_PATH.split(':'),
  ])].join(':');
}

async function queryLaunchAgent(execFileImpl, uid) {
  try {
    await execFileImpl('launchctl', ['print', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return 'loaded';
  } catch (error) {
    if (error?.code === 113) return 'absent';
    return 'unknown';
  }
}

async function waitLaunchAgentAbsent(execFileImpl, uid, sleepImpl, { attempts = 20, delayMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await queryLaunchAgent(execFileImpl, uid);
    if (state === 'absent') return;
    if (state === 'unknown') fail('Unable to determine LaunchAgent state.', 'LAUNCHD_STATE_UNKNOWN');
    if (attempt + 1 < attempts) await sleepImpl(delayMs);
  }
  fail('LaunchAgent did not stop within the bounded wait.', 'LAUNCHD_STOP_TIMEOUT');
}

function tunnelExecOptions(paths, extra = {}, tunnelHome = paths.tunnelStateHome) {
  return {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, HOME: tunnelHome },
    ...extra,
  };
}

async function tunnelStatus(paths, execFileImpl, tunnelHome = paths.tunnelStateHome) {
  const { stdout } = await execFileImpl(paths.tunnelClient, [
    'runtimes', 'status', TUNNEL_ALIAS, '--json',
  ], tunnelExecOptions(paths, {}, tunnelHome));
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    fail('tunnel-client returned invalid runtime status JSON.', 'INVALID_TUNNEL_STATUS', { cause: error });
  }
  return parsed;
}

async function waitTunnelReady(paths, execFileImpl, sleepImpl, {
  attempts = 30,
  delayMs = 1000,
  tunnelHome = paths.tunnelStateHome,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const statusValue = await tunnelStatus(paths, execFileImpl, tunnelHome);
      if (statusValue?.ready === true) return statusValue;
    } catch {
      // LaunchAgent startup is asynchronous. Retry within the bounded window.
    }
    if (attempt + 1 < attempts) await sleepImpl(delayMs);
  }
  fail('Native tunnel did not become ready within the bounded wait.', 'TUNNEL_NOT_READY');
}

async function readPlistJson(plistPath, execFileImpl) {
  try {
    const { stdout } = await execFileImpl('plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    fail('Unable to parse the Native LaunchAgent plist.', 'INVALID_NATIVE_PLIST', { cause: error });
  }
}

function sameArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export async function validateNativeLaunchAgent(plist, paths) {
  const expectedArgs = [
    paths.tunnelClient,
    'run',
    '--profile-dir',
    paths.profileDir,
    '--profile',
    TUNNEL_PROFILE,
  ];
  const tunnelHome = plist?.EnvironmentVariables?.HOME ?? paths.home;
  const supportedTunnelHome = tunnelHome === paths.tunnelStateHome || tunnelHome === paths.home;
  const legacyStdoutLog = path.join(paths.home, 'Library', 'Logs', 'webmcp-native-tunnel.log');
  const legacyStderrLog = path.join(paths.home, 'Library', 'Logs', 'webmcp-native-tunnel.err');
  const supportedLogs = (
    plist?.StandardOutPath === paths.stdoutLog
    && plist?.StandardErrorPath === paths.stderrLog
  ) || (
    plist?.StandardOutPath === legacyStdoutLog
    && plist?.StandardErrorPath === legacyStderrLog
  );
  if (
    plist?.Label !== LAUNCH_AGENT_LABEL
    || !sameArray(plist?.ProgramArguments, expectedArgs)
    || !supportedTunnelHome
    || typeof plist?.EnvironmentVariables?.PATH !== 'string'
    || plist.EnvironmentVariables.PATH.length === 0
    || plist?.RunAtLoad !== true
    || plist?.KeepAlive !== true
    || plist?.ThrottleInterval !== 30
    || !supportedLogs
  ) {
    fail('Native LaunchAgent configuration drifted from the supported Native contract.', 'NATIVE_PLIST_DRIFT');
  }
  const [nodeBin, dockerBin] = await Promise.all([
    resolveExecutable('node', plist.EnvironmentVariables.PATH),
    resolveExecutable('docker', plist.EnvironmentVariables.PATH),
  ]);
  if (!nodeBin || !dockerBin) {
    fail('Native LaunchAgent PATH no longer resolves both node and docker.', 'NATIVE_PLIST_DEPENDENCY_DRIFT');
  }
  return Object.freeze({ nodeBin, dockerBin, tunnelHome });
}

async function inspectArtifactKinds(paths) {
  const entries = await Promise.all(Object.entries({
    workspaceConfig: paths.workspaceConfig,
    imagePin: paths.imagePin,
    hostRuntimeRoot: paths.hostRuntimeRoot,
    tunnelClient: paths.tunnelClient,
    tunnelStateHome: paths.tunnelStateHome,
    profile: paths.profile,
    plist: paths.plist,
  }).map(async ([key, candidate]) => [key, await pathKind(candidate)]));
  return Object.freeze(Object.fromEntries(entries));
}

export async function assertMacDependencies({
  tunnelClientSource = null,
  execFileImpl = execFileAsync,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  pathValue = process.env.PATH ?? '',
  standardPath = STANDARD_PATH,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  if (platform !== 'darwin') {
    fail('The current Base WebMCP installer supports macOS only.', 'UNSUPPORTED_PLATFORM');
  }
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    fail('Node.js 22 or newer is required.', 'NODE_VERSION_UNSUPPORTED');
  }
  if (!['arm64', 'x64'].includes(arch)) {
    fail(`Unsupported macOS architecture: ${arch}`, 'UNSUPPORTED_ARCHITECTURE');
  }
  if (!Number.isInteger(uid) || uid <= 0) {
    fail('A non-root macOS user session is required.', 'UNSUPPORTED_USER_SESSION');
  }

  const lookupPath = [...new Set([...pathValue.split(path.delimiter), ...standardPath.split(':')])]
    .filter(Boolean)
    .join(path.delimiter);
  const [gitBin, dockerBin, plutilBin, launchctlBin] = await Promise.all([
    resolveExecutable('git', lookupPath),
    resolveExecutable('docker', lookupPath),
    resolveExecutable('plutil', lookupPath),
    resolveExecutable('launchctl', lookupPath),
  ]);
  if (!gitBin) fail('git is required and was not found in PATH.', 'MISSING_DEPENDENCY');
  if (!dockerBin) fail('Docker Desktop/Engine is required and docker was not found in PATH.', 'MISSING_DEPENDENCY');
  if (!plutilBin || !launchctlBin) fail('macOS plutil and launchctl are required.', 'MISSING_DEPENDENCY');

  try {
    await execFileImpl(dockerBin, ['info'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    fail('Docker is installed but the Docker engine is not available.', 'DOCKER_UNAVAILABLE', { cause: error });
  }
  try {
    await execFileImpl(launchctlBin, ['print', `gui/${uid}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } catch (error) {
    fail('The current shell cannot access the per-user launchd GUI domain.', 'LAUNCHD_DOMAIN_UNAVAILABLE', { cause: error });
  }

  let client = tunnelClientSource;
  if (client) client = await regularFile(path.resolve(client), 'tunnel-client', { executable: true });
  if (!client) client = await resolveExecutable('tunnel-client', lookupPath);
  if (!client) {
    fail('tunnel-client is required. Install the supported OpenAI tunnel-client or pass --tunnel-client <path>.', 'MISSING_TUNNEL_CLIENT');
  }
  try {
    await execFileImpl(client, ['runtimes', 'connect', '--help'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } catch (error) {
    fail('tunnel-client does not expose the required runtimes connect CLI.', 'UNSUPPORTED_TUNNEL_CLIENT', { cause: error });
  }
  return Object.freeze({ nodeBin: process.execPath, dockerBin, tunnelClientSource: client });
}

async function installTunnelClient(source, destination) {
  const canonicalSource = await regularFile(source, 'tunnel-client', { executable: true });
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (canonicalSource !== destination) await copyFile(canonicalSource, destination);
  await chmod(destination, 0o700);
  return regularFile(destination, 'managed tunnel-client', { executable: true, mode: 0o700 });
}

async function installRuntimeKey(paths, sourcePath, promptSecret) {
  if (await pathKind(paths.runtimeKey) === 'file') {
    const existing = await regularFile(paths.runtimeKey, 'Native runtime API key', { mode: 0o600 });
    if ((await stat(existing)).size === 0) fail('Existing Native runtime API key file is empty.', 'INVALID_RUNTIME_KEY');
    return Object.freeze({ created: false, path: existing });
  }
  if (await pathKind(paths.runtimeKey) !== 'absent') {
    fail('Native runtime API key path is not a regular file.', 'UNSAFE_RUNTIME_KEY_PATH');
  }
  let bytes;
  if (sourcePath) {
    const source = await regularFile(path.resolve(sourcePath), 'Runtime API key source');
    bytes = await readFile(source);
  } else {
    const secret = await promptSecret('OpenAI Tunnel Runtime API key: ');
    if (!secret) fail('Runtime API key cannot be empty.', 'INVALID_RUNTIME_KEY');
    bytes = Buffer.from(secret, 'utf8');
  }
  if (bytes.length === 0) fail('Runtime API key cannot be empty.', 'INVALID_RUNTIME_KEY');
  await mkdir(path.dirname(paths.runtimeKey), { recursive: true, mode: 0o700 });
  await writeFile(paths.runtimeKey, bytes, { mode: 0o600, flag: 'wx' });
  await chmod(paths.runtimeKey, 0o600);
  return Object.freeze({ created: true, path: paths.runtimeKey });
}

async function writeLaunchAgent(paths, pathEnv, execFileImpl) {
  await mkdir(path.dirname(paths.plist), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(paths.stdoutLog), { recursive: true, mode: 0o700 });
  const agent = buildNativeLaunchAgent(paths, { pathEnv });
  await writeAtomic(paths.plist, launchAgentXml(agent), 0o600);
  try {
    await execFileImpl('plutil', ['-lint', paths.plist], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } catch (error) {
    fail('Generated Native LaunchAgent plist failed plutil validation.', 'INVALID_NATIVE_PLIST', { cause: error });
  }
  return agent;
}

async function connectTunnel({ paths, tunnelId, execFileImpl }) {
  await execFileImpl(paths.tunnelClient, ['runtimes', 'stop', TUNNEL_ALIAS], tunnelExecOptions(paths)).catch(() => {});
  try {
    await execFileImpl(paths.tunnelClient, [
      'runtimes', 'connect',
      '--alias', TUNNEL_ALIAS,
      '--profile', TUNNEL_PROFILE,
      '--profile-dir', paths.profileDir,
      '--tunnel-id', tunnelId,
      '--runtime-api-key', `file:${paths.runtimeKey}`,
      '--mcp-command', paths.hostEntrypoint,
    ], tunnelExecOptions(paths));
    const statusValue = await tunnelStatus(paths, execFileImpl);
    if (statusValue?.ready !== true) fail('Temporary Native tunnel connection did not become ready.', 'TUNNEL_NOT_READY');
  } catch (error) {
    await execFileImpl(paths.tunnelClient, ['runtimes', 'stop', TUNNEL_ALIAS], tunnelExecOptions(paths)).catch(() => {});
    if (error instanceof InstallerError) throw error;
    fail('Unable to connect the Native runtime to the Secure MCP Tunnel.', 'TUNNEL_CONNECT_FAILED', { cause: error });
  }
  await execFileImpl(paths.tunnelClient, ['runtimes', 'stop', TUNNEL_ALIAS], tunnelExecOptions(paths));
}

async function bootstrapLaunchAgent(paths, execFileImpl, sleepImpl) {
  const plist = await readPlistJson(paths.plist, execFileImpl);
  const { tunnelHome } = await validateNativeLaunchAgent(plist, paths);
  const uid = process.getuid();
  const before = await queryLaunchAgent(execFileImpl, uid);
  if (before === 'unknown') fail('Unable to determine existing Native LaunchAgent state.', 'LAUNCHD_STATE_UNKNOWN');
  if (before === 'loaded') {
    await execFileImpl('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    await waitLaunchAgentAbsent(execFileImpl, uid, sleepImpl);
  }
  await execFileImpl('launchctl', ['bootstrap', `gui/${uid}`, paths.plist], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  await waitTunnelReady(paths, execFileImpl, sleepImpl, { tunnelHome });
}

async function stopLaunchAgent(paths, execFileImpl, sleepImpl) {
  const plist = await readPlistJson(paths.plist, execFileImpl);
  const { tunnelHome } = await validateNativeLaunchAgent(plist, paths);
  const uid = process.getuid();
  const state = await queryLaunchAgent(execFileImpl, uid);
  if (state === 'unknown') fail('Unable to determine Native LaunchAgent state.', 'LAUNCHD_STATE_UNKNOWN');
  if (state === 'loaded') {
    await execFileImpl('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    await waitLaunchAgentAbsent(execFileImpl, uid, sleepImpl);
  }
  if (await pathKind(paths.tunnelClient) === 'file') {
    await execFileImpl(
      paths.tunnelClient,
      ['runtimes', 'stop', TUNNEL_ALIAS],
      tunnelExecOptions(paths, {}, tunnelHome),
    ).catch(() => {});
  }
  return tunnelHome;
}

async function verifyInstalledLayout(paths, {
  execFileImpl = execFileAsync,
  requireReady = true,
  requireLaunchd = true,
  requireContainer = true,
  workspaceConfig = null,
  elevationLeaseId = null,
} = {}) {
  await regularFile(paths.workspaceConfig, 'Workspace config');
  await regularFile(paths.imagePin, 'Native image pin');
  await regularFile(paths.tunnelClient, 'Managed tunnel-client', { executable: true, mode: 0o700 });
  await regularFile(paths.profile, 'Native tunnel profile');
  await regularFile(paths.plist, 'Native LaunchAgent plist');
  await regularFile(paths.runtimeKey, 'Native runtime API key', { mode: 0o600 });

  const config = await loadWorkspaceConfig(paths.workspaceConfig, { platform: 'darwin' });
  if (config.gitPublicationEnabled) {
    fail('The Base installer does not own optional Git publication credentials. Disable that capability before installer lifecycle operations.', 'OPTIONAL_GIT_CAPABILITY_EXTERNAL');
  }
  const imagePin = await loadImagePin(paths.imagePin);
  const hostRuntime = await verifyNativeHostBoundary(paths.hostRuntimeRoot);
  if (!hostRuntime || path.resolve(hostRuntime.entrypoint) !== path.resolve(paths.hostEntrypoint)) {
    fail('Native immutable host runtime is missing or drifted.', 'HOST_RUNTIME_DRIFT');
  }
  const container = await inspectNativeContainerState({
    configPath: paths.workspaceConfig,
    workspaceConfig,
    imagePinPath: paths.imagePin,
    elevationLeaseId,
    platform: 'darwin',
    execFileImpl,
  });
  if (requireContainer && (!container.present || !container.running)) {
    fail('Native container is missing or not running.', 'NATIVE_CONTAINER_NOT_READY');
  }

  const profileText = await readFile(paths.profile, 'utf8');
  if (!profileText.includes(paths.hostEntrypoint) || !profileText.includes(`file:${paths.runtimeKey}`)) {
    fail('Native tunnel profile does not point only at the immutable host entrypoint and protected runtime key.', 'NATIVE_PROFILE_DRIFT');
  }
  const plist = await readPlistJson(paths.plist, execFileImpl);
  const launchAgent = await validateNativeLaunchAgent(plist, paths);
  const launchDependencies = Object.freeze({
    nodeBin: launchAgent.nodeBin,
    dockerBin: launchAgent.dockerBin,
  });
  await assertLaunchDependenciesOutsideWorkspace(config.hostRoot, launchDependencies);
  const launchdState = await queryLaunchAgent(execFileImpl, process.getuid());
  if (launchdState === 'unknown') fail('Unable to determine Native LaunchAgent state.', 'LAUNCHD_STATE_UNKNOWN');
  if (requireLaunchd && launchdState !== 'loaded') fail('Native LaunchAgent is not loaded.', 'NATIVE_LAUNCH_AGENT_NOT_LOADED');

  let tunnelReady = false;
  if (requireReady) {
    const statusValue = await tunnelStatus(paths, execFileImpl, launchAgent.tunnelHome);
    tunnelReady = statusValue?.ready === true;
    if (!tunnelReady) fail('Native Secure MCP Tunnel is not ready.', 'TUNNEL_NOT_READY');
  }
  return Object.freeze({
    config,
    imagePin,
    hostRuntime,
    container,
    launchdState,
    tunnelReady,
    launchDependencies,
    tunnelHome: launchAgent.tunnelHome,
  });
}

export function publicInstallationStatus(state) {
  if (state.state !== 'installed') {
    return Object.freeze({
      state: state.state,
      ...(state.reason ? { reason: state.reason } : {}),
      ...(state.code ? { code: state.code } : {}),
    });
  }
  return Object.freeze({
    state: 'installed',
    root: state.details.config.hostRoot,
    mode: state.details.config.mode,
    containerRunning: state.details.container.running,
    launchAgentLoaded: state.details.launchdState === 'loaded',
    tunnelReady: state.details.tunnelReady,
    hostArtifactId: state.details.hostRuntime.artifactId,
  });
}

export async function inspectInstallation(paths = installerPaths(), { execFileImpl = execFileAsync } = {}) {
  const kinds = await inspectArtifactKinds(paths);
  let containerPresent = false;
  try {
    containerPresent = Boolean(await inspectNativeContainer({ execFileImpl }));
  } catch {
    return Object.freeze({ state: 'unsafe', reason: 'Unable to inspect Docker container state.', kinds });
  }
  const launchdState = await queryLaunchAgent(execFileImpl, process.getuid());
  const raw = classifyInstallArtifacts(kinds, { containerPresent, launchdState });
  if (raw.state !== 'candidate') return Object.freeze({ ...raw, kinds, launchdState, containerPresent });
  try {
    const details = await verifyInstalledLayout(paths, { execFileImpl });
    return Object.freeze({ state: 'installed', kinds, launchdState, containerPresent, details });
  } catch (error) {
    return Object.freeze({
      state: error instanceof InstallerError && error.code?.startsWith('UNSAFE') ? 'unsafe' : 'drift',
      reason: error.message,
      code: error.code ?? 'INSTALLATION_DRIFT',
      kinds,
      launchdState,
      containerPresent,
    });
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeVerifiedContainer(paths, execFileImpl) {
  await removeNativeContainer({
    configPath: paths.workspaceConfig,
    imagePinPath: paths.imagePin,
    platform: 'darwin',
    execFileImpl,
  });
}

export async function applyElevatedTransition({
  stopService,
  removeNormalContainer,
  persistLease,
  ensureElevatedContainer,
  startService,
  verifyElevated = async () => {},
  clearLease,
  removeElevatedContainer,
  ensureNormalContainer,
} = {}) {
  let serviceStopped = false;
  try {
    await stopService();
    serviceStopped = true;
    await removeNormalContainer();
    await persistLease();
    await ensureElevatedContainer();
    await startService();
    await verifyElevated();
  } catch (error) {
    if (!serviceStopped) throw error;
    try {
      // startService may have partially activated the tunnel, so stop again
      // before changing the mount. Rollback never leaves elevated authority live.
      await stopService();
      await clearLease();
      await removeElevatedContainer();
      await ensureNormalContainer();
      await startService();
    } catch (rollbackError) {
      fail(`Elevated transition failed and normal-mode rollback also failed: ${rollbackError.message}`, 'ELEVATION_ROLLBACK_FAILED', { cause: error });
    }
    throw error;
  }
}

export async function applyElevationRevoke({
  stopService,
  clearLease,
  removeElevatedContainer,
  ensureNormalContainer,
  startService,
} = {}) {
  await stopService();
  try {
    // Authority is invalidated before container cleanup. Any later failure keeps
    // the service stopped and therefore fails closed rather than re-exposing it.
    await clearLease();
    await removeElevatedContainer();
    await ensureNormalContainer();
    await startService();
  } catch (error) {
    fail(`Elevated access revoke failed closed with the Native service stopped: ${error.message}`, 'ELEVATION_REVOKE_FAILED', { cause: error });
  }
}

export function uninstallManagedPaths(paths) {
  return Object.freeze([
    paths.plist,
    paths.profile,
    paths.workspaceConfig,
    paths.imagePin,
    paths.elevatedLease,
    paths.hostRuntimeRoot,
    paths.tunnelClient,
    paths.tunnelStateHome,
    paths.stdoutLog,
    paths.stderrLog,
  ]);
}

async function cleanupFreshInstall(paths, execFileImpl, sleepImpl, { containerCreated = false } = {}) {
  await stopLaunchAgent(paths, execFileImpl, sleepImpl).catch(() => {});
  if (await pathKind(paths.tunnelClient) === 'file') {
    await execFileImpl(paths.tunnelClient, ['runtimes', 'rm', TUNNEL_ALIAS], tunnelExecOptions(paths)).catch(() => {});
  }
  if (containerCreated) {
    await execFileImpl('docker', ['rm', '-f', NATIVE_CONTAINER_NAME], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).catch(() => {});
  }
  await Promise.all([
    rm(paths.workspaceConfig, { force: true }),
    rm(paths.imagePin, { force: true }),
    rm(paths.hostRuntimeRoot, { recursive: true, force: true }),
    rm(paths.profile, { force: true }),
    rm(paths.plist, { force: true }),
    rm(paths.tunnelClient, { force: true }),
    rm(paths.tunnelStateHome, { recursive: true, force: true }),
  ]);
}

export async function installWebMcp({
  root,
  baseImage = DEFAULT_NATIVE_BASE_IMAGE,
  tunnelId,
  runtimeKeyFile = null,
  tunnelClient = null,
  sourceRoot = REPO_ROOT,
  home = os.homedir(),
  execFileImpl = execFileAsync,
  sleepImpl = defaultSleep,
  promptSecret = null,
} = {}) {
  const paths = installerPaths(home);
  const managedTunnelClient = await pathKind(paths.tunnelClient) === 'file' ? paths.tunnelClient : null;
  const dependency = await assertMacDependencies({
    tunnelClientSource: tunnelClient ?? managedTunnelClient,
    execFileImpl,
  });
  const existing = await inspectInstallation(paths, { execFileImpl });
  if (existing.state === 'installed') {
    const requestedRoot = root ? await realpath(expandUserPath(root, home)).catch(() => null) : null;
    if (requestedRoot && requestedRoot !== existing.details.config.hostRoot) {
      fail('WebMCP is already installed with a different workspace root. Use reconfigure --root <path>.', 'RECONFIGURE_REQUIRED');
    }
    return Object.freeze({ action: 'unchanged', root: existing.details.config.hostRoot });
  }
  if (existing.state !== 'fresh') {
    fail(`Existing WebMCP installation state is ${existing.state}; refusing to overwrite it${existing.reason ? `: ${existing.reason}` : '.'}`, 'EXISTING_INSTALLATION_UNSAFE');
  }
  if (!root) fail('Fresh install requires an owner-selected workspace root.', 'WORKSPACE_ROOT_REQUIRED');
  if (!PINNED_IMAGE_PATTERN.test(baseImage)) {
    fail('Native base image must be an immutable name@sha256:digest reference.', 'REVIEWED_BASE_IMAGE_REQUIRED');
  }
  if (!tunnelId || !TUNNEL_ID_PATTERN.test(tunnelId)) {
    fail('Fresh install requires the Secure MCP Tunnel ID (tunnel_<32 lowercase hex>).', 'TUNNEL_ID_REQUIRED');
  }
  if (!promptSecret) {
    promptSecret = async () => fail('Runtime API key is required; pass --runtime-key-file when not running interactively.', 'RUNTIME_KEY_REQUIRED');
  }

  const selectedRoot = expandUserPath(root, home);
  const canonicalSelectedRoot = await assertLaunchDependenciesOutsideWorkspace(selectedRoot, {
    node: dependency.nodeBin,
    docker: dependency.dockerBin,
  });
  await assertSecretSourceOutsideWorkspace(runtimeKeyFile, canonicalSelectedRoot, paths.runtimeKey);
  let containerCreated = false;
  try {
    await installTunnelClient(dependency.tunnelClientSource, paths.tunnelClient);
    await mkdir(paths.tunnelStateHome, { recursive: true, mode: 0o700 });
    await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
    await installRuntimeKey(paths, runtimeKeyFile, promptSecret);

    const image = await buildNativeImage({
      sourceRoot: path.resolve(sourceRoot),
      baseImage,
      outputPin: paths.imagePin,
    });
    const hostRuntime = await deployNativeHostBoundary({
      sourceRoot: path.resolve(sourceRoot),
      runtimeRoot: paths.hostRuntimeRoot,
    });
    if (path.resolve(hostRuntime.entrypoint) !== path.resolve(paths.hostEntrypoint)) {
      fail('Deployed Native host boundary resolved to an unexpected entrypoint.', 'HOST_RUNTIME_DRIFT');
    }
    await writeLaunchAgent(paths, launchPath(dependency.nodeBin, dependency.dockerBin), execFileImpl);

    await configureWorkspace({
      root: selectedRoot,
      mode: 'workspace',
      probeImage: image.image,
      configPath: paths.workspaceConfig,
      platform: 'darwin',
    });
    const containerResult = await ensureNativeContainer({
      configPath: paths.workspaceConfig,
      imagePinPath: paths.imagePin,
      platform: 'darwin',
      execFileImpl,
    });
    containerCreated = containerResult.action === 'created';
    await connectTunnel({ paths, tunnelId, execFileImpl });
    await bootstrapLaunchAgent(paths, execFileImpl, sleepImpl);
    const verified = await verifyInstalledLayout(paths, { execFileImpl });
    return Object.freeze({ action: 'installed', root: verified.config.hostRoot });
  } catch (error) {
    await cleanupFreshInstall(paths, execFileImpl, sleepImpl, { containerCreated });
    // Keep the owner-supplied runtime credential for a safe retry. Remote
    // tunnel revocation remains an explicit OpenAI-side owner action.
    throw error;
  }
}

export async function doctorWebMcp({
  home = os.homedir(),
  execFileImpl = execFileAsync,
} = {}) {
  const paths = installerPaths(home);
  const state = await inspectInstallation(paths, { execFileImpl });
  if (state.state !== 'installed') {
    fail(`WebMCP installation is not healthy: ${state.state}${state.reason ? ` (${state.reason})` : ''}`, 'INSTALLATION_NOT_HEALTHY');
  }
  return Object.freeze({
    state: 'installed',
    root: state.details.config.hostRoot,
    mode: state.details.config.mode,
    tunnelReady: state.details.tunnelReady,
    containerRunning: state.details.container.running,
    hostArtifactId: state.details.hostRuntime.artifactId,
  });
}

export function reconfiguredWorkspaceConfig(current, hostRoot) {
  return Object.freeze({ ...current, hostRoot });
}

export async function reconfigureWebMcp({
  root,
  home = os.homedir(),
  execFileImpl = execFileAsync,
  sleepImpl = defaultSleep,
} = {}) {
  if (!root) fail('reconfigure requires --root <path>.', 'WORKSPACE_ROOT_REQUIRED');
  const paths = installerPaths(home);
  const current = await verifyInstalledLayout(paths, { execFileImpl });
  const selectedRoot = expandUserPath(root, home);
  const imagePin = await loadImagePin(paths.imagePin);
  const protectedPaths = await defaultProtectedPaths({
    home,
    configPath: paths.workspaceConfig,
    platform: 'darwin',
  });
  const probe = await verifyWorkspaceMount({
    hostRoot: selectedRoot,
    image: imagePin.image,
    protectedPaths: [...new Set([...protectedPaths, paths.imagePin])],
    platform: 'darwin',
  });
  await assertLaunchDependenciesOutsideWorkspace(probe.canonicalRoot, current.launchDependencies);
  if (probe.canonicalRoot === current.config.hostRoot) {
    return Object.freeze({ action: 'unchanged', root: current.config.hostRoot });
  }

  const previousConfig = current.config;
  try {
    // stopLaunchAgent itself mutates host state (launchctl bootout); a failure here
    // must fall into the same rollback/re-bootstrap path as the rest of this sequence
    // instead of leaving the Native tunnel stopped with no recovery attempt.
    await stopLaunchAgent(paths, execFileImpl, sleepImpl);
    await removeVerifiedContainer(paths, execFileImpl);
    await persistWorkspaceConfig(
      paths.workspaceConfig,
      reconfiguredWorkspaceConfig(previousConfig, probe.canonicalRoot),
      { platform: 'darwin' },
    );
    await ensureNativeContainer({
      configPath: paths.workspaceConfig,
      imagePinPath: paths.imagePin,
      platform: 'darwin',
      execFileImpl,
    });
    await bootstrapLaunchAgent(paths, execFileImpl, sleepImpl);
    await verifyInstalledLayout(paths, { execFileImpl });
    return Object.freeze({ action: 'reconfigured', root: probe.canonicalRoot });
  } catch (error) {
    let rollbackError = null;
    try {
      await execFileImpl('docker', ['rm', '-f', NATIVE_CONTAINER_NAME], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).catch(() => {});
      await persistWorkspaceConfig(paths.workspaceConfig, previousConfig, { platform: 'darwin' });
      await ensureNativeContainer({
        configPath: paths.workspaceConfig,
        imagePinPath: paths.imagePin,
        platform: 'darwin',
        execFileImpl,
      });
      await bootstrapLaunchAgent(paths, execFileImpl, sleepImpl);
    } catch (candidate) {
      rollbackError = candidate;
    }
    if (rollbackError) {
      fail(`Workspace reconfigure failed and rollback did not restore the previous installation: ${rollbackError.message}`, 'RECONFIGURE_ROLLBACK_FAILED', { cause: error });
    }
    throw error;
  }
}

export async function assertTrustedElevationControl({
  home = os.homedir(),
  modulePath = fileURLToPath(import.meta.url),
  verifyHostRuntimeImpl = verifyNativeHostBoundary,
  realpathImpl = realpath,
} = {}) {
  const paths = installerPaths(home);
  let running;
  let installed;
  try {
    await verifyHostRuntimeImpl(paths.hostRuntimeRoot);
    [running, installed] = await Promise.all([
      realpathImpl(modulePath),
      realpathImpl(paths.ownerControlEntrypoint),
    ]);
  } catch (error) {
    fail('Temporary elevation control is not available from the verified immutable host runtime.', 'UNTRUSTED_ELEVATION_CONTROL_PATH', { cause: error });
  }
  if (running !== installed) {
    fail('Temporary elevation commands must run from the verified immutable host runtime, not a writable checkout.', 'UNTRUSTED_ELEVATION_CONTROL_PATH');
  }
  return Object.freeze({ modulePath: running, paths });
}

export async function elevatedStatusWebMcp({
  home = os.homedir(),
  execFileImpl = execFileAsync,
  inspectContainerStateImpl = inspectNativeContainerState,
  now = Date.now(),
} = {}) {
  const paths = installerPaths(home);
  const normalConfig = await loadWorkspaceConfig(paths.workspaceConfig, { platform: 'darwin' });
  const common = {
    normalRoot: normalConfig.hostRoot,
    localKillCommand: `node ${JSON.stringify(paths.ownerControlEntrypoint)} elevate-stop`,
  };

  let leasePresent = true;
  try {
    await lstat(paths.elevatedLease);
  } catch (error) {
    if (error?.code === 'ENOENT') leasePresent = false;
    else {
      return Object.freeze({
        mode: 'unknown',
        leaseState: 'unverified',
        runtimeState: 'unverified',
        reason: 'Elevated lease state cannot be inspected.',
        ...common,
      });
    }
  }

  let state = Object.freeze({ state: 'absent' });
  if (leasePresent) {
    let bootSessionId;
    let loginSessionId;
    try {
      bootSessionId = await getBootSessionId({ platform: 'darwin', execFileImpl });
      loginSessionId = await getLoginSessionId({ platform: 'darwin', execFileImpl });
    } catch (error) {
      return Object.freeze({
        mode: 'unknown',
        leaseState: 'unverified',
        runtimeState: 'unverified',
        reason: error.message,
        ...common,
      });
    }
    state = await loadElevatedLease(paths.elevatedLease, {
      normalConfig,
      bootSessionId,
      loginSessionId,
      now,
      platform: 'darwin',
    });
  }

  const leaseStatus = elevatedLeasePublicStatus(state, { now });
  const containerOptions = {
    configPath: paths.workspaceConfig,
    imagePinPath: paths.imagePin,
    platform: 'darwin',
    execFileImpl,
  };
  if (state.state === 'active') {
    containerOptions.workspaceConfig = buildElevatedWorkspaceConfig(normalConfig, state.lease.elevatedRoot, { platform: 'darwin' });
    containerOptions.elevationLeaseId = state.lease.id;
  }

  let runtime;
  try {
    runtime = await inspectContainerStateImpl(containerOptions);
  } catch (error) {
    const { mode: expectedMode, ...leaseDetails } = leaseStatus;
    return Object.freeze({
      mode: 'unknown',
      expectedMode,
      ...leaseDetails,
      runtimeState: 'unverified',
      reason: error.message,
      ...common,
    });
  }
  if (!runtime.present) {
    const { mode: expectedMode, ...leaseDetails } = leaseStatus;
    return Object.freeze({
      mode: 'unknown',
      expectedMode,
      ...leaseDetails,
      runtimeState: 'absent',
      reason: 'Native container is absent.',
      ...common,
    });
  }
  return Object.freeze({
    ...leaseStatus,
    runtimeState: runtime.running ? 'running' : 'stopped',
    runtimeVerified: true,
    ...common,
  });
}

export async function requestLocalElevationApproval({
  root,
  durationMs,
  execFileImpl = execFileAsync,
} = {}) {
  if (typeof root !== 'string' || root.length === 0 || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
    fail('Local elevation approval requires a selected root and bounded duration.', 'LOCAL_ELEVATION_APPROVAL_REQUIRED');
  }
  const durationMinutes = Math.ceil(durationMs / 60000);
  const script = [
    'set selectedRoot to system attribute "WEBMCP_ELEVATE_ROOT"',
    'set requestedDuration to system attribute "WEBMCP_ELEVATE_DURATION"',
    'try',
    '  set dialogResult to display dialog ("WebMCP requests TEMPORARY elevated filesystem access.\\n\\nRoot: " & selectedRoot & "\\nDuration: " & requestedDuration & "\\n\\nNetwork and Git publication are disabled while elevated. Approve only if you initiated this request locally.") buttons {"Cancel", "ELEVATE"} default button "Cancel" cancel button "Cancel" with icon caution giving up after 120',
    '  if gave up of dialogResult then return "TIMEOUT"',
    '  return button returned of dialogResult',
    'on error number -128',
    '  return "CANCEL"',
    'end try',
  ].join('\n');
  let stdout;
  try {
    ({ stdout } = await execFileImpl('/usr/bin/osascript', ['-e', script], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      env: {
        HOME: os.homedir(),
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        WEBMCP_ELEVATE_ROOT: root,
        WEBMCP_ELEVATE_DURATION: `${durationMinutes} minute${durationMinutes === 1 ? '' : 's'}`,
      },
    }));
  } catch (error) {
    fail('Local macOS approval dialog could not be completed.', 'LOCAL_ELEVATION_APPROVAL_REQUIRED', { cause: error });
  }
  if (String(stdout).trim() !== 'ELEVATE') {
    fail('Temporary elevated access was not approved in the local macOS session.', 'LOCAL_ELEVATION_APPROVAL_REQUIRED');
  }
}

export async function elevateWebMcp({
  root,
  durationMs = MAX_ELEVATED_LEASE_MS,
  home = os.homedir(),
  execFileImpl = execFileAsync,
  sleepImpl = defaultSleep,
} = {}) {
  await assertTrustedElevationControl({ home });
  if (!root) fail('elevate requires --root <path>.', 'WORKSPACE_ROOT_REQUIRED');

  const paths = installerPaths(home);
  const normalConfig = await loadWorkspaceConfig(paths.workspaceConfig, { platform: 'darwin' });
  const bootSessionId = await getBootSessionId({ platform: 'darwin', execFileImpl });
  const loginSessionId = await getLoginSessionId({ platform: 'darwin', execFileImpl });
  const currentLease = await loadElevatedLease(paths.elevatedLease, {
    normalConfig,
    bootSessionId,
    loginSessionId,
    now: Date.now(),
    platform: 'darwin',
  });
  if (currentLease.state === 'active') {
    fail('Temporary elevated access is already active. Revoke it locally before creating a new lease.', 'ELEVATION_ALREADY_ACTIVE');
  }
  if (currentLease.state !== 'absent') {
    fail('Stale or invalid elevated state must be cleared with elevate-stop before a new lease is granted.', 'ELEVATION_STATE_REQUIRES_REVOKE');
  }

  const current = await verifyInstalledLayout(paths, { execFileImpl });
  const selectedRoot = expandUserPath(root, home);
  const protectedPaths = await defaultProtectedPaths({
    home,
    configPath: paths.workspaceConfig,
    platform: 'darwin',
  });
  const probe = await verifyWorkspaceMount({
    hostRoot: selectedRoot,
    image: current.imagePin.image,
    protectedPaths: [...new Set([...protectedPaths, paths.imagePin])],
    platform: 'darwin',
  });
  await assertLaunchDependenciesOutsideWorkspace(probe.canonicalRoot, current.launchDependencies);

  const elevatedConfig = buildElevatedWorkspaceConfig(normalConfig, probe.canonicalRoot, { platform: 'darwin' });
  await requestLocalElevationApproval({ root: probe.canonicalRoot, durationMs });
  const approvedAt = Date.now();
  const lease = createElevatedLease({
    normalConfig,
    elevatedRoot: probe.canonicalRoot,
    bootSessionId,
    loginSessionId,
    durationMs,
    now: approvedAt,
    platform: 'darwin',
  });

  const normalContainerOptions = {
    configPath: paths.workspaceConfig,
    imagePinPath: paths.imagePin,
    platform: 'darwin',
    execFileImpl,
  };
  const elevatedContainerOptions = {
    ...normalContainerOptions,
    workspaceConfig: elevatedConfig,
    elevationLeaseId: lease.id,
  };

  await applyElevatedTransition({
    stopService: () => stopLaunchAgent(paths, execFileImpl, sleepImpl),
    removeNormalContainer: () => removeNativeContainer(normalContainerOptions),
    persistLease: () => persistElevatedLease(paths.elevatedLease, lease),
    ensureElevatedContainer: () => ensureNativeContainer(elevatedContainerOptions),
    startService: () => bootstrapLaunchAgent(paths, execFileImpl, sleepImpl),
    verifyElevated: () => verifyInstalledLayout(paths, {
      execFileImpl,
      workspaceConfig: elevatedConfig,
      elevationLeaseId: lease.id,
    }),
    clearLease: () => clearElevatedLease(paths.elevatedLease),
    removeElevatedContainer: () => removeStaleElevatedContainer({
      imagePinPath: paths.imagePin,
      expectedLeaseId: lease.id,
      execFileImpl,
    }),
    ensureNormalContainer: () => ensureNativeContainer(normalContainerOptions),
  });

  return Object.freeze({
    action: 'elevated',
    root: lease.elevatedRoot,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    networkEnabled: false,
    gitPublicationEnabled: false,
  });
}

export async function revokeElevationWebMcp({
  home = os.homedir(),
  execFileImpl = execFileAsync,
  sleepImpl = defaultSleep,
} = {}) {
  const paths = installerPaths(home);
  const normalConfig = await loadWorkspaceConfig(paths.workspaceConfig, { platform: 'darwin' });
  const container = await inspectNativeContainer({ execFileImpl });
  const leaseKind = await pathKind(paths.elevatedLease);
  const containerLeaseId = container?.Config?.Labels?.[NATIVE_ELEVATED_LEASE_LABEL] ?? null;
  const containerElevated = Boolean(containerLeaseId);
  if (leaseKind === 'absent' && !containerElevated) {
    return Object.freeze({ action: 'unchanged', mode: 'normal', root: normalConfig.hostRoot });
  }

  const normalContainerOptions = {
    configPath: paths.workspaceConfig,
    imagePinPath: paths.imagePin,
    platform: 'darwin',
    execFileImpl,
  };
  await applyElevationRevoke({
    stopService: () => stopLaunchAgent(paths, execFileImpl, sleepImpl),
    clearLease: () => clearElevatedLease(paths.elevatedLease),
    removeElevatedContainer: () => removeStaleElevatedContainer({
      imagePinPath: paths.imagePin,
      expectedLeaseId: containerLeaseId,
      execFileImpl,
    }),
    ensureNormalContainer: () => ensureNativeContainer(normalContainerOptions),
    startService: () => bootstrapLaunchAgent(paths, execFileImpl, sleepImpl),
  });
  await verifyInstalledLayout(paths, { execFileImpl });
  return Object.freeze({ action: 'revoked', mode: 'normal', root: normalConfig.hostRoot });
}

export async function uninstallWebMcp({
  home = os.homedir(),
  execFileImpl = execFileAsync,
  sleepImpl = defaultSleep,
} = {}) {
  const paths = installerPaths(home);
  const state = await inspectInstallation(paths, { execFileImpl });
  if (state.state === 'fresh') return Object.freeze({ action: 'unchanged' });
  if (!['installed', 'drift'].includes(state.state)) {
    fail(`Refusing to uninstall unsafe/partial WebMCP state: ${state.state}.`, 'UNSAFE_UNINSTALL_STATE');
  }

  // Recognize the installation before deleting anything. Readiness is not
  // required because uninstall must still work when the tunnel is temporarily down.
  await verifyInstalledLayout(paths, {
    execFileImpl,
    requireReady: false,
    requireLaunchd: false,
    requireContainer: false,
  });
  const tunnelHome = await stopLaunchAgent(paths, execFileImpl, sleepImpl);
  await execFileImpl(
    paths.tunnelClient,
    ['runtimes', 'rm', TUNNEL_ALIAS],
    tunnelExecOptions(paths, {}, tunnelHome),
  ).catch(() => {});
  await removeVerifiedContainer(paths, execFileImpl);

  await Promise.all(uninstallManagedPaths(paths).map((candidate) => rm(candidate, {
    recursive: candidate === paths.hostRuntimeRoot || candidate === paths.tunnelStateHome,
    force: true,
  })));
  return Object.freeze({
    action: 'uninstalled',
    preservedRuntimeKey: paths.runtimeKey,
    remoteTunnelPreserved: true,
    dockerImagePreserved: true,
  });
}

export function parseInstallerArgs(argv) {
  const command = argv[0];
  if (!['install', 'status', 'doctor', 'reconfigure', 'elevate', 'elevate-status', 'elevate-stop', 'uninstall', 'help', '--help', '-h'].includes(command)) {
    fail('Expected one command: install, status, doctor, reconfigure, elevate, elevate-status, elevate-stop, uninstall.', 'INVALID_INSTALLER_ARGUMENTS');
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) fail(`Missing value for ${arg}.`, 'INVALID_INSTALLER_ARGUMENTS');
      return argv[index];
    };
    if (arg === '--root') options.root = next();
    else if (arg === '--base-image') options.baseImage = next();
    else if (arg === '--tunnel-id') options.tunnelId = next();
    else if (arg === '--runtime-key-file') options.runtimeKeyFile = next();
    else if (arg === '--tunnel-client') options.tunnelClient = next();
    else if (arg === '--duration') options.duration = next();
    else fail(`Unknown option: ${arg}`, 'INVALID_INSTALLER_ARGUMENTS');
  }
  return Object.freeze({ command, options: Object.freeze(options) });
}

function usage() {
  return [
    'Base WebMCP installer (macOS)',
    '',
    '  node native/deploy/installer.js install --root ~/Projects --tunnel-id tunnel_<id> [--runtime-key-file <path>] [--tunnel-client <path>] [--base-image <node@sha256:digest>]',
    '  node native/deploy/installer.js status',
    '  node native/deploy/installer.js doctor',
    '  node native/deploy/installer.js reconfigure --root ~/Code',
    '  node ~/.local/share/webmcp/host-runtime/current/native/deploy/installer.js elevate --root ~/Documents [--duration 30m]',
    '  node ~/.local/share/webmcp/host-runtime/current/native/deploy/installer.js elevate-status',
    '  node ~/.local/share/webmcp/host-runtime/current/native/deploy/installer.js elevate-stop',
    '  node native/deploy/installer.js uninstall',
    '',
    `The reviewed Native base image defaults to ${DEFAULT_NATIVE_BASE_IMAGE}.`,
    'The runtime API key is prompted locally without echo when --runtime-key-file is omitted.',
    'Temporary elevated access requires an interactive local owner confirmation and is capped at 1 hour.',
    'The remote Secure MCP Tunnel and its OpenAI-side lifecycle remain owner-managed.',
  ].join('\n');
}

export function resolveElevationRootInput(explicitRoot, { isTTY = Boolean(process.stdin.isTTY) } = {}) {
  if (explicitRoot) return explicitRoot;
  if (!isTTY) {
    fail('elevate requires --root <path> when invoked without an interactive Terminal; final approval still requires the local macOS dialog.', 'WORKSPACE_ROOT_REQUIRED');
  }
  return null;
}

async function promptLine(question, defaultValue = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ''}: `);
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    fail('Interactive secret prompt requires a TTY; use --runtime-key-file instead.', 'RUNTIME_KEY_REQUIRED');
  }
  process.stderr.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let value = '';
  try {
    for await (const chunk of process.stdin) {
      for (const character of chunk) {
        if (character === '\u0003') throw new InstallerError('Cancelled.', 'CANCELLED');
        if (character === '\r' || character === '\n') {
          process.stderr.write('\n');
          return value;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return value;
}

async function main() {
  let parsed;
  try {
    parsed = parseInstallerArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (['help', '--help', '-h'].includes(parsed.command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  try {
    if (parsed.command === 'status') {
      const state = await inspectInstallation();
      process.stdout.write(`${JSON.stringify(publicInstallationStatus(state), null, 2)}\n`);
      if (!['fresh', 'installed'].includes(state.state)) process.exitCode = 1;
      return;
    }
    if (parsed.command === 'doctor') {
      const result = await doctorWebMcp();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (parsed.command === 'elevate-status') {
      await assertTrustedElevationControl();
      const result = await elevatedStatusWebMcp();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (parsed.command === 'elevate-stop') {
      await assertTrustedElevationControl();
      const result = await revokeElevationWebMcp();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (parsed.command === 'elevate') {
      const explicitRoot = resolveElevationRootInput(parsed.options.root);
      const root = explicitRoot ?? await promptLine('Elevated filesystem root');
      const durationText = parsed.options.duration ?? '60m';
      const durationMs = parseElevatedDuration(durationText);
      process.stderr.write([
        '',
        'TEMPORARY ELEVATED ACCESS',
        `Selected root: ${root}`,
        `Requested duration: ${durationText}`,
        'Maximum duration: 1 hour',
        'Network: disabled while elevated',
        'Git publication credentials: disabled while elevated',
        `Local kill: node ${JSON.stringify(installerPaths().ownerControlEntrypoint)} elevate-stop`,
        'This gives WebMCP writable access to the selected host scope until revoked or expired.',
        '',
      ].join('\n'));
      process.stderr.write('Final approval will appear as a local macOS dialog.\n');
      const result = await elevateWebMcp({ root, durationMs });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (parsed.command === 'uninstall') {
      const result = await uninstallWebMcp();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (parsed.command === 'reconfigure') {
      const root = parsed.options.root ?? (process.stdin.isTTY ? await promptLine('Workspace root', '~/Projects') : null);
      const result = await reconfigureWebMcp({ root });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    const root = parsed.options.root ?? (process.stdin.isTTY ? await promptLine('Workspace root', '~/Projects') : null);
    const tunnelId = parsed.options.tunnelId ?? (process.stdin.isTTY ? await promptLine('Secure MCP Tunnel ID') : null);
    const result = await installWebMcp({
      ...parsed.options,
      root,
      tunnelId,
      promptSecret: promptHidden,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write('Next owner action: connect the WebMCP App in ChatGPT, then call open_workspace("/workspace").\n');
  } catch (error) {
    const code = error instanceof InstallerError || error instanceof ElevatedAccessError
      ? error.code
      : 'UNEXPECTED_INSTALLER_ERROR';
    process.stderr.write(`WebMCP installer failed [${code}]: ${error.message}\n`);
    process.exitCode = 1;
  }
}

let isMain = false;
if (process.argv[1]) {
  try {
    isMain = await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    isMain = false;
  }
}
if (isMain) {
  await main();
}
