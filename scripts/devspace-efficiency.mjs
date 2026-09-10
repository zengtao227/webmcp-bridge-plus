import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export const WORKFLOWS = Object.freeze({
  inspect: Object.freeze([
    Object.freeze({ id: 'status', command: 'git', args: ['status', '--short', '--branch'] }),
    Object.freeze({ id: 'diff-stat', command: 'git', args: ['diff', '--stat', 'HEAD', '--'] }),
    Object.freeze({ id: 'diff-check', command: 'git', args: ['diff', '--check', 'HEAD', '--'] }),
    Object.freeze({ id: 'recent-commits', command: 'git', args: ['log', '-5', '--oneline', '--decorate'] }),
  ]),
  validate: Object.freeze([
    Object.freeze({ id: 'diff-check', command: 'git', args: ['diff', '--check', 'HEAD', '--'] }),
    Object.freeze({ id: 'repository-check', command: npmExecutable, args: ['run', 'check'] }),
    Object.freeze({
      id: 'final-status',
      command: 'git',
      args: ['status', '--short', '--branch'],
      alwaysRun: true,
    }),
  ]),
});

export function defaultExecute(step, cwd) {
  const result = spawnSync(step.command, step.args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.error) {
    return {
      status: 1,
      stdout: result.stdout ?? '',
      stderr: `${result.stderr ?? ''}${result.error.message}\n`,
    };
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function writeSection(stream, id, text, emptyLabel = '(no output)') {
  stream.write(`--- ${id} ---\n`);
  if (text.length === 0) {
    stream.write(`${emptyLabel}\n`);
    return;
  }

  stream.write(text);
  if (!text.endsWith('\n')) {
    stream.write('\n');
  }
}

export function runWorkflow(
  mode,
  {
    cwd = process.cwd(),
    execute = defaultExecute,
    stdout = process.stdout,
    stderr = process.stderr,
    now = () => performance.now(),
  } = {},
) {
  if (!Object.hasOwn(WORKFLOWS, mode)) {
    throw new Error(`Unknown DevSpace efficiency workflow: ${mode}`);
  }
  const plan = WORKFLOWS[mode];

  const startedAt = now();
  let firstFailure = null;
  let executedSteps = 0;

  stdout.write(`=== DevSpace ${mode} ===\n`);

  for (const step of plan) {
    if (firstFailure && !step.alwaysRun) {
      stdout.write(`--- ${step.id} ---\n(skipped after ${firstFailure.id} failed)\n`);
      continue;
    }

    const stepStartedAt = now();
    const result = execute(step, cwd);
    const durationMs = Math.max(0, Math.round(now() - stepStartedAt));
    executedSteps += 1;

    writeSection(stdout, step.id, result.stdout, step.id === 'diff-check' ? '(clean)' : '(no output)');
    if (result.stderr.length > 0) {
      writeSection(stderr, `${step.id}:stderr`, result.stderr);
    }
    stdout.write(`metric step=${step.id} status=${result.status} duration_ms=${durationMs}\n`);

    if (result.status !== 0 && !firstFailure) {
      firstFailure = { id: step.id, status: result.status };
    }
  }

  const totalDurationMs = Math.max(0, Math.round(now() - startedAt));
  stdout.write(
    `=== DevSpace ${mode} summary: planned_steps=${plan.length} executed_steps=${executedSteps} ` +
      `status=${firstFailure ? 'failed' : 'ok'} duration_ms=${totalDurationMs} ===\n`,
  );

  return firstFailure?.status ?? 0;
}

function printUsage() {
  process.stderr.write('Usage: node scripts/devspace-efficiency.mjs <inspect|validate>\n');
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (invokedUrl === import.meta.url) {
  const mode = process.argv[2];
  if (!Object.hasOwn(WORKFLOWS, mode)) {
    printUsage();
    process.exitCode = 2;
  } else {
    process.exitCode = runWorkflow(mode);
  }
}
