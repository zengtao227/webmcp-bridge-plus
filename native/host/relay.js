import { spawn } from 'node:child_process';
import { sanitizeJsonRpcEnvelope, sanitizeLogText } from './firewall.js';
import { buildHostErrorResponse, createRequestLedger } from './request-ledger.js';

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_LOG_RECORD_BYTES = 64 * 1024;
const PRIVATE_KEY_MARKER = /-----(BEGIN|END) ((?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY)-----/gi;
const PRIVATE_KEY_MARKER_TAIL_BYTES = 64;
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
  const ledger = createRequestLedger();
  let buffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let stderrMarkerTail = '';
  let stderrOversized = false;
  let privateKeyLabel = null;
  let stderrRecordPrivate = false;
  let stderrRecordPrivateBegin = false;
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

  // An unanswered request is indistinguishable from a slow one: tunnel-client
  // holds it until its own deadline and then drops it without posting a response,
  // which the Web UI shows as a turn that never ends. Fail-closed still terminates
  // the host process; it just refuses the outstanding requests first.
  function refuseOutstanding(reason) {
    const ids = ledger.drain();
    if (ids.length === 0) {
      return;
    }
    const message = `Native WebMCP host boundary failed closed: ${reason}`;
    for (const id of ids) {
      try {
        writeLine(stdout, buildHostErrorResponse(id, message));
      } catch {
        writeDiagnostic('Unable to refuse an outstanding request before failing closed.');
      }
    }
  }

  function failClosed(reason) {
    if (failed || closed) {
      return;
    }
    failed = true;
    writeDiagnostic(reason);
    refuseOutstanding(reason);
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
      return;
    }
    ledger.settle(parsed?.id);
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

  function scanPrivateKeyMarkers(segment) {
    const probe = `${stderrMarkerTail}${segment.toString('utf8')}`;
    PRIVATE_KEY_MARKER.lastIndex = 0;
    for (let match = PRIVATE_KEY_MARKER.exec(probe); match; match = PRIVATE_KEY_MARKER.exec(probe)) {
      const kind = match[1].toUpperCase();
      const label = match[2].toUpperCase();
      if (kind === 'BEGIN' && privateKeyLabel === null) {
        privateKeyLabel = label;
        stderrRecordPrivate = true;
        stderrRecordPrivateBegin = true;
      } else if (kind === 'END' && privateKeyLabel === label) {
        stderrRecordPrivate = true;
        privateKeyLabel = null;
      }
    }
    stderrMarkerTail = probe.slice(-PRIVATE_KEY_MARKER_TAIL_BYTES);
  }

  function finishStderrRecord({ newline = true } = {}) {
    if (stderrOversized) {
      stderr.write(`[REDACTED:HOST_LOG_RECORD_TOO_LARGE]${newline ? '\n' : ''}`);
    } else if (stderrRecordPrivate) {
      if (stderrRecordPrivateBegin) {
        stderr.write(`[REDACTED:PRIVATE_KEY]${newline ? '\n' : ''}`);
      }
    } else if (stderrBuffer.byteLength > 0) {
      try {
        stderr.write(sanitizeLogText(stderrBuffer.toString('utf8')));
        if (newline) stderr.write('\n');
      } catch {
        stderr.write('[REDACTED:HOST_FIREWALL_LOG_FAILURE]\n');
      }
    } else if (newline) {
      stderr.write('\n');
    }

    stderrBuffer = Buffer.alloc(0);
    stderrMarkerTail = '';
    stderrOversized = false;
    stderrRecordPrivate = privateKeyLabel !== null;
    stderrRecordPrivateBegin = false;
  }

  function onChildStderr(chunk) {
    if (closed) {
      return;
    }
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    let offset = 0;

    while (offset < piece.byteLength) {
      const newline = piece.indexOf(0x0a, offset);
      const end = newline === -1 ? piece.byteLength : newline;
      const segment = piece.subarray(offset, end);

      if (privateKeyLabel !== null) {
        stderrRecordPrivate = true;
      }
      scanPrivateKeyMarkers(segment);

      if (!stderrOversized) {
        if (stderrBuffer.byteLength + segment.byteLength > MAX_LOG_RECORD_BYTES) {
          stderrBuffer = Buffer.alloc(0);
          stderrOversized = true;
        } else if (segment.byteLength > 0) {
          stderrBuffer = Buffer.concat([stderrBuffer, segment]);
        }
      }

      if (newline === -1) {
        return;
      }
      finishStderrRecord();
      offset = newline + 1;
    }
  }

  function flushChildStderr() {
    if (
      stderrOversized
      || stderrBuffer.byteLength > 0
      || stderrRecordPrivate
      || stderrRecordPrivateBegin
    ) {
      finishStderrRecord({ newline: false });
    }
  }

  function onStdinData(chunk) {
    if (closed || failed || deadlineTriggered) {
      return;
    }
    if (deadlineAt !== null && Date.now() >= deadlineAt) {
      deadlineTriggered = true;
      stdin.pause();
      // The chunk is never forwarded, so its requests can only be answered here.
      ledger.observe(chunk);
      refuseOutstanding('temporary elevated access expired');
      onDeadline();
      return;
    }
    ledger.observe(chunk);
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
      child.stderr.on('end', flushChildStderr);
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
