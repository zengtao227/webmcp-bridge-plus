import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/repository-check.yml', import.meta.url);
const instructionsUrl = new URL('../AGENTS.md', import.meta.url);
const releasePolicyUrl = new URL('../docs/release-review-policy.md', import.meta.url);
const workspaceSkillUrl = new URL('../skills/webmcp-workspace/SKILL.md', import.meta.url);

test('repository CI runs the complete gate with read-only GitHub permissions', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /pull_request:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /name: repository-check/);
  assert.match(workflow, /run: npm run check/);
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|id-token: write/);
});

test('WebMCP Plus Git instructions keep development publication off main', async () => {
  const instructions = await readFile(instructionsUrl, 'utf8');
  assert.match(instructions, /explicitly asks a WebMCP Plus development executor to commit and push/);
  assert.match(instructions, /chatgpt\/<short-task-name>/);
  assert.match(instructions, /must not push directly to `main`/);
  assert.match(instructions, /must not push directly to `main` or merge its own review branch/);
  assert.match(instructions, /Do not force-push/);
  assert.match(instructions, /Do not commit secrets/);
  assert.match(instructions, /not permission to act automatically/);
  assert.match(instructions, /docs\/release-review-policy\.md/);
  assert.match(instructions, /post-fix self-review as read-only by default/);
  assert.match(instructions, /same causal chain/);
  assert.match(instructions, /every changed path must be attributable/);
});

test('WebMCP workspace Skill carries the conversation-resume workflow without destructive recovery', async () => {
  const skill = await readFile(workspaceSkillUrl, 'utf8');
  // Assert the distinct workflow rules, not the surrounding prose: rewording the
  // Skill must stay possible without breaking the gate.
  assert.match(skill, /bounded rolling semantic checkpoint/);
  assert.match(skill, /\/workspace\/\.webmcp\/resumes\/<project-id>\.md/);
  assert.match(skill, /not inside the user's Git repository/);
  assert.match(skill, /\/workspace\/CHATGPT-RESUME\.md.*pointer-only/);
  assert.doesNotMatch(skill, /<project>\/CHATGPT-RESUME\.md/);
  for (const section of [
    'Stable context',
    'Live checkpoint',
    'Current objective',
    'Completed in this task',
    'Currently in progress',
    'Important findings/decisions',
    'Files currently involved',
    'Last validation',
    'Known blockers',
    'Exact next action',
  ]) {
    assert.ok(skill.includes(section), `Skill must define the ${section} checkpoint section`);
  }
  assert.match(skill, /whole current task as a small number of compressed summary bullets/);
  assert.match(skill, /meaningful semantic state changes, not on a timer and not after every tool call/);
  assert.match(skill, /Do not checkpoint ordinary reads\/searches, individual edits, every test case/);
  assert.match(skill, /Never present an earlier PASS as validating changes made after that PASS/);
  assert.match(skill, /vague text such as `continue implementation` is not sufficient/);
  assert.match(skill, /Recovery is reconciliation, not replay/);
  assert.match(skill, /Current user instruction has highest priority/);
  assert.match(skill, /current authoritative plan overrides stale Resume intent/);
  assert.match(skill, /Git\/filesystem are authoritative for what actually happened/);
  assert.match(skill, /retry WebMCP once/);
  assert.match(skill, /do not bypass WebMCP through another filesystem channel/);
  assert.match(skill, /Do not add a checkpoint MCP tool, task\/session database, checkpoint IDs\/history, timer autosave, daemon\/watchdog, automatic Git commits/);
  assert.doesNotMatch(skill, /\bgit (?:reset|restore|clean|stash)\b/);
});

test('independent release policy requires review and explicit authorization before publication', async () => {
  const policy = await readFile(releasePolicyUrl, 'utf8');
  assert.match(policy, /user explicitly designated the run as an independent final review and authorized publication if it passes/);
  assert.match(policy, /independently inspected the final change set/);
  assert.match(policy, /npm run check/);
  assert.match(policy, /there is no unresolved issue or blocker/);
  assert.match(policy, /terminal release step/);
  assert.match(policy, /report that capability blocker immediately/);
  assert.match(policy, /- force-push;/);
  assert.match(policy, /material redesign/);
  assert.match(policy, /return the work to development/);
  assert.match(policy, /Post-fix review is read-only by default/);
  assert.match(policy, /same causal chain/);
  assert.match(policy, /every changed path must be attributable/);
});

test('release policy is branch-protection-aware: direct push when allowed, PR + self-merge when required', async () => {
  const policy = await readFile(releasePolicyUrl, 'utf8');
  // Must not hard-code a single publication mechanism.
  assert.match(policy, /must not assume a specific mechanism in advance/);
  assert.match(policy, /pushes it directly to `origin\/main`/);
  assert.match(policy, /requires a pull request/);
  assert.match(policy, /opens a PR against `main`/);
  assert.match(policy, /waits for the repository's required status check\(s\) to pass, and merges the PR itself/);
  assert.match(policy, /No additional human reviewer or approval is required/);
  assert.match(policy, /does not require a handoff back to the development executor/);
  // Using the PR mechanism a protected repo requires is explicitly not "bypassing".
  assert.match(policy, /is \*using\* the protection mechanism as intended, not bypassing it/);
  assert.match(policy, /bypass configured branch protections/);
  // A required PR/check gate alone must not be reported as a capability blocker.
  assert.match(policy, /not, by itself, a capability blocker/);
});
