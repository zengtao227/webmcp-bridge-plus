# WebMCP Bridge Development Roadmap

Status: Active planning document
Last updated: 2026-09-08

This is the central place for **future development planning and developer operating rules** for WebMCP Bridge / DevSpace work.

Detailed design documents may live elsewhere, but new roadmap items, sequencing decisions, and developer-efficiency rules should be recorded here so they do not depend on chat history or memory.

## 1. Operating principle

The target is not "use the fewest tool calls at any cost". The target is:

```text
high-quality reasoning
+ low unnecessary round-trip latency
+ complete validation
+ fail-closed security boundaries
+ independent review when risk justifies it
```

Only tool calls with a real information dependency should remain serial.
Independent inspection and validation work should be batched when doing so does not reduce correctness.

## 2. DevSpace Developer Efficiency standard

This is the default operating standard when ChatGPT or another coding executor works through DevSpace.

### Rule 1 — Plan the inspection before calling tools

Form the inspection question and expected evidence first. Avoid a default pattern of one tiny read or shell call at a time when the required evidence is already predictable.

### Rule 2 — Batch what is safe; serialize what is dependent or conflict-prone

Use this principle as the default concurrency rule:

```text
Safe and independent -> batch
Data-dependent or write-conflict risk -> serialize
Correctness first
```

Independent read-only checks should normally be grouped into one inspection snapshot, for example:

```text
git status
+ changed-file list
+ diff / diff --check
+ relevant reference search
+ configuration/state checks
```

Batching must not hide failures; commands should keep clear section labels and outputs.

Do not parallelize operations when later work depends on earlier results, or when operations can race on shared mutable state. In particular, do **not** issue parallel edits/writes against the same file. Same-file mutations must be serialized, followed by inspection of the final diff/content before validation or commit.

### Rule 3 — Gather enough relevant code context in the first pass

When the relevant files/symbols are already known, read enough surrounding context to reason about the change without repeatedly crossing the tunnel for adjacent fragments.

Do not over-read unrelated code just to reduce call count.

### Rule 4 — Finish the patch plan before editing

Before modifying files, decide the intended change set, invariants, scope, and files to touch.

Then apply the smallest coherent patch rather than alternating between speculative edits and repeated inspection.

### Rule 5 — Batch validation

After a coherent edit set, run the independent validation gates together where practical, for example:

```text
git diff --check
lint
tests
build
security/reference checks
git diff
git status
```

Validation coverage must not be reduced for speed.

### Rule 6 — Add another inspection/repair round only when evidence requires it

A second targeted round is appropriate when:

- tests fail;
- the diff reveals an unexpected change;
- a security invariant is uncertain;
- new information changes the patch plan.

Do not create extra serial rounds only out of habit.

### Rule 7 — Performance never overrides correctness or security

Never remove or weaken these controls merely to reduce latency:

- fail-closed routing;
- approved-root / registered-project restrictions;
- Secret Firewall boundaries;
- least-privilege tool permissions;
- relevant tests/builds;
- review gates for risky changes;
- explicit commit / push boundaries when requested.

### Rule 8 — The executor is replaceable; the standard is not

No single executor is mandatory.

Depending on task complexity and observed quality, execution may be performed by:

- ChatGPT directly through DevSpace;
- Codex / another capable coding model;
- Workbuddy;
- another approved coding executor.

Use the executor that is most effective for the task. Simple mechanical work may be delegated; complex, architecture-heavy, security-sensitive, or poorly executed work may be handled directly through DevSpace.

Regardless of executor, the same scope, validation, safety, and review requirements apply.

## 3. Preferred execution shape

Default to a small number of high-information passes:

```text
PASS 1 — Inspect
  gather the evidence required to make the change

PASS 2 — Modify
  apply the smallest coherent planned change set

PASS 3 — Validate
  run tests/build/checks + inspect final diff/status

PASS 4 — Targeted repair (only if evidence requires it)
```

The goal is normally to replace many small tunnel round trips with roughly 3–4 meaningful phases **without guessing and without skipping validation**.

Workspace identity should be reused for the same execution host/project instead of repeatedly reopening the same workspace.

## 4. Developer Efficiency work item

### Phase 1 — workflow optimization without changing MCP surface

Status: Planned / immediately applicable

Actions:

1. Use the rules above for direct DevSpace coding tasks.
2. Batch independent shell/read-only inspections.
3. Batch post-change validation.
4. Reuse workspaceId for the same host/project.
5. Record cases where repeated serial round trips were genuinely required by data dependencies.

This phase requires **no new MCP tools** and therefore has minimal security impact.

### Measurements

Collect practical evidence before adding new protocol/tool surface:

- DevSpace tool round trips per task;
- redundant or avoidable calls per task;
- number of dependency-required serial rounds;
- first validation pass success/failure;
- defects found during final review;
- cases where batching reduced clarity or correctness.

Do not set an arbitrary latency target before a baseline exists.

### Phase 2 — optional read-only composite capabilities

Status: Evaluate only if Phase 1 data shows meaningful remaining overhead

Possible concepts:

```text
inspect_workspace
validate_workspace
```

Potential `inspect_workspace` output:

```text
project instructions
+ git status
+ changed files
+ requested diffs
+ selected file context
+ reference searches
```

Potential `validate_workspace` behavior:

```text
lint
+ tests
+ build
+ diff --check
+ final status
```

Requirements before adding either capability:

- read-only or tightly bounded behavior;
- deterministic output and clear failures;
- Secret Firewall coverage remains intact;
- no expansion to arbitrary host filesystem access;
- measurable reduction in round trips compared with existing batched `bash`/`read` usage.

### Phase 3 — batch write capability (not planned by default)

A future transactional/batch edit capability such as `apply_patch_set` should only be considered after separate security review.

Do not add it merely for speed. Existing `edit` / `write` primitives remain the default until there is strong evidence that a bounded batch-write tool is necessary and safe.

## 5. Execution-host terminology and multi-host direction

Do not architect V2.2 around "Mac Mini". Mac Mini is only an example of a second execution machine.

Use the generic term:

```text
execution host / DevSpace host
```

An execution host may be, for example:

- MacBook Pro;
- Mac Mini;
- Windows PC;
- another macOS machine;
- another supported future host platform.

The user-facing interaction should remain project-centric:

```text
@DevSpace 去 trading-engine 看一下
```

Conceptual routing:

```text
project
→ registered execution host
→ registered DevSpace backend/identity
→ approved container path
→ open_workspace
```

The user should not normally need to specify operating system, machine name, or parent directory.

Platform-specific startup/operations belong behind the execution-host abstraction. For example, macOS may use `launchd`; Windows may use a Windows Service or Task Scheduler. Container-visible approved paths should remain as consistent as practical.

Detailed routing design: [`roadmap-v2.2-multi-host-routing.md`](./roadmap-v2.2-multi-host-routing.md).

## 6. Current roadmap sequence

### A. V2.2 registry-based routing foundation

Status: Implemented, reviewed, and pushed (`7a3ae47` on 2026-09-09).

Key invariants:

```text
registered unique match -> execute
ambiguous registered match -> ask/fail closed until disambiguated
missing/unregistered -> fail closed
registry unavailable -> fail closed
```

Unknown names and unregistered absolute paths must never be synthesized into `open_workspace` paths.

### A1. V2.2 live Skill E2E

Status: Failed in live testing on 2026-09-09; root cause identified.

The online Skill was not a guaranteed precondition for the `@DevSpace` App tool call. Repeated tests showed the model could still guess paths such as `/work/webmcp-bridge` and send unknown/unregistered paths to `open_workspace`. The lower Secret Firewall blocked traversal (`../../something`) but did not enforce registry membership.

Conclusion: Skill-only routing is UX guidance, not a sufficient correctness/security boundary.

### A2. Adapter-enforced registry routing

Status: CLOSED on 2026-09-09. Implemented, reviewed, pushed (`f2f2c04` + `0368787`), runtime reloaded, and proven live by ChatGPT E2E plus host-side audit. Full repository check passes 164/164 tests plus lint/build.

The private adapter is now the authoritative routing enforcement point:

```text
tools/list
→ advertise registered open_workspace references

tools/call open_workspace
→ registry resolve
→ current-backend check
→ exact registered path rewrite
→ existing Secret Firewall
→ upstream DevSpace
```

Requirements:

- canonical project name, registered alias, or exact registered absolute path may resolve;
- guessed absolute paths and unknown project names are denied before upstream;
- registry unavailable/invalid causes adapter startup failure;
- with one registered host the adapter may infer it; with multiple hosts `DEVSPACE_HOST_ID` is mandatory;
- a project registered to another backend fails closed until multi-backend selection is implemented;
- no new MCP tool is added; the existing five-tool surface is preserved;
- normal routing remains one `open_workspace` round trip.

### A3. V2.2 live E2E + host-side audit

Status: CLOSED on 2026-09-09.

Live regression covered canonical name, alias, fresh missing project, unregistered absolute path, traversal, read-only permission preservation, and the historical guessed path `/work/webmcp-bridge`.

Observed result:

```text
canonical / alias
→ exact registered path
→ project_routed

missing / guessed / unregistered
→ project_unregistered
→ request_blocked before upstream open_workspace
```

Host-side audit confirmed the fresh missing-project directory was not created, the valid workspace remained clean/aligned, and the security posture remained unchanged: stdio adapter, no listener on 8787, DevSpace loopback-only on `127.0.0.1:7676`, with no public DevSpace endpoint in the runtime path.

Conclusion: V2.2 Phase 1.1 Skill-only routing is retained as the UX lesson/superseded approach; V2.2 Phase 1.2 adapter-enforced routing is the authoritative closed implementation.

### B. DevSpace container auto-recovery

Status: Repository-side implementation complete; host-side `dsup.sh --ensure` change and live activation remain pending independent review.

Goal: an unattended macOS execution host should recover DevSpace after login/reboot and after a transient local container-runtime outage without weakening the current security model.

Repository-side design:

- a dedicated per-user LaunchAgent directly invokes host-only `~/Doc/devspace-container/dsup.sh --ensure`;
- use `RunAtLoad` plus a periodic `StartInterval` and no persistent keepalive behavior;
- do not execute repository code, DevSpace-mounted code, Node recovery controllers, or direct Docker lifecycle commands from the LaunchAgent;
- keep all container creation and security policy inside the existing host-side `dsup.sh` control plane;
- Docker temporarily unavailable is a transient non-zero ensure result; a later interval retries;
- unsafe existing container state fails closed and must not be deleted or replaced automatically.

The host-side `--ensure` implementation must continue to enforce the existing local Docker context, loopback-only binding, approved project mount, exact read-only credential overlays, image policy, `publicBaseUrl` normalization, and secret/mount checks. The repository-side installer does not duplicate those rules or add a separate public-endpoint detector.

This status does **not** mean the host-side script has been changed or that a real LaunchAgent has been installed or activated.

### C. Developer Efficiency Phase 1

Status: Begin immediately as an operating practice; document evidence while normal development continues.

No runtime/MCP protocol changes required.

### D. V2.2 multi-host live validation

Status: Planned after routing foundation + reliable host lifecycle

Do not assume the second host is a Mac Mini.

Required live validation includes:

- at least two independent execution hosts/backends;
- unique project routes to the correct host;
- ambiguous project identity asks instead of guessing;
- missing project fails closed;
- offline/unavailable registered host does not fall back to another host;
- workspaceId is never reused across different backend identities;
- each host preserves its own approved-root, credential, Docker/container, and Secret Firewall boundaries;
- user can control the system from a third client device without the client holding the project files.

### E. Developer Efficiency Phase 2 decision

After collecting enough real task data, decide whether read-only composite tools are justified.

Default decision if benefits are small: keep the current minimal MCP surface and continue using batched existing tools.

## 7. Planning discipline

When a new material development idea is accepted:

1. add it to this roadmap;
2. record its status and sequencing;
3. link a detailed design document if one is needed;
4. record important non-goals/security boundaries;
5. update the status when implemented, committed, pushed, or superseded.

Chat history and assistant memory are not the canonical project roadmap.

The repository is.
