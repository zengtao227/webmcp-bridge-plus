import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

import { WORKFLOWS, runWorkflow, defaultExecute } from '../scripts/devspace-efficiency.mjs';

function memoryStream() {
  let value = '';
  return {
    write(chunk) {
      value += chunk;
    },
    text() {
      return value;
    },
  };
}

test('inspect batches the fixed repository snapshot into one bounded workflow', () => {
  assert.deepEqual(
    WORKFLOWS.inspect.map((step) => step.id),
    ['status', 'diff-stat', 'diff-check', 'recent-commits'],
  );

  const calls = [];
  const stdout = memoryStream();
  const stderr = memoryStream();
  let clock = 100;

  const status = runWorkflow('inspect', {
    cwd: '/repo',
    stdout,
    stderr,
    now: () => clock++,
    execute(step, cwd) {
      calls.push({ id: step.id, cwd, command: step.command, args: step.args });
      return { status: 0, stdout: `${step.id}\n`, stderr: '' };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.cwd === '/repo'));
  assert.match(stdout.text(), /DevSpace inspect summary: planned_steps=4 executed_steps=4 status=ok/);
  assert.equal(stderr.text(), '');
});

test('validate runs the complete gate and always reports final Git status', () => {
  assert.deepEqual(
    WORKFLOWS.validate.map((step) => step.id),
    ['diff-check', 'repository-check', 'final-status'],
  );

  const calls = [];
  const stdout = memoryStream();
  const stderr = memoryStream();

  const status = runWorkflow('validate', {
    stdout,
    stderr,
    execute(step) {
      calls.push(step.id);
      if (step.id === 'repository-check') {
        return { status: 7, stdout: '', stderr: 'check failed\n' };
      }
      return { status: 0, stdout: `${step.id}\n`, stderr: '' };
    },
  });

  assert.equal(status, 7);
  assert.deepEqual(calls, ['diff-check', 'repository-check', 'final-status']);
  assert.match(stderr.text(), /check failed/);
  assert.match(stdout.text(), /DevSpace validate summary: planned_steps=3 executed_steps=3 status=failed/);
});

test('a failed early step skips dependent work but still runs final status', () => {
  const calls = [];
  const stdout = memoryStream();

  const status = runWorkflow('validate', {
    stdout,
    stderr: memoryStream(),
    execute(step) {
      calls.push(step.id);
      return {
        status: step.id === 'diff-check' ? 2 : 0,
        stdout: '',
        stderr: '',
      };
    },
  });

  assert.equal(status, 2);
  assert.deepEqual(calls, ['diff-check', 'final-status']);
  assert.match(stdout.text(), /repository-check ---\n\(skipped after diff-check failed\)/);
});

test('runWorkflow rejects an unknown mode instead of silently reading Object.prototype', () => {
  assert.throws(() => runWorkflow('bogus'), /Unknown DevSpace efficiency workflow: bogus/);
  // Prototype-chain properties (e.g. "constructor") must not resolve to a truthy
  // "plan" and bypass the Object.hasOwn guard.
  assert.throws(() => runWorkflow('constructor'), /Unknown DevSpace efficiency workflow: constructor/);
});

test('an alwaysRun step that also fails does not overwrite the first failure status', () => {
  const status = runWorkflow('validate', {
    stdout: memoryStream(),
    stderr: memoryStream(),
    execute(step) {
      // Every step fails, with a distinct status per step. The reported exit
      // status must reflect the *first* failure (diff-check, 9), not the
      // later alwaysRun final-status step (5) — otherwise a genuine early
      // failure could be masked by a coincidentally-successful-looking or
      // differently-coded later step.
      if (step.id === 'diff-check') return { status: 9, stdout: '', stderr: '' };
      if (step.id === 'final-status') return { status: 5, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(status, 9);
});

test('defaultExecute runs a real live command and reports success', () => {
  // Exercise the actual (non-injected) spawnSync-backed executor, which
  // every other test in this file bypasses. Use the current Node binary as
  // the "command" so this has no dependency on git/npm PATH availability.
  const result = defaultExecute(
    { id: 'probe', command: process.execPath, args: ['-e', 'process.stdout.write("ok"); process.exit(0)'] },
    process.cwd(),
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, '');
});

test('defaultExecute reports a missing command as a clean failure, not an exception or false success', () => {
  // spawnSync's `result.error` (ENOENT) must be translated into a
  // deterministic failure status with the error message visible in stderr —
  // never an unhandled throw and never status 0.
  const result = defaultExecute(
    { id: 'probe', command: 'definitely-not-a-real-command-xyz', args: [] },
    process.cwd(),
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT|not found|no such file/i);
});

test('defaultExecute propagates a real nonzero exit code', () => {
  const result = defaultExecute(
    { id: 'probe', command: process.execPath, args: ['-e', 'process.exit(3)'] },
    process.cwd(),
  );

  assert.equal(result.status, 3);
});
