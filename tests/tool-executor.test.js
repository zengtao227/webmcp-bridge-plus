import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SafeToolExecutor,
  authorizeToolCall,
  collectPathCandidates,
} from '../gateway/tool-executor/index.js';

function fakeClient(result) {
  return {
    calls: [],
    async callToolRaw(name, args) {
      this.calls.push({ name, args });
      return typeof result === 'function' ? result(name, args) : result;
    },
  };
}

test('collects bounded path-like arguments including nested paths', () => {
  assert.deepEqual(
    collectPathCandidates({
      path: 'README.md',
      patch: { filePath: 'src/index.js' },
      options: { workingDirectory: 'tests' },
    }),
    ['README.md', 'src/index.js', 'tests'],
  );
});

test('blocks sensitive file paths before the MCP client is called', async () => {
  const client = fakeClient({ text: 'must not be reached', isError: false });
  const executor = new SafeToolExecutor({ client });

  const result = await executor.execute({
    id: 'call_1',
    name: 'read',
    arguments: { path: '.env' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PATH_BLOCKED');
  assert.equal(result.content, null);
  assert.equal(client.calls.length, 0);
});

test('blocks encoded and nested sensitive path candidates before execution', () => {
  const decision = authorizeToolCall({
    id: 'call_2',
    name: 'read',
    arguments: {
      request: {
        filePath: 'src/%2e%2e/.aws/credentials',
      },
    },
  });

  assert.equal(decision.allowed, false);
});

test('redacts MCP text before producing the model-safe envelope', async () => {
  const fakeSecret = 'FAKE_TEST_SECRET_DO_NOT_USE_123456789';
  const client = fakeClient({
    text: `API_KEY=${fakeSecret}\nstatus=ok`,
    isError: false,
  });
  const executor = new SafeToolExecutor({ client });

  const result = await executor.execute({
    id: 'call_3',
    name: 'read',
    arguments: { path: 'src/config.js' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.redacted, true);
  assert.equal(result.content.includes(fakeSecret), false);
  assert.match(result.content, /\[REDACTED\]/);
  assert.equal(JSON.stringify(result).includes(fakeSecret), false);
  assert.equal(client.calls.length, 1);
});

test('sanitizes MCP tool error text instead of forwarding a raw error result', async () => {
  const fakeSecret = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';
  const client = fakeClient({
    text: `remote error token=${fakeSecret}`,
    isError: true,
  });
  const executor = new SafeToolExecutor({ client });

  const result = await executor.execute({
    id: 'call_4',
    name: 'bash',
    arguments: { workingDirectory: 'src', command: 'false' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MCP_TOOL_ERROR');
  assert.equal(result.content.includes(fakeSecret), false);
});

test('tool calls without path fields still pass through content Secret Firewall', async () => {
  const client = fakeClient({ text: 'harmless output', isError: false });
  const executor = new SafeToolExecutor({ client });

  const result = await executor.execute({
    id: 'call_5',
    name: 'git.status',
    arguments: {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.content, 'harmless output');
  assert.equal(client.calls.length, 1);
});
