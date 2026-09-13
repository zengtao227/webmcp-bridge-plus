import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHostRelay, nativeDockerExecCommand } from '../native/host/relay.js';

const FAKE_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz123456';

test.afterEach(() => {
  process.exitCode = undefined;
});

function createFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedWith = null;
  child.kill = (signal) => {
    child.killedWith = signal;
    return true;
  };
  return child;
}

function createHarness(options = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = createFakeChild();
  let stdoutText = '';
  let stderrText = '';
  stdout.on('data', (chunk) => { stdoutText += chunk.toString('utf8'); });
  stderr.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });

  const relay = createHostRelay({
    stdin,
    stdout,
    stderr,
    spawnImpl: () => child,
    command: ['docker', 'exec', '-i', 'webmcp-native', 'node', '/opt/webmcp/native/bin/start.js'],
    ...options,
  });
  const handle = relay.start();

  return {
    stdin,
    child,
    handle,
    stdout: () => stdoutText,
    stderr: () => stderrText,
  };
}

test('host relay command is a fixed docker exec argv, not a shell string', () => {
  assert.deepEqual(nativeDockerExecCommand(), [
    'docker',
    'exec',
    '-i',
    'webmcp-native',
    'node',
    '/opt/webmcp/native/bin/start.js',
  ]);
  assert.throws(() => nativeDockerExecCommand({ containerName: 'bad name' }), /Invalid Native container name/);
});

test('closing the host relay immediately terminates the active container executor', async () => {
  const harness = createHarness();
  await harness.handle.close();
  assert.equal(harness.child.killedWith, 'SIGTERM');
});

test('a closed relay can be replaced on the same tunnel streams for normal-mode fallback', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const firstChild = createFakeChild();
  const secondChild = createFakeChild();
  const children = [firstChild, secondChild];
  const forwarded = ['', ''];
  firstChild.stdin.on('data', (chunk) => { forwarded[0] += chunk.toString('utf8'); });
  secondChild.stdin.on('data', (chunk) => { forwarded[1] += chunk.toString('utf8'); });
  const options = {
    stdin,
    stdout,
    stderr,
    command: ['docker', 'exec', '-i', 'webmcp-native', 'node', '/opt/webmcp/native/bin/start.js'],
  };
  const first = createHostRelay({ ...options, spawnImpl: () => children.shift() }).start();
  await first.close();
  const second = createHostRelay({ ...options, spawnImpl: () => children.shift() }).start();
  try {
    const request = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`;
    stdin.write(request);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forwarded[0], '');
    assert.equal(forwarded[1], request);
  } finally {
    await second.close();
  }
});

test('host relay forwards requests as opaque bytes', async () => {
  const harness = createHarness();
  let forwarded = '';
  harness.child.stdin.on('data', (chunk) => { forwarded += chunk.toString('utf8'); });
  try {
    const request = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read', arguments: { path: '../whatever' } },
    })}\n`;
    harness.stdin.write(request);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forwarded, request);
  } finally {
    await harness.handle.close();
  }
});

test('host relay blocks new input at the absolute deadline without parsing request bytes', async () => {
  let deadlineCalls = 0;
  const harness = createHarness({
    deadlineAt: Date.now() - 1,
    onDeadline: () => { deadlineCalls += 1; },
  });
  let forwarded = '';
  harness.child.stdin.on('data', (chunk) => { forwarded += chunk.toString('utf8'); });
  try {
    const wire = 'not-json-and-must-remain-opaque\n';
    harness.stdin.write(wire);
    harness.stdin.write('second-chunk\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forwarded, '');
    assert.equal(deadlineCalls, 1);
  } finally {
    await harness.handle.close();
  }
});

test('host relay sanitizes container JSON-RPC before forwarding it to the tunnel', async () => {
  const harness = createHarness();
  try {
    harness.child.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: `token=${FAKE_TOKEN}` }] },
    })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(harness.stdout(), new RegExp(FAKE_TOKEN));
    assert.match(harness.stdout(), /REDACTED/);
  } finally {
    await harness.handle.close();
  }
});

test('host relay sanitizes child stderr before writing host logs', async () => {
  const harness = createHarness();
  try {
    harness.child.stderr.write(`Authorization: Bearer ${FAKE_TOKEN}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(harness.stderr(), new RegExp(FAKE_TOKEN));
    assert.match(harness.stderr(), /REDACTED/);
  } finally {
    await harness.handle.close();
  }
});

test('host relay redacts secrets split across stderr chunks', async () => {
  const harness = createHarness();
  try {
    harness.child.stderr.write('API_KEY=');
    harness.child.stderr.write('FAKE_REVIEW_VALUE\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(harness.stderr(), /FAKE_REVIEW_VALUE/);
    assert.match(harness.stderr(), /REDACTED/);
  } finally {
    await harness.handle.close();
  }
});

test('host relay drops multiline private keys and resumes after the matching END marker', async () => {
  const harness = createHarness();
  try {
    harness.child.stderr.write([
      'before',
      '-----BEGIN PRIVATE KEY-----',
      'FAKE_PRIVATE_KEY_BODY',
      '-----END PRIVATE KEY-----',
      'after',
      '',
    ].join('\n'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.stderr(), 'before\n[REDACTED:PRIVATE_KEY]\nafter\n');
  } finally {
    await harness.handle.close();
  }
});

test('host relay never flushes an unterminated private-key block as raw stderr', async () => {
  const harness = createHarness();
  try {
    harness.child.stderr.write('-----BEGIN PRIVATE KEY-----\nFAKE_UNTERMINATED_BODY');
    harness.child.stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.stderr(), '[REDACTED:PRIVATE_KEY]\n');
  } finally {
    await harness.handle.close();
  }
});

test('host relay limits complete and split oversized stderr records and then recovers', async () => {
  for (const chunks of [
    [`${'x'.repeat(65_537)}\nnormal\n`],
    ['x'.repeat(65_536), 'x\nnormal\n'],
  ]) {
    const harness = createHarness();
    try {
      for (const chunk of chunks) harness.child.stderr.write(chunk);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(harness.stderr(), '[REDACTED:HOST_LOG_RECORD_TOO_LARGE]\nnormal\n');
    } finally {
      await harness.handle.close();
    }
  }
});

test('oversized stderr preserves private-key state regardless of marker position or chunking', async () => {
  const payloads = [
    `${'x'.repeat(65_537)}-----BEGIN PRIVATE KEY-----\nFAKE_REVIEW_BODY\n-----END PRIVATE KEY-----\nafter\n`,
    `${'x'.repeat(65_500)}-----BEGIN PRIVATE KEY-----${'y'.repeat(80)}\nFAKE_REVIEW_BODY\n-----END PRIVATE KEY-----\nafter\n`,
    `${'x'.repeat(65_525)}-----BEGIN PRIVATE KEY-----\nFAKE_REVIEW_BODY\n-----END PRIVATE KEY-----\nafter\n`,
  ];

  for (const payload of payloads) {
    for (const chunkSize of [payload.length, 65_536, 997, 17]) {
      const harness = createHarness();
      try {
        for (let offset = 0; offset < payload.length; offset += chunkSize) {
          harness.child.stderr.write(payload.slice(offset, offset + chunkSize));
        }
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          harness.stderr(),
          '[REDACTED:HOST_LOG_RECORD_TOO_LARGE]\nafter\n',
          `chunkSize=${chunkSize}`,
        );
      } finally {
        await harness.handle.close();
      }
    }
  }
});

test('oversized stderr recovers when BEGIN and END are both inside the discarded record', async () => {
  const harness = createHarness();
  try {
    harness.child.stderr.write(`${'x'.repeat(65_537)}-----BEGIN PRIVATE KEY-----FAKE_BODY-----END PRIVATE KEY-----\nafter\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.stderr(), '[REDACTED:HOST_LOG_RECORD_TOO_LARGE]\nafter\n');
  } finally {
    await harness.handle.close();
  }
});

test('oversized stderr with an unterminated private key remains fail closed through EOF', async () => {
  const harness = createHarness();
  try {
    harness.child.stderr.write(`${'x'.repeat(65_537)}-----BEGIN PRIVATE KEY-----\nFAKE_UNTERMINATED_AFTER_OVERSIZE`);
    harness.child.stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.stderr(), '[REDACTED:HOST_LOG_RECORD_TOO_LARGE]\n');
  } finally {
    await harness.handle.close();
  }
});

test('host relay fails process-level on malformed or oversized container output', async () => {
  const malformed = createHarness();
  try {
    malformed.child.stdout.write('not-json\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(malformed.stdout(), '');
    assert.match(malformed.stderr(), /malformed JSON/);
    assert.equal(malformed.child.killedWith, 'SIGKILL');
    assert.equal(process.exitCode, 1);
  } finally {
    await malformed.handle.close();
  }

  process.exitCode = undefined;
  const oversized = createHarness({ maxResponseBytes: 200 });
  try {
    oversized.child.stdout.write(`${'x'.repeat(250)}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oversized.stdout(), '');
    assert.match(oversized.stderr(), /exceeded the host boundary limit/);
    assert.equal(oversized.child.killedWith, 'SIGKILL');
    assert.equal(process.exitCode, 1);
  } finally {
    await oversized.handle.close();
  }
});

test('host relay treats child startup and unexpected exit as transport failure', async () => {
  const failedStart = createHarness();
  try {
    failedStart.child.emit('error', new Error('spawn failed'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(failedStart.stderr(), /Unable to start the Native runtime container process/);
    assert.equal(process.exitCode, 1);
  } finally {
    await failedStart.handle.close();
  }

  process.exitCode = undefined;
  const failedExit = createHarness();
  try {
    failedExit.child.emit('exit', 126, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(failedExit.stderr(), /Native runtime exited unexpectedly \(126\)/);
    assert.equal(process.exitCode, 1);
  } finally {
    await failedExit.handle.close();
  }
});

test('host relay exits non-zero after child failure even while tunnel stdin stays open', async () => {
  const relayUrl = new URL('../native/host/relay.js', import.meta.url).href;
  const program = `
    import { createHostRelay } from ${JSON.stringify(relayUrl)};
    createHostRelay({
      command: [process.execPath, '-e', 'process.stderr.write("boom\\\\n"); process.exit(3)'],
    }).start();
  `;
  const host = spawn(process.execPath, ['--input-type=module', '--eval', program], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  host.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      host.kill('SIGKILL');
      reject(new Error('host relay did not terminate after child failure'));
    }, 2000);
    host.on('error', reject);
    host.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(result, { code: 1, signal: null });
  assert.match(stderr, /boom/);
  assert.match(stderr, /Native runtime exited unexpectedly \(3\)/);
});
