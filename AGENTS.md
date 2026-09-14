# WebMCP Bridge Plus agent instructions

These instructions apply specifically to ChatGPT and other coding executors working through the Native WebMCP Plus development path. They define the **development-executor** boundary, not the separate independent release-reviewer role described in [`docs/release-review-policy.md`](./docs/release-review-policy.md).

## Git authorization for WebMCP Plus development executors

Git read and write operations are supported. When the user explicitly asks a WebMCP Plus development executor to commit and push:

1. inspect the final diff and run `npm run check` before committing;
2. stage only the files that belong to the requested change; never use `git add -A` as a shortcut;
3. create or use a branch named `chatgpt/<short-task-name>`;
4. create a normal commit with a descriptive message;
5. push that branch to `origin` and report the branch and commit SHA.

A WebMCP Plus development executor must not push directly to `main` or merge its own review branch. Do not force-push, delete remote refs or tags, rewrite existing commits, change Git credentials/remotes, merge a pull request, or modify repository rules/settings. Do not commit secrets, generated credentials, local runtime state, or ignored files.

Commit and push capability is not permission to act automatically. If the user did not request commit or push, stop after the requested implementation and validation.

An independently invoked release reviewer operating outside the WebMCP Plus development path is governed by [`docs/release-review-policy.md`](./docs/release-review-policy.md). When the user explicitly authorizes that independent review to publish on PASS, and all policy conditions are satisfied, the reviewer carries the approved final tree to `main` via whichever mechanism the repository's actual branch protection permits (direct push, or push review branch + PR + required checks + self-merge) — never by bypassing branch protection.

## Engineering minimalism

Use first principles and make the minimum necessary change. Prefer deletion, reuse, and simplification before adding code. If removing a mechanism solves the problem, remove it rather than hardening or generalizing it. Do not add abstractions, compatibility layers, state, daemons, services, configuration, tools, or frameworks for hypothetical future needs. Every new line of production code must justify a current requirement or safety boundary; no code is better than unnecessary code.

## Review scope discipline

When implementing or responding to review findings, keep the change set causally tied to the requested task:

- fix the confirmed issue and add only the regression coverage or documentation needed to prove that fix;
- treat post-fix self-review as read-only by default: report unrelated findings instead of changing them;
- expand the implementation only when evidence shows the current fix is incomplete on the same causal chain, or when the owner explicitly approves broader scope;
- before handoff, every changed path must be attributable to the original task, a confirmed review finding, a directly necessary regression test, or directly necessary documentation. Revert unexplained changes.

Do not use "hardening", cleanup, refactoring, or architectural improvement as a reason to widen a blocker fix without that evidence or owner approval.

## Safety boundary

Repository Git access does not authorize host operations. Do not install/reload LaunchAgents, restart Docker or the WebMCP runtime, change network exposure, alter host-only control-plane files, or perform live activation unless the user separately and explicitly requests that operation.
