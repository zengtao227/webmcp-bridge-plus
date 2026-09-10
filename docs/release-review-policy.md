# Independent Review and Release Policy

Status: Active
Effective: 2026-09-10

This repository uses a lightweight two-agent release model. It provides the separation of duties of a pull-request workflow without requiring every personal development task to create and merge a GitHub PR.

The governing principle is:

```text
speed may be optimized,
but direct publication to main is reserved for an independently completed release review
```

Quality, correctness, and security take priority over latency or tool-call count.

## 1. Roles

### Development executor

A development executor is an agent working through the Web/DevSpace development path, such as ChatGPT using `@DevSpace`.

Its responsibilities are to:

- inspect and understand the requested change;
- implement the smallest coherent change set;
- perform task-specific semantic review;
- run the relevant tests and repository validation;
- leave a reviewable working tree or, when explicitly requested, publish a review branch.

A DevSpace development executor must **not** push directly to `main` and must not merge its own review branch. Its Git limits are defined by [`../AGENTS.md`](../AGENTS.md).

### Independent release reviewer

An independent release reviewer is a separately invoked reviewer operating outside the Web/DevSpace development execution path, for example an independently run Claude or Codex review session.

The reviewer is the final release approver. It may publish directly to `origin/main` only when all of the following are true:

1. the user explicitly designated the run as an independent final review and authorized publication if it passes;
2. the reviewer independently inspected the final change set rather than relying on the development executor's summary;
3. semantic correctness, security implications, scope, and documentation were reviewed;
4. all required validation gates pass on the final tree;
5. there is no unresolved issue or blocker;
6. repository permissions and configured branch protection allow the push without bypassing protections.

When these conditions are satisfied, an extra review branch or PR is not required by this personal workflow. The reviewer may commit the approved final tree and push it directly to `origin/main`.

A successful independent review is intended to be a **terminal release step**, not another handoff back to the development executor. If the reviewer environment lacks the repository permission or Git capability required to publish `main`, it must report that capability blocker immediately instead of bouncing the task back and forth between agents without a release path.

## 2. Required reviewer checks

The independent reviewer must inspect the actual repository state, including tracked and untracked changes. A passing automated test suite is necessary but is not semantic proof of correctness.

At minimum, a release review must cover:

```text
repository status
+ complete final diff, including newly added files
+ task-specific semantic review
+ security / boundary review where relevant
+ git diff --check
+ npm run check
+ final repository status
```

Additional targeted tests or inspection are required whenever the change creates a new risk or uncertainty.

The reviewer must not remove a check merely to make the review faster.

## 3. Reviewer-found fixes

An independent reviewer may make small, directly review-driven corrections discovered during the review, such as:

- restoring a lost invariant;
- hardening a narrow edge case;
- closing a clear test-coverage gap;
- correcting inaccurate documentation or benchmark claims.

After any reviewer modification, the reviewer must restart the relevant final-review steps on the resulting tree and rerun the complete validation gate before publishing.

If the required fix becomes a material redesign, expands scope significantly, or introduces a new architectural decision, the reviewer must stop publication and return the work to development instead of acting as both substantive author and final approver.

## 4. Failure behavior

If review or validation fails:

```text
FAIL / unresolved blocker
→ do not commit for release
→ do not push main
→ report the blocker or return to development
```

If review passes but the independent reviewer cannot publish because its environment lacks the required Git/repository capability:

```text
PASS + publication capability blocker
→ report the capability blocker immediately
→ do not create another development/review loop merely to avoid saying publication is unavailable
```

A reviewer must never publish merely to complete the workflow, and must never create an agent handoff loop merely to avoid a clear PASS/FAIL/capability outcome.

## 5. Git safety rules for the release reviewer

Direct `main` publication is authorization to publish the reviewed change, not authorization to administer or rewrite the repository.

The reviewer must not:

- force-push;
- rewrite existing history;
- delete remote refs or tags;
- bypass configured branch protections;
- change Git credentials or remotes;
- modify repository rules/settings;
- commit secrets, generated credentials, runtime state, or unrelated files.

The expected successful flow is:

```text
DevSpace development executor
→ implementation + first validation
→ independent release reviewer
→ independent semantic/security review
→ complete validation PASS
→ commit approved final tree
→ push origin/main
```

This is intentionally analogous to "author opens a PR, independent reviewer approves and releases", while avoiding unnecessary branch/merge ceremony for a personal repository when an independently executed final review already provides the approval boundary.
