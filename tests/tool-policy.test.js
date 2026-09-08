import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeToolRequest,
  sanitizeToolResult,
  ToolPolicyError,
} from '../gateway/tool-policy/index.js';

test('denies a blocked path before result forwarding', () => {
  const decision = sanitizeToolResult({
    requestedPath: 'config/.env',
    text: 'THIS_FAKE_VALUE_MUST_NEVER_BE_FORWARDED',
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'blocked_sensitive_filename');
  assert.equal(decision.text, null);
  assert.deepEqual(decision.redactions, []);
});

test('allows harmless path requests', () => {
  const decision = authorizeToolRequest({ requestedPath: 'src/index.js' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.normalizedPath, 'src/index.js');
});

test('sanitizes an allowed tool result before model forwarding', () => {
  const fakeSecret = 'FAKE-PASSWORD-1234567890';
  const decision = sanitizeToolResult({
    requestedPath: 'src/config.js',
    text: `PASSWORD="${fakeSecret}"\nmode="test"`,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'allowed_with_redaction');
  assert.equal(decision.text.includes(fakeSecret), false);
  assert.match(decision.text, /PASSWORD="\[REDACTED\]"/);
});

test('fails closed for unsupported raw result types', () => {
  assert.throws(
    () => sanitizeToolResult({ text: { unsafe: 'raw-object' } }),
    (error) => error instanceof ToolPolicyError && error.code === 'unsupported_result_type',
  );
});

test('wraps scanner configuration failures as fail-closed tool policy errors', () => {
  assert.throws(
    () => sanitizeToolResult({
      text: 'safe-looking text',
      customPatterns: [{ name: 'broken', source: '[' }],
    }),
    (error) => error instanceof ToolPolicyError && error.code === 'secret_firewall_failure',
  );
});

test('tool requests without a filesystem path can still pass through content policy', () => {
  const fakeToken = 'ghp_FAKEFAKEFAKEFAKEFAKE1234';
  const decision = sanitizeToolResult({ text: `result=${fakeToken}` });

  assert.equal(decision.allowed, true);
  assert.equal(decision.normalizedPath, null);
  assert.equal(decision.text.includes(fakeToken), false);
});
