---
name: webmcp-workspace
description: Use WebMCP to work on local development projects.
---

# WebMCP workspace

## Purpose

Use WebMCP to work on local development projects from ChatGPT or another supported web AI.

The approved MCP-facing workspace root is:

```text
/workspace
```

All normal project work starts from this workspace. WebMCP does not maintain a per-project registry, project alias table, or hard-coded repository list.

The Skill is workflow guidance, not the security boundary. Native WebMCP remains authoritative for the fixed `/workspace` root, and the existing runtime/Secret Firewall controls remain authoritative for protected paths and output sanitization.

## When to activate

Use this Skill when the user asks WebMCP to inspect, locate, review, modify, test, build, or otherwise work on a local development project through the available MCP development tools.

The user may provide either an exact project name or a natural-language description. Exact repository names are not required.

## Approved workspace

`open_workspace` must only open:

```text
/workspace
```

Do not call `open_workspace` with a child project path or any other filesystem path. Once `/workspace` is open, individual projects are handled as subdirectories inside that workspace.

Never attempt to open or access directories outside the approved workspace root.

## Project discovery

When the user gives a recognizable project name, work in the corresponding directory beneath `/workspace`.

When the user gives a natural-language description instead of an exact name:

1. inspect the immediate project directories under `/workspace`;
2. identify likely candidates from directory names;
3. when needed, inspect a small amount of project metadata such as `README.md`, `package.json`, repository name, or project documentation;
4. use conversation context to select the best match.

If more than one project remains genuinely ambiguous and choosing incorrectly could cause wrong modifications, ask the user to choose.

Do not maintain a separate alias database. Do not invent a project path or create a directory merely because the user mentioned a project name.

## Repository instructions

Before making changes inside a target project, inspect repository instructions that apply there, such as `AGENTS.md`, `CLAUDE.md`, or relevant `SKILL.md` files.

A broad `/workspace` workspace does not authorize unrelated cross-project changes. Keep reads, edits, commands, Git operations, and generated artifacts within the project or projects requested by the user unless broader access is explicitly requested.

## Tool usage

Use the available MCP development tools directly after the workspace is open.

- Use `read` for source inspection.
- Use `edit` for targeted modifications.
- Use `write` for intentional file creation or full replacement.
- Use `bash` for tests, builds, Git inspection, package commands, and other repository tooling.

Prefer the most direct operation. Batch predictable mechanical checks when it improves efficiency without reducing confidence. Do not replace task-specific semantic review with mechanical batching.

## Workspace reuse

If `/workspace` is already open in the current conversation and the workspace is still valid, reuse its `workspaceId` instead of opening it again for each child project.

A `workspaceId` belongs to the execution backend that created it. Never reuse a workspace across different execution-host or backend identities.

## Conversation-resilient task resume

Store the rolling semantic checkpoint in WebMCP-owned workspace state at `/workspace/.webmcp/resumes/<project-id>.md`, not inside the user's Git repository. Treat that file as a bounded rolling semantic checkpoint, not a static handoff note, edit log, task database, session database, checkpoint history, or code-state database. Keep two sections:

- **Stable context:** project, current task, authoritative plan, authorization/safety boundary, and recovery rules.
- **Live checkpoint:** `Current objective`, compressed `Completed in this task` history, `Currently in progress`, `Important findings/decisions`, `Files currently involved`, `Last validation`, `Known blockers`, and an actionable `Exact next action`.

On the first WebMCP use for every new task, create or refresh the workspace-owned semantic checkpoint before the first repository modification. A project such as `webmcp-bridge` may use `/workspace/.webmcp/resumes/webmcp-bridge.md`; the filename is only checkpoint storage naming, not a task/session registry. `Completed in this task` should retain the whole current task as a small number of compressed summary bullets; periodically compact older completed work instead of keeping an append-only journal or mechanically limiting it to the most recent N items.

Keep `/workspace/CHATGPT-RESUME.md` pointer-only: it contains the active project path and the referenced workspace-owned semantic checkpoint path, and no duplicated checkpoint body.

Refresh the semantic checkpoint at meaningful semantic state changes, not on a timer and not after every tool call. Refresh it:

- after a new task is understood and before the first repository modification;
- before entering a meaningful new work item;
- before a substantial batch of modifications when losing the current reasoning would make recovery expensive;
- after a work item completes and its targeted validation result is known;
- immediately after an important finding, implementation decision, or blocker materially changes the next action;
- when moving between diagnosis, implementation, targeted validation, full validation, or task completion;
- when task scope, authoritative plan, authorization boundary, or active project changes.

Do not checkpoint ordinary reads/searches, individual edits, every test case, every progress update, or every tool call. Record reasoning outcomes rather than operation history. The purpose is to bound unrecoverable conversational context to roughly one semantic execution step without creating a second activity log.

`Last validation` must state what was actually validated and whether later unvalidated changes have made that result stale for the current diff. Never present an earlier PASS as validating changes made after that PASS. `Exact next action` must be directly actionable, such as the next file/behavior to inspect, edit, or test; vague text such as `continue implementation` is not sufficient.

Resume intent does not require exact wording. Phrases such as `@WebMCP 继续`, `@WebMCP 接着做`, `@WebMCP 恢复刚才的工作`, `恢复上一个任务`, `continue`, or `resume` mean: open `/workspace`, read `/workspace/CHATGPT-RESUME.md`, read the referenced workspace-owned semantic checkpoint, read the project's repository instructions and authoritative plan, then inspect actual Git/filesystem state before continuing.

Recovery is reconciliation, not replay. Use the Live checkpoint to recover the previous conversation's objective, reasoning outcomes, validation status, and next action, then inspect the working tree, diff/stat, diff, stash list, branch, and HEAD. Reconcile any changes made after the last checkpoint. Current user instruction has highest priority; the current authoritative plan overrides stale Resume intent; Git/filesystem are authoritative for what actually happened; stale Resume progress statements never override actual state. Never reset, restore, clean, stash, apply/drop stash, or overwrite existing WIP merely to normalize a dirty tree.

If WebMCP becomes disabled or unavailable in a conversation, retry WebMCP once. If that retry also fails, stop all workspace modification, do not bypass WebMCP through another filesystem channel, and direct the user to a fresh conversation where the workspace-owned checkpoint plus Git/filesystem reconciliation can continue the task.

Do not add a checkpoint MCP tool, task/session database, checkpoint IDs/history, timer autosave, daemon/watchdog, automatic Git commits, per-project `.resume/` state inside repositories, or a multi-task registry for this workflow. Commit, push, merge, release, installation, activation, and production operations retain their existing explicit authorization gates.

## Permissions

WebMCP never expands the user's requested permissions.

Examples:

| User instruction | Required behavior |
| --- | --- |
| `只读，不要修改` | Read only |
| `先分析，不要改代码` | Analyze only |
| `修改但不要 commit` | Editing allowed, no commit |
| `不要 push` | Do not push |
| `运行测试，不要自动修` | Run tests and report only |

If the user did not authorize an action, do not infer authorization merely because a tool is available.

## Git and release workflow

Git operations must follow the target repository's own instructions and release policy.

For the normal WebMCP development path:

```text
WebMCP development executor
→ implementation
→ semantic review
→ validation
→ independent release review
→ publication according to repository protection rules
```

Do not bypass branch protection. Do not force-push or rewrite history unless explicitly requested and allowed by repository policy. Do not commit secrets, credentials, runtime state, or unrelated files.

## Security boundaries

The approved workspace is intentionally broader than a single repository, so project scope must remain explicit.

Never use the broader workspace as permission to modify unrelated sibling projects, access paths outside `/workspace`, bypass repository instructions, expose secrets, weaken security controls, or change host infrastructure unless the user explicitly requests host-level work.

If a workspace or tool operation is rejected by the security boundary, report the rejection instead of trying alternate paths to bypass it.

## Operating principle

```text
User request
    ↓
@WebMCP
    ↓
open /workspace
    ↓
locate target project
    ↓
read project instructions
    ↓
inspect / edit / test / review
```

Prefer fewer rules, fewer routing layers, and fewer tool calls when they provide the same correctness and safety.

In short:

```text
One approved workspace.
No per-project registry.
Natural-language project discovery.
Repository-scoped changes.
Existing security boundaries remain enforced.
```
