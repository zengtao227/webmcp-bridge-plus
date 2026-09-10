import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/repository-check.yml', import.meta.url);
const instructionsUrl = new URL('../AGENTS.md', import.meta.url);

test('repository CI runs the complete gate with read-only GitHub permissions', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /pull_request:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /name: repository-check/);
  assert.match(workflow, /run: npm run check/);
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|id-token: write/);
});

test('DevSpace Git instructions allow explicit branch publication without main bypasses', async () => {
  const instructions = await readFile(instructionsUrl, 'utf8');
  assert.match(instructions, /explicitly asks to commit and push/);
  assert.match(instructions, /chatgpt\/<short-task-name>/);
  assert.match(instructions, /Do not push directly to `main`/);
  assert.match(instructions, /Do not force-push/);
  assert.match(instructions, /Do not commit secrets/);
  assert.match(instructions, /not permission to act automatically/);
});
