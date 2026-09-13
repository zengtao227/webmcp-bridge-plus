import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

export class FreshUserAcceptanceError extends Error {
  constructor(message, code = 'FRESH_USER_ACCEPTANCE_FAILED') {
    super(message);
    this.name = 'FreshUserAcceptanceError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new FreshUserAcceptanceError(message, code);
}

export function parseFreshUserAcceptanceArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return Object.freeze({ help: true });
  }

  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) fail(`Missing value for ${arg}.`, 'INVALID_ACCEPTANCE_ARGUMENTS');
      return argv[index];
    };

    if (arg === '--root') options.root = next();
    else if (arg === '--tunnel-id') options.tunnelId = next();
    else if (arg === '--runtime-key-file') options.runtimeKeyFile = next();
    else if (arg === '--tunnel-client') options.tunnelClient = next();
    else fail(`Unknown option: ${arg}`, 'INVALID_ACCEPTANCE_ARGUMENTS');
  }

  for (const [key, flag] of [
    ['root', '--root'],
    ['tunnelId', '--tunnel-id'],
    ['runtimeKeyFile', '--runtime-key-file'],
  ]) {
    if (!options[key]) fail(`Fresh-user acceptance requires ${flag}.`, 'INVALID_ACCEPTANCE_ARGUMENTS');
  }

  return Object.freeze({ help: false, ...options });
}

function usage() {
  return [
    'Fresh-user Base WebMCP acceptance (macOS only)',
    '',
    '  npm run validate:fresh-user -- \\',
    '    --root "$HOME/Projects" \\',
    "    --tunnel-id 'tunnel_<32-lowercase-hex>' \\",
    "    --runtime-key-file '/absolute/path/to/runtime-api-key' \\",
    "    [--tunnel-client '/absolute/path/to/tunnel-client']",
    '',
    'This harness refuses to run unless the existing Base installer reports state=fresh.',
    'It delegates all installation policy to the existing installer, then runs doctor and status.',
    'It never uninstalls an existing deployment and never automates the final ChatGPT App connection.',
  ].join('\n');
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    fail(`${label} did not return valid JSON.`, 'INVALID_ACCEPTANCE_OUTPUT');
  }
}

export async function runFreshUserAcceptance({
  root,
  tunnelId,
  runtimeKeyFile,
  tunnelClient,
  platform = process.platform,
  repoRoot = DEFAULT_REPO_ROOT,
  nodeBin = process.execPath,
  execFileImpl = execFileAsync,
  realpathImpl = realpath,
} = {}) {
  if (platform !== 'darwin') {
    fail('Fresh-user acceptance must run from the target macOS user session.', 'UNSUPPORTED_PLATFORM');
  }
  if (!root || !tunnelId || !runtimeKeyFile) {
    fail('Fresh-user acceptance requires root, tunnel ID, and runtime-key file.', 'INVALID_ACCEPTANCE_ARGUMENTS');
  }

  const installer = path.join(repoRoot, 'native', 'deploy', 'installer.js');
  const canonicalRoot = await realpathImpl(root);
  const canonicalRuntimeKeyFile = await realpathImpl(runtimeKeyFile);
  const canonicalTunnelClient = tunnelClient ? await realpathImpl(tunnelClient) : null;

  const runInstaller = async (args) => execFileImpl(nodeBin, [installer, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  const preflight = parseJson((await runInstaller(['status'])).stdout, 'Pre-install status');
  if (preflight.state !== 'fresh') {
    fail(
      `Refusing fresh-user validation because Base installer state is ${preflight.state}. Use a genuinely fresh macOS user or Mac.`,
      'NOT_FRESH_INSTALLATION',
    );
  }

  const installArgs = [
    'install',
    '--root', canonicalRoot,
    '--tunnel-id', tunnelId,
    '--runtime-key-file', canonicalRuntimeKeyFile,
  ];
  if (canonicalTunnelClient) installArgs.push('--tunnel-client', canonicalTunnelClient);

  await runInstaller(installArgs);

  const doctor = parseJson((await runInstaller(['doctor'])).stdout, 'Doctor');
  if (doctor.state !== 'installed' || doctor.tunnelReady !== true || doctor.containerRunning !== true) {
    fail('Doctor did not report a healthy installed Native runtime.', 'DOCTOR_NOT_HEALTHY');
  }

  const finalStatus = parseJson((await runInstaller(['status'])).stdout, 'Post-install status');
  if (finalStatus.state !== 'installed') {
    fail(`Post-install status is ${finalStatus.state}, expected installed.`, 'POST_INSTALL_NOT_HEALTHY');
  }
  if (finalStatus.root !== doctor.root) {
    fail('Doctor and post-install status disagree on the workspace root.', 'POST_INSTALL_ROOT_MISMATCH');
  }

  return Object.freeze({
    state: 'local-acceptance-passed',
    root: finalStatus.root,
    mode: finalStatus.mode,
    containerRunning: finalStatus.containerRunning,
    launchAgentLoaded: finalStatus.launchAgentLoaded,
    tunnelReady: finalStatus.tunnelReady,
    hostArtifactId: finalStatus.hostArtifactId,
    nextOwnerAction: 'Connect/authorize the WebMCP App in ChatGPT, then call open_workspace("/workspace").',
  });
}

async function main() {
  try {
    const parsed = parseFreshUserAcceptanceArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }

    const result = await runFreshUserAcceptance(parsed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof FreshUserAcceptanceError ? error.code : 'UNEXPECTED_ACCEPTANCE_ERROR';
    process.stderr.write(`Fresh-user acceptance failed [${code}]: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
