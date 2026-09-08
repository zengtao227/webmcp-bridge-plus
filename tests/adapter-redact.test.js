import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, createLogger } from '../adapter/src/redact.js';

const OWNER = 'owner-token-abcdefghijklmnop';
const ACCESS = 'access-token-qrstuvwxyz123456';

test('removes known secret literals from text', () => {
  const redactor = createRedactor([OWNER, ACCESS]);
  const output = redactor.redact(`owner=${OWNER} access=${ACCESS}`);
  assert.equal(output, 'owner=[redacted] access=[redacted]');
  assert.ok(!output.includes(OWNER));
  assert.ok(!output.includes(ACCESS));
});

test('removes bearer credentials', () => {
  const output = createRedactor().redact('authorization: Bearer abcDEF123456-_');
  assert.ok(!output.includes('abcDEF123456'));
  assert.match(output, /Bearer \[redacted\]/);
});

test('removes JWT-like tokens', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const output = createRedactor().redact(`token=${jwt}`);
  assert.ok(!output.includes(jwt));
  assert.ok(output.includes('[redacted-jwt]'));
});

test('removes named secret fields in serialized JSON', () => {
  const payload = JSON.stringify({
    access_token: ACCESS,
    refresh_token: 'rt-9999999999',
    nested: { ownerToken: OWNER },
    keep: 'visible',
  });
  const output = createRedactor([OWNER]).redact(payload);
  assert.ok(!output.includes(ACCESS));
  assert.ok(!output.includes('rt-9999999999'));
  assert.ok(!output.includes(OWNER));
  assert.ok(output.includes('visible'));
});

test('ignores short literals that would cause excessive false redaction', () => {
  const output = createRedactor(['short']).redact('a short word');
  assert.equal(output, 'a short word');
});

test('addSecret extends the redaction set at runtime', () => {
  const redactor = createRedactor();
  assert.ok(redactor.redact(ACCESS).includes(ACCESS));
  redactor.addSecret(ACCESS);
  assert.ok(!redactor.redact(ACCESS).includes(ACCESS));
});

test('logger output never contains the registered secrets', async () => {
  const lines = [];
  const log = createLogger({
    redactor: createRedactor([OWNER, ACCESS]),
    write: (line) => lines.push(line),
  });

  log('token_issued', { accessToken: ACCESS, owner: OWNER, note: 'Bearer ' + ACCESS });

  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(ACCESS));
  assert.ok(!lines[0].includes(OWNER));
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, 'token_issued');
});

test('redactor handles non-string and circular values', () => {
  const redactor = createRedactor([ACCESS]);
  const circular = { name: 'x' };
  circular.self = circular;
  assert.equal(typeof redactor.redact(circular), 'string');
  assert.ok(!redactor.redact({ token: ACCESS }).includes(ACCESS));
});
