import { spawn } from 'node:child_process';
import { sanitizeJsonRpcEnvelope, sanitizeLogText } from './firewall.js';

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONTAINER = 'webmcp-native';
const DEFAULT_ENTRYPOINT = '/opt/webmcp/native/bin/start.js';

function writeLine(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function nativeDockerExecCommand({
  containerName = DEFAULT_CONTAINER,
  entrypoint = DEFAULT_ENTRYPOINT,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerName)) {
    throw new Error('Invalid Native container name.');
  }
  if (typeof entrypoint !== 'string' || !entrypoint.startsWith('/') || entrypoint.includes('\0')) {
    throw new Error('Invalid Native entrypoint.');
  }
  return ['docker', 'exec', '-i', containerName, 'node', entrypoint];
}

export function createHostRelay({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  spawnImpl = spawn,
  command = nativeDockerExecCommand(),
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  deadlineAt = null,
  onDeadline = null,
} = {}) {
  if (!Array.isArray(command) || command.length < 2 || command.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new Error('Host relay command must be a non-empty argv array.');
  }
  if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0 || typeof onDeadline !== 'function')) {
    throw new Error('Host relay deadline requires a positive timestamp and revocation callback.');
  }

  let child = null;
  let buffer = Buffer.alloc(0);
  let closed = false;
  let failed = false;
  let stdinEnded = false;
  let deadlineTriggered = false;

  function writeDiagnostic(reason) {
    try {
      stderr.write(sanitizeLogText(`${reason}\n`));
    } catch {
      stderr.write('[REDACTED:HOST_FIREWALL_LOG_FAILURE]\n');
    }
  }

  function failClosed(reason) {
    if (failed || closed) {
      return;
    }
    failed = true;
    writeDiagnostic(reason);
    process.exitCode = 1;
    stdin.pause();
    stdin.unref?.();
    child?.kill('SIGKILL');
  }

  function processResponseLine(lineBytes) {
    if (lineBytes.byteLength > maxResponseBytes) {
      failClosed('Native runtime response exceeded the host boundary limit.');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(lineBytes.toString('utf8'));
    } catch {
      failClosed('Native runtime returned malformed JSON.');
      return;
    }

    try {
      writeLine(stdout, sanitizeJsonRpcEnvelope(parsed));
    } catch {
      failClosed('Native runtime response was blocked by host policy.');
    }
  }

  function onChildStdout(chunk) {
    if (failed || closed) {
      return;
    }
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.byteLength > 0) {
        processResponseLine(line);
      }
      if (failed) {
        return;
      }
      newline = buffer.indexOf(0x0a);
    }
    if (buffer.byteLength > maxResponseBytes) {
      failClosed('Native runtime response exceeded the host boundary limit.');
    }
  }

  function onChildStderr(chunk) {
    if (closed) {
      return;
    }
    try {
      stderr.write(sanitizeLogText(chunk.toString('utf8')));
    } catch {
      stderr.write('[REDACTED:HOST_FIREWALL_LOG_FAILURE]\n');
    }
  }

  function onStdinData(chunk) {
    if (closed || failed || deadlineTriggered) {
      return;
    }
    if (deadlineAt !== null && Date.now() >= deadlineAt) {
      deadlineTriggered = true;
      stdin.pause();
      onDeadline();
      return;
    }
    child.stdin.write(chunk);
  }

  function onStdinEnd() {
    if (closed) return;
    stdinEnded = true;
    child.stdin.end();
  }

  return {
    start() {
      child = spawnImpl(command[0], command.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      child.stdout.on('data', onChildStdout);
      child.stderr.on('data', onChildStderr);
      child.on('error', () => failClosed('Unable to start the Native runtime container process.'));
      child.on('exit', (code, signal) => {
        if (closed || failed) {
          return;
        }
        if (code !== 0 || !stdinEnded) {
          failClosed(`Native runtime exited unexpectedly (${signal ?? code ?? 'unknown'}).`);
        }
      });

      // Request bytes remain opaque to the host boundary. Elevated mode adds
      // only an absolute pre-forward deadline gate; request parsing and tool
      // semantics remain inside the verified Native container.
      stdin.on('data', onStdinData);
      stdin.on('end', onStdinEnd);
      stdin.resume?.();

      return {
        close: async () => {
          closed = true;
          stdin.off('data', onStdinData);
          stdin.off('end', onStdinEnd);
          stdin.pause();
          child?.kill('SIGTERM');
        },
      };
    },
  };
}
