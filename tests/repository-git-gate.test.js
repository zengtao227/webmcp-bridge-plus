import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/repository-check.yml', import.meta.url);
const instructionsUrl = new URL('../AGENTS.md', import.meta.url);
const releasePolicyUrl = new URL('../docs/release-review-policy.md', import.meta.url);

test('repository CI runs the complete gate with read-only GitHub permissions', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /pull_request:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /name: repository-check/);
  assert.match(workflow, /run: npm run check/);
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|id-token: write/);
});

test('DevSpace Git instructions keep development publication off main', async () => {
  const instructions = await readFile(instructionsUrl, 'utf8');
  assert.match(instructions, /explicitly asks a DevSpace development executor to commit and push/);
  assert.match(instructions, /chatgpt\/<short-task-name>/);
  assert.match(instructions, /must not push directly to `main`/);
  assert.match(instructions, /must not push directly to `main` or merge its own review branch/);
  assert.match(instructions, /Do not force-push/);
  assert.match(instructions, /Do not commit secrets/);
  assert.match(instructions, /not permission to act automatically/);
  assert.match(instructions, /docs\/release-review-policy\.md/);
});

test('independent release policy requires review and explicit authorization before direct main publication', async () => {
  const policy = await readFile(releasePolicyUrl, 'utf8');
  assert.match(policy, /user explicitly designated the run as an independent final review and authorized publication if it passes/);
  assert.match(policy, /independently inspected the final change set/);
  assert.match(policy, /npm run check/);
  assert.match(policy, /there is no unresolved issue or blocker/);
  assert.match(policy, /push it directly to `origin\/main`/);
  assert.match(policy, /terminal release step/);
  assert.match(policy, /report that capability blocker immediately/);
  assert.match(policy, /- force-push;/);
  assert.match(policy, /material redesign/);
  assert.match(policy, /return the work to development/);
});
