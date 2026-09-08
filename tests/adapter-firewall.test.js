// CONTEXT.md 5.5 is a hard constraint: tool output must pass policy before it
// reaches the model. These tests pin that down for the DevSpace adapter: even an
// approved project root can still contain a private key.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeRequest,
  deniedToolResult,
  extractRequestedPath,
  extractRequestedPaths,
  firewallResponse,
} from '../adapter/src/firewall.js';

function toolCall(arguments_) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: arguments_ } };
}

test('finds the requested path under every name DevSpace tools use', () => {
  for (const key of [
    'path', 'filePath', 'file_path', 'file', 'target', 'cwd', 'dir', 'workingDirectory',
  ]) {
    assert.equal(
      extractRequestedPath(toolCall({ [key]: '/work/app/main.js' })),
      '/work/app/main.js',
      `expected ${key} to be recognised`,
    );
  }
});

test('checks every path candidate instead of trusting the first one', () => {
  const payload = toolCall({
    path: '/work/app/README.md',
    nested: { file_path: '/work/app/.env.production' },
  });
  assert.deepEqual(
    extractRequestedPaths(payload),
    ['/work/app/README.md', '/work/app/.env.production'],
  );
  const decision = authorizeRequest(payload);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'blocked_sensitive_filename');
});

test('fails closed for malformed, missing, or oversized path arguments', () => {
  for (const payload of [
    toolCall({ path: 42 }),
    toolCall({ path: 'x'.repeat(4097) }),
    toolCall({}),
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: null } },
  ]) {
    const decision = authorizeRequest(payload);
    assert.equal(decision.allowed, false);
  }
});

test('allows only the reviewed DevSpace tool set and requires a request id', () => {
  const unknown = authorizeRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'future_admin_tool', arguments: {} },
  });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.reason, 'tool_not_allowed');

  const notification = authorizeRequest({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'bash', arguments: { command: 'pwd' } },
  });
  assert.equal(notification.allowed, false);
  assert.equal(notification.reason, 'invalid_request_id');
});

test('ignores paths outside tools/call, so discovery is never blocked', () => {
  assert.equal(extractRequestedPath({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), undefined);
  assert.equal(extractRequestedPath({ jsonrpc: '2.0', id: 1, method: 'initialize' }), undefined);
  assert.equal(extractRequestedPath(toolCall({})), undefined);
});

test('denies credential paths before DevSpace is asked for them', () => {
  for (const requestedPath of [
    '/Users/zengtao/.ssh/id_ed25519',
    '/Users/zengtao/.aws/credentials',
    '/work/app/.env',
    '/work/app/.env.production',
    '/work/deploy/server.pem',
    '/../../etc/shadow',
  ]) {
    const decision = authorizeRequest(toolCall({ path: requestedPath }));
    assert.equal(decision.allowed, false, `expected ${requestedPath} to be denied`);
    assert.ok(decision.reason);
  }
});

test('allows ordinary project paths', () => {
  for (const requestedPath of ['/work/app/main.js', '/work', '/work/README.md']) {
    const decision = authorizeRequest(toolCall({ path: requestedPath }));
    assert.equal(decision.allowed, true, `expected ${requestedPath} to be allowed`);
    assert.equal(decision.requestedPath, requestedPath);
  }
});

test('redacts credential-looking text inside a tool result', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const result = firewallResponse({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: `aws_key = "${secret}"` }] },
  }, '/work/app/config.yaml');

  assert.equal(result.redacted, 1);
  assert.ok(!JSON.stringify(result.payload).includes(secret));
  assert.match(result.payload.result.content[0].text, /\[REDACTED\]/);
});

test('replaces the whole text block when the path itself is forbidden', () => {
  const result = firewallResponse({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'PRIVATE KEY MATERIAL' }] },
  }, '/Users/zengtao/.ssh/id_ed25519');

  assert.equal(result.blocked, 1);
  assert.match(result.payload.result.content[0].text, /blocked by Secret Firewall/);
});

test('walks nested content, because tools do not all shape results the same way', () => {
  const result = firewallResponse({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: 'password: "hunter2secretvalue"' }],
      structuredContent: { nested: [{ type: 'text', text: 'token = "abcdefghijklmnop"' }] },
    },
  }, '/work/app/config.yaml');

  assert.ok(result.redacted >= 2, `expected at least 2 redactions, got ${result.redacted}`);
});

test('leaves safe non-text payloads untouched', () => {
  const payload = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'read' }] } };
  const result = firewallResponse(payload, null);
  assert.deepEqual(result.payload, payload);
  assert.equal(result.redacted, 0);
  assert.equal(result.blocked, 0);
});

test('redacts secrets in structuredContent and error data, not only text blocks', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  const result = firewallResponse({
    jsonrpc: '2.0',
    id: 1,
    result: { structuredContent: { api_key: secret } },
    error: { data: { authorization: `Bearer ${secret}` } },
  });

  const serialized = JSON.stringify(result.payload);
  assert.ok(!serialized.includes(secret));
  assert.match(serialized, /REDACTED/);
  assert.ok(result.redacted >= 1);
});

test('the denied result is a JSON-RPC error the caller can surface', () => {
  const denied = deniedToolResult(7, 'blocked_sensitive_filename');
  assert.equal(denied.id, 7);
  assert.equal(denied.error.code, -32001);
  assert.match(denied.error.message, /blocked_sensitive_filename/);
});
