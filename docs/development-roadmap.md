# WebMCP Bridge Plus Development Roadmap

Status: Active Plus planning document
Last updated: 2026-09-13

This is the central place for **development planning and developer operating rules** for the independent `webmcp-bridge-plus` project. Plus inherits the production-accepted Native WebMCP execution-host baseline from `webmcp-bridge`, but it has its own product lifecycle and version line. It is not `webmcp-bridge` v2.0. DevSpace items below are retained only where they record completed migration history or useful multi-host design evidence.

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

## 2. WebMCP Developer Efficiency standard

This is the default operating standard when ChatGPT or another coding executor works through Native WebMCP.

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

- fail-closed workspace/root routing;
- owner-selected-root and control-plane restrictions;
- Secret Firewall boundaries;
- least-privilege tool permissions;
- relevant tests/builds;
- review gates for risky changes;
- explicit commit / push boundaries when requested.

### Rule 8 — The executor is replaceable; the standard is not

No single executor is mandatory.

Depending on task complexity and observed quality, execution may be performed by:

- ChatGPT directly through Native WebMCP;
- Codex / another capable coding model;
- Workbuddy;
- another approved coding executor.

Use the executor that is most effective for the task. Simple mechanical work may be delegated; complex, architecture-heavy, security-sensitive, or poorly executed work may be handled directly through Native WebMCP.

Regardless of executor, the same scope, validation, safety, and review requirements apply. Git publication authority is role-based rather than model-based.

### Rule 9 — Separate development execution from final release approval

The WebMCP development executor acts as the change author and must not directly publish its own work to `main`. It may leave a reviewable working tree or, when explicitly requested, publish a `chatgpt/<task>` review branch.

A separately invoked independent release reviewer may publish an approved final tree to `main` only when the user explicitly authorized release-on-PASS, the reviewer independently inspects the complete final change set, all required validation passes, and no unresolved issue remains. The reviewer reaches `main` via whichever mechanism the repository's actual branch protection permits — direct push, or push review branch + PR + required checks + self-merge — never by bypassing protection, and without handing the release back to development for either path. Small reviewer-found fixes require a fresh final review and complete validation; substantive redesign returns to development rather than being self-approved by the reviewer.

This separation is the lightweight equivalent of author + PR reviewer/approver. See [`release-review-policy.md`](./release-review-policy.md) for the canonical release rules.

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

Status: Implemented / active measurement since 2026-09-10

Actions:

1. Use the rules above for direct Native WebMCP coding tasks.
2. Use `npm run devspace:inspect` for the fixed repository snapshot (status, diff stat, diff check, recent commits) when those checks are relevant.
3. Use `npm run devspace:validate` for the fixed final gate (diff check, complete repository check, final status).
4. Batch task-specific read-only inspection around those fixed workflows instead of splitting predictable checks into separate tunnel round trips.
5. Reuse workspaceId for the same Native process/root.
6. Record real task evidence, including cases where repeated serial round trips were genuinely required by data dependencies.

The `devspace:*` script names are retained repository command names from the migration period; they do not imply a current DevSpace runtime dependency.

The first self-hosted benchmark is documented in [`developer-efficiency-benchmark.md`](./developer-efficiency-benchmark.md). This phase adds repository-local orchestration only: **no new MCP tools, permissions, host access, or security boundary changes**.

Quality invariant: repository-local batching may replace only predictable mechanical round trips. It must **not** replace task-specific code/context inspection, semantic review of the final change set, or any validation required to establish correctness. When speed and confidence conflict, preserve the higher-confidence workflow even if it requires another WebMCP round trip.

### Measurements

Collect practical evidence before adding new protocol/tool surface:

- WebMCP tool round trips per task;
- redundant or avoidable calls per task;
- number of dependency-required serial rounds;
- first validation pass success/failure;
- defects found during final review;
- cases where batching reduced clarity or correctness.

Do not set an arbitrary latency target before a baseline exists.

### Phase 2 — optional read-only composite capabilities

Status: Not justified by the first 2026-09-10 benchmark; continue measuring real tasks before reconsidering

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
execution host / Native WebMCP host
```

An execution host may be, for example:

- MacBook Pro;
- Mac Mini;
- Windows PC;
- another macOS machine;
- another supported future host platform.

The user-facing interaction should remain project-centric:

```text
@WebMCP 去 trading-engine 看一下
```

Current production flow:

```text
project name / natural-language description
→ open /workspace
→ locate the requested child project with the existing five Native tools
→ operate inside the verified Native container
```

The machine owner selects the host filesystem root that is mounted at `/workspace`. The retired DevSpace `/work/My code` transition path is historical and is not a current runtime dependency.

The user should not normally need to specify operating system, machine name, or parent directory. Natural-language project discovery is workflow behavior inside the already-open workspace, not a routing/security registry.

Platform-specific startup/operations belong behind the execution-host boundary. For example, macOS may use `launchd`; Windows may use a Windows Service or Task Scheduler. Stable `webmcp-bridge` remains single-host. This Plus repository now owns proactive multi-host development on top of that inherited Native execution-host foundation.

The earlier registry-based multi-host proposal is retained as historical design input: [`roadmap-v2.2-multi-host-routing.md`](./roadmap-v2.2-multi-host-routing.md). Reuse its fail-closed routing invariants where still valid, but do not revive its retired DevSpace runtime architecture.

### 5.1 Versioning / Product Line

`webmcp-bridge-plus` has its own version line. Do not model Plus as `webmcp-bridge` v2.0 and do not imply that the stable single-host product is replaced.

The inherited Native/V1.1 code is the **execution-host baseline**, not the Plus product version. Plus versions describe multi-host/control-plane capabilities added in this repository. Stable WebMCP can continue its own 1.x lifecycle independently.

Semantic Versioning rule:

```text
PATCH
1.0.0 → 1.0.1
Bug fixes, security fixes, and small compatible corrections.

MINOR
1.0.0 → 1.1.0
A significant new backward-compatible capability.

MAJOR
1.x → 2.0.0
Breaking architecture, contract, configuration, or compatibility change.
```

## 6. Current roadmap sequence

### A. Single approved workspace root

Status: Completed migration milestone. The registry/adapter version implemented on 2026-09-10 was superseded by the production Native `/workspace` contract.

The earlier per-project registry proved that guessed/unregistered paths could be blocked, but it also created unnecessary maintenance: every new sibling project required another registry entry. That project catalog was removed before the final Native cutover.

Current production rule:

```text
open_workspace path == /workspace
→ execute inside the Native runtime

anything else
→ fail closed
```

The owner-selected host filesystem root is mapped to `/workspace`. Projects such as `webmcp-bridge`, `webmcp-bridge-plus`, or future sibling directories are accessed beneath that already-open workspace and do not need individual registration or aliases.

Current requirements:

- no per-project registry or routing-layer project catalog;
- `open_workspace` exposes only `/workspace`;
- traversal and paths outside the mounted root fail closed;
- the broader root workspace does not authorize cross-project changes: before modifying a child project, read its nested instructions and scope work to the user-selected project;
- no new MCP tool is added; the existing five-tool surface is preserved.

The 2026-09-09 registry experiments remain historical evidence for fail-closed routing, but their DevSpace adapter/project-name/alias machinery is no longer part of production.

### B. DevSpace container auto-recovery

Status: Completed historical migration milestone, then retired from production after the Native cutover. Host-side `dsup.sh --ensure` was independently reviewed, deployed, and verified on the reference macOS host, including a real machine-reboot recovery test on 2026-09-10. The separate stale-OAuth-after-container-replacement bug was root-caused and fixed in `#resetOAuthState()` (PR #4, merged, `main` at `249915ce159bedf235a12b350d0ceecf61027aff`); see `docs/troubleshooting.md` §19.

Historical goal: prove unattended recovery of the DevSpace transition runtime without weakening its security model. This mechanism is no longer required by current production.

Historical repository-side design:

- a dedicated per-user LaunchAgent directly invoked host-only `~/Doc/devspace-container/dsup.sh --ensure`;
- it used `RunAtLoad` plus a periodic `StartInterval` and no persistent keepalive behavior;
- it did not execute repository code, DevSpace-mounted code, Node recovery controllers, or direct Docker lifecycle commands from the LaunchAgent;
- container creation and security policy remained inside the host-side `dsup.sh` control plane;
- Docker temporarily unavailable produced a transient non-zero ensure result so a later interval could retry;
- unsafe existing container state failed closed and was not deleted or replaced automatically.

During the transition, host-side `--ensure` enforced the local Docker context, loopback-only binding, approved project mount, exact read-only credential overlays, image policy, `publicBaseUrl` normalization, and secret/mount checks. The repository-side installer deliberately did not duplicate those rules or add a separate public-endpoint detector.

Both the LaunchAgent and the host-side `dsup.sh --ensure` contract were installed and verified during the transition. They are historical evidence, not current Native production dependencies.

### C. Native WebMCP production migration

Status: **Completed. Native WebMCP is the current production architecture.** The clean Native-only migration, permanent cutover, reboot proof, final identity cleanup, and DevSpace operational retirement are complete.

The production runtime removes DevSpace from the ChatGPT/WebMCP execution path:

```text
Secure MCP Tunnel
→ immutable minimal host boundary
→ verified Native container
→ Native MCP server
→ /workspace
```

The completed Native implementation includes:

- five Native tools (`open_workspace`, `read`, `write`, `edit`, `bash`) with runtime-bound workspace IDs;
- fixed MCP-visible `/workspace` with owner-selected host root configuration;
- sentinel mount-identity probe and mandatory non-recursive bind semantics;
- canonicalized control-plane carve-outs that fail closed;
- thin host response Secret Firewall with opaque request forwarding and process-level failure on runtime faults;
- host startup that verifies/ensures container policy before any `docker exec`;
- non-root runtime policy, capability drop and `no-new-privileges` checks;
- source-gated host snapshot reuse rather than a second release mechanism;
- separately-authorized Git publication path requiring key, `known_hosts`, and explicit commit identity;
- reviewed-source → Docker image label → immutable image/source pin verification;
- repo-side E2E with no DevSpace process in the Native execution chain.

Completed production release gates include:

- clean reviewed Native image/build and workspace mount validation;
- real Docker sentinel/carve-out validation;
- Secure MCP Tunnel canary against the Native immutable host entrypoint;
- real ChatGPT → WebMCP → Native end-to-end validation;
- permanent Native launchd activation/cutover;
- real reboot/recovery proof and post-reboot ChatGPT validation;
- DevSpace operational runtime/container/profile/key/LaunchAgent retirement;
- migration `-v2` artifact and rollback-profile removal;
- final Native smoke test and housekeeping.

Optional Git publication remains a separately authorized capability and is not required for the base production runtime.

Trust note: any writable workspace combined with arbitrary `bash` lets the model author code/configuration that the host owner may later execute. Narrow Project mode confines that authorship mainly to one project; Advanced broad-filesystem mode can reach host persistence locations and is the highest-trust profile even when network is disabled.

### C.1 Base installer and onboarding

Status: **Implemented in repository; fresh-user acceptance harness ready, real fresh-Mac/new-user execution still pending.**

The Base macOS installer now provides one lifecycle surface for `install`, `status`/`doctor`, workspace-root `reconfigure`, and `uninstall`. It reuses the existing Native image/source gate, workspace identity probe, container controller, immutable host-runtime promotion, `tunnel-client` CLI and one per-user LaunchAgent. It does not add a daemon/controller, project registry, compatibility layer or DevSpace dependency.

Normal onboarding requires the owner to choose only the host workspace root and supply the owner-created Secure MCP Tunnel identity/credential locally. OpenAI tunnel/account UI authorization and the final ChatGPT WebMCP App connection remain explicit owner actions. Optional Git publication remains outside the Base installer.

A thin `npm run validate:fresh-user -- ...` acceptance harness now makes the release gate repeatable without adding another installer policy layer. It first requires the existing installer to report `state=fresh`, then delegates to the same `install`, `doctor`, and `status` commands. Any non-fresh state aborts before installation mutation, and the harness never uninstalls an existing deployment or automates the final ChatGPT account/App authorization.

The remaining gate is to run that harness from a genuinely fresh Mac or fresh macOS user and then prove the first ChatGPT `open_workspace("/workspace")` connection. Do not use the current production owner runtime as a destructive installer test fixture.

### D. Developer Efficiency Phase 1

Status: IMPLEMENTED / active measurement from 2026-09-10 against the current WebMCP workflow.

Use the repository-local inspection/validation workflows on real development tasks and keep collecting comparable evidence before changing the MCP surface.

### E. Inherited Native execution-host baseline

Status: **Imported from the current stable `webmcp-bridge` baseline.**

Plus reuses the production-accepted Native execution-host model: immutable host runtime, isolated Native container, fixed `/workspace`, five-tool MCP surface, Secret Firewall, Base installer, V1.1 time-bound elevated access, Menu Bar controls, and current regression/security gates. These inherited host mechanisms should remain as close as practical to the stable project unless Plus has a concrete host-side requirement.

### F. Plus multi-host foundation

Status: **Active — minimal Phase 1 host identity + exact project registry + fail-closed route decision implemented. The first concrete E2E transport is OpenSSH using stable `hostId` as the owner-managed SSH Host alias. Live host state and capability negotiation remain deferred pending a real consumer.**

The first Plus development target is the multi-host routing foundation. It must sit above independent Native WebMCP execution hosts rather than widen one host into a cross-machine filesystem/shell proxy. The minimal Phase 1 contract is documented in [`plus-control-plane.md`](./plus-control-plane.md). [`plus-transport-options.md`](./plus-transport-options.md) records the first direct OpenSSH binding; the transport reuses mature SSH security and the existing immutable Native stdio host entrypoint instead of adding WebMCP cryptography.

Sequence:

1. stable execution-host identity that does not rely on hostname alone;
2. data-only host/project registry with no secrets or runtime credentials;
3. explicit fail-closed host/project route decision;
4. use OpenSSH over the owner's existing mesh/VPN as the first concrete transport, with stable `hostId` passed directly as the SSH Host alias;
5. reuse OpenSSH peer authentication, confidentiality, integrity, host-key verification and transport replay properties; add no application-layer cryptography because no missing security property is currently demonstrated;
6. use only the fixed immutable Native host stdio entrypoint and fail explicitly on SSH/remote-command failure, with no fallback;
7. validate the route on two owner-controlled hosts; add live availability state only if a real runtime consumer requires it;
8. durable agent/session management and higher-level orchestration only after the earlier layers prove useful.

Core invariants:

- no arbitrary filesystem discovery across hosts;
- no fallback to another host when the selected host is missing/offline;
- no host stores another host's local credentials or mounts another host's files;
- invalid or missing project/host identity must fail, never guess;
- `workspaceId` and future durable-session identity are always scoped to one execution-host identity;
- the stable five-tool execution-host primitive surface remains unchanged unless a new primitive is independently justified.

### G. Developer Efficiency Phase 2 decision

Status: **Decision closed — keep the current five-tool WebMCP surface.**

The historical DevSpace benchmark and a second controlled Native WebMCP benchmark on 2026-09-13 both show that repository-local batching removes the material fixed round-trip overhead without adding MCP methods or permissions. In the Native sample, inspection dropped from 4 WebMCP round trips / 22.585 s to 1 round trip / 0.224 s, while validation dropped from 3 round trips / 30.577 s to 1 round trip / 17.379 s; the remaining validation time was dominated by the real repository test/build work.

Do not add `inspect_workspace` or `validate_workspace` merely to wrap the existing repository workflows. Reopen Phase 2 only if repeated future tasks show material overhead that cannot be removed by safe batched `bash`/`read` usage. Batch-write capability remains out of scope absent separate evidence and security review.

### H. Local time-bound elevated Mac access lease

Status: **Completed and production-accepted on the reference MacBook Pro for v1.1.0.** The owner-facing Menu Bar flow, local grant/revoke controls, elevated read/write, network-off behavior, fixed absolute expiry, automatic restoration, sleep/wake behavior, running-work expiry enforcement, and reboot non-resurrection have all passed real-host acceptance. Fresh-Mac/new-user installer validation remains a separate Base-installer gate, not a blocker for v1.1 reference-Mac acceptance.

Goal: allow the owner to temporarily grant ChatGPT/WebMCP a broader writable Mac filesystem scope for work that genuinely needs it, without turning broad host access into a permanent account-level capability.

Target operating model:

```text
normal state
→ narrow approved workspace only

owner approves locally on the Mac
→ temporary elevated host-filesystem lease
→ fixed duration, default and maximum 1 hour
→ visible local countdown/status
→ owner may revoke immediately
→ expiry automatically returns to the narrow workspace

renewal
→ requires another explicit action on that Mac
→ cannot be created, extended, or restored only from a remote ChatGPT/browser session
```

Security invariants:

- lease creation, renewal, and immediate revocation are controlled by a **local Mac UI/host-side gate**, not by an MCP tool or remote model request;
- the model may consume an already-active lease but cannot mint, extend, or silently reactivate one;
- expiry is enforced by the host from the lease's fixed absolute deadline and must not depend on continued browser connectivity;
- the host relay checks that same absolute deadline before forwarding new elevated input and triggers the existing revocation path once expired;
- remote tool activity cannot reset, renew, or extend the authorization;
- after expiry/revocation, existing long-lived processes must not retain the elevated mount/capability; the host boundary must return to the normal narrow workspace before further calls are accepted;
- local status must make elevated mode obvious and provide a one-action kill switch;
- broad writable host access remains a high-trust capability even with network disabled, because `bash` plus host-writable paths can create persistence or modify code/configuration the owner later executes;
- secrets/control-plane carve-outs and the host Secret Firewall remain enforced; an elevated lease must not implicitly expose tunnel credentials, Docker control sockets, WebMCP control-plane state, or other explicitly protected paths.

Default policy to evaluate first:

```text
fixed lease:    60 minutes default and maximum
renewal:        none; a new lease requires another local owner grant
revocation:     immediate local kill switch
fallback:       normal narrow workspace
```

Important limitation to preserve in the design: **local-only renewal prevents another logged-in browser from reopening an expired lease, but a still-active lease is not automatically bound to one browser session.** If the product requirement becomes "another machine logged into the same ChatGPT account must never be able to use even an already-active lease", then a separate local-session-binding / presence mechanism is required and must be designed explicitly rather than assumed.

Implemented design: a thin host-side lease/capability gate reuses the existing Native workspace verifier, container policy/controller, immutable host runtime, LaunchAgent lifecycle, and control-plane masks. A protected mode-`0600` host lease records only the bounded lease identity, current boot identity, current macOS GUI login/audit-session identity, normal/elevated roots, and issue/absolute-expiry timestamps. The normal workspace configuration is not overwritten.

The local owner CLI is:

```text
webmcp elevate --root <scope> [--duration <duration>]
webmcp elevate-status
webmcp elevate-stop
```

`elevate` starts from the immutable local CLI, but authority is created only after the logged-in macOS GUI session approves a system confirmation dialog; a remote SSH/pseudo-TTY cannot substitute for that local approval. There is no MCP command or non-interactive approval flag. The security-sensitive elevation commands execute only from the verified source-gated immutable host snapshot; invoking the grant implementation from a writable repository checkout is rejected. While elevated, the temporary container remains non-root with `CapDrop=ALL`, `no-new-privileges`, Docker-socket isolation, the existing control-plane carve-outs, **network disabled**, and Git publication credentials disabled. The container is lease-labelled so stale/rebooted/expired elevated state can be distinguished from the normal policy without making the lease file itself model-writable.

Authorization uses one fixed absolute deadline with no activity-based early expiry or automatic renewal. Request bytes remain opaque at the immutable host relay; before forwarding new elevated input, the relay compares `Date.now()` with the same lease deadline used by the expiry timer and triggers the existing restore/revocation path once expired. Expiry/revocation closes the active container executor before the elevated mount is removed. Lease authority is invalidated before restore work; failure to restore normal mode leaves the service stopped/fail-closed rather than keeping elevated access available.

Real-Mac acceptance evidence (2026-09-13):

- compatibility-fixed candidate `3f468897d0ea0006326e9a30ed428d09ac55a350` was built from a clean committed tree and activated through the existing Native Secure MCP Tunnel;
- `doctor` reported the installation healthy with the normal root `/Users/zengtao/Doc/My code`, Tunnel ready, Native container running, and the expected immutable host artifact;
- the owner locally approved a five-minute lease for `/Users/zengtao/WebMCP-V11-Acceptance`; from ChatGPT/WebMCP during that lease, `/workspace` exposed that scope, an existing marker file was readable, a new file was written and reread, and the former normal workspace was not visible;
- the elevated container exposed no network routes and Git publication remained disabled;
- after the fixed absolute deadline, a fresh ChatGPT/WebMCP connection showed the normal `~/Doc/My code` workspace again, the acceptance files were no longer visible, and normal network routes were restored without reboot or manual cleanup;
- a second 10-minute lease was then revoked immediately with local `elevate-stop`; the CLI returned `action: revoked`, and a fresh ChatGPT/WebMCP connection immediately showed the normal workspace again, with elevated acceptance files no longer visible and normal network routes restored;
- sleep/wake across expiry also passed: the owner explicitly put the Mac to sleep during a short elevated lease, woke it after the absolute deadline, and the next ChatGPT/WebMCP connection was already back on the normal workspace with elevated acceptance files hidden and normal networking restored;
- the final native Menu Bar flow passed on the real Mac: Full Working Access mapped the owner's home directory to `/workspace`, the countdown/status was visible, immediate GUI Stop restored the normal workspace, protected WebMCP control-plane paths remained masked, and elevated networking remained disabled;
- running-work-across-expiry passed: a task that wrote `started` before expiry did not survive long enough to write its post-expiry marker, and the runtime returned to the normal workspace/network policy;
- reboot non-resurrection passed: the owner rebooted the Mac while a 30-minute elevated lease was still active and deliberately did not revoke it first; after login, a fresh WebMCP connection exposed only the normal workspace and normal networking, with no elevated Home scope restored;
- the optional native `Launch at Login` Menu Bar control was added using `SMAppService.mainApp` and enabled successfully by the owner; automatic relaunch on a later login/reboot is a convenience follow-up, not an elevation-security release gate;
- GUI logout/login and split-frame/near-deadline relay behavior remain optional hardening follow-ups rather than blockers for the accepted v1.1 reference-Mac release.

Reference-Mac acceptance criteria for normal use:

- default state is narrow access after fresh install, restart, crash, or lease expiry;
- broad access cannot be enabled or renewed through ChatGPT/WebMCP alone;
- fixed absolute expiry and pre-forward deadline enforcement are proven on the real Mac, including sleep/wake across the deadline;
- expiry/revocation removes elevated access from subsequent tool calls without requiring a reboot;
- local owner can revoke immediately even while a tool call/session exists;
- reboot never resurrects a prior elevated lease; GUI logout/login follows the same boot/login identity fail-closed design and remains an optional additional real-host check;
- audit/status output records lease start, expiry/revocation, and current scope without logging secrets;
- failure of the local lease controller is fail-closed to the narrow workspace.

Non-goals for the first version:

- no permanent "full disk" mode;
- no remote renewal;
- no new MCP permission-management tool;
- no cloud-stored lease state;
- no attempt to solve multi-host authorization here; that remains a future `webmcp-bridge-plus` concern.

### I. Durable Agent Sessions and Conversation Handoff

Status: **Planned Plus phase after host identity/routing is stable.** Do not implement it in parallel with the first routing foundation, but do not defer it indefinitely waiting for a crisis either.

Durable sessions solve a different problem from multi-host routing: routing answers **where work should execute**; durable sessions answer **how work survives conversation/connection replacement and how another conversation resumes or takes over the same logical task safely**.

These directions are distilled from patterns seen in Local Coding Agent / Compact & Resume, local-shell-mcp durable logical sessions, localshell-web-supervisor conversation replacement/reconciliation, Desktop Commander long-running process and bounded-output patterns, and the official MCP filesystem root/path security model. They are design references, not architectures to copy.

Governing rule:

> Observe a real blocker first, then introduce the smallest mechanism that solves it.

For each capability below, preserve the current stable low-level WebMCP tool surface unless the stated trigger demonstrates that the existing Skill/workspace/Git workflow is insufficient.

#### A. Durable logical session

- **Potential capability:** durable objective, findings, blockers, exact next action, and explicit handoff/takeover across conversations or workers.
- **Trigger:** one project genuinely needs multiple concurrent Chats, one task spans many conversations, replacement workers are common, or explicit takeover becomes a real coordination requirement.
- **Borrow:** the logical-session/handoff model from local-shell-mcp while keeping reconciliation with actual workspace/Git state.
- **Do not build prematurely:** no V1.1 session database, worker registry, conversation backend, or generalized coordinator. The current single active semantic checkpoint remains sufficient until the trigger exists.

#### B. Multi-task resume registry

- **Potential capability:** several resumable tasks under `/workspace/.webmcp/resumes/` plus lightweight active-task selection.
- **Trigger:** the same workspace must keep multiple independent long-running unfinished tasks resumable at the same time.
- **Borrow:** explicit task selection with small Markdown state rather than hidden conversational memory.
- **Do not build prematurely:** no task registry, task IDs, index database, or multiple active-task machinery while one active task is enough.

#### C. Explicit conversation replacement / takeover

- **Potential capability:** a replacement conversation/worker reconciles durable intent with jobs, workspace, and Git before declaring takeover.
- **Trigger:** disappearing/replaced workers create repeated recovery ambiguity that the single-checkpoint workflow cannot resolve reliably.
- **Borrow:** the reconciliation-first takeover idea from localshell-web-supervisor.
- **Do not build prematurely:** do not copy a supervisor architecture merely to support handoff. Preserve `persistent intent != actual runtime state`; verify actual state before takeover.

#### D. Structured compact/resume capability

- **Potential capability:** an explicit structured `compact_context` / `resume_context`-style product workflow instead of relying only on Markdown conventions.
- **Trigger:** Markdown triggering proves unreliable, multi-session coordination becomes real, or ChatGPT/MCP exposes a formal conversation/session handoff API.
- **Borrow:** compact/resume ergonomics that preserve only decision-relevant context.
- **Do not build prematurely:** no new MCP resume tools in V1.1 and no custom protocol that duplicates a future official product surface.

#### E. Skill-driven capability expansion

- **Potential capability:** evolve higher-level workflows through Skills while keeping the five low-level Native tools stable.
- **Trigger:** a new workflow can be expressed reliably as orchestration/instructions without requiring a new primitive or security boundary.
- **Borrow:** the stable-tool-surface + evolving-skill pattern seen in local-shell-mcp-style systems.
- **Do not build prematurely:** avoid tool-schema churn, plugin re-approval surface, compatibility branches, and extra tool-selection complexity when existing primitives already suffice.

#### F. Context efficiency / bounded tool output

- **Potential capability:** stricter bounded reads, pagination/selective ranges, and selective retrieval of large diff/test/build output so only reasoning-relevant information enters ChatGPT context.
- **Trigger:** measured long-conversation degradation or repeated oversized `read`, `bash`, diff, test-log, or build-output transfers.
- **Borrow:** bounded reads/output pagination/selective retrieval patterns from Desktop Commander and Local Coding Agent-style tools.
- **Do not build prematurely:** do not hide failures, truncate required evidence, or add composite tools solely to reduce token count. Keep large data local and retrieve the minimum evidence needed for the current reasoning step.

#### G. Long-running job/session management

- **Potential capability:** durable job handles with bounded inspection and cancellation for real long-running builds, dev servers, watchers, or asynchronous local jobs.
- **Trigger:** ordinary bounded `bash` can no longer represent the required workflow without losing control of legitimate long-running processes.
- **Borrow:** long-running process/session patterns from Desktop Commander and local-shell-mcp.
- **Do not build prematurely:** do not turn current `bash` into a process supervisor, daemon, watcher framework, or generic job-control subsystem before that requirement exists.

#### H. Audit / observability

- **Potential capability:** bounded audit evidence for who/what requested an action, which tool ran, high-level result, and security-boundary decisions.
- **Trigger:** enterprise audit requirements, multiple workers, difficult recovery debugging, or security-event investigation become real requirements.
- **Borrow:** small structured operational evidence sufficient for accountability and debugging.
- **Do not build prematurely:** do not record full prompts/content, create a second activity database, or retain sensitive payloads without an explicit requirement and separate security/privacy review.

These future directions must remain capability hypotheses with explicit triggers. A roadmap entry is not authorization to implement it, and future designs should reuse/delete/simplify before introducing another state store, controller, daemon, tool, or compatibility layer.

### J. Future shared execution-host capability: Managed Network during Full Working Access

Status: **Planned cross-product execution-host capability; not part of the current Plus multi-host phase and not yet authorized for implementation.**

Plus must preserve the same security direction recorded in stable `webmcp-bridge`: broad filesystem authority and network authority are separate capabilities. The current/default elevated mode remains **Full Working Access + container Network OFF**.

Future target:

```text
Plus Control Plane
      ↓ selects host only
Execution Host
      ├── Full Working Access — Offline (default)
      │     broad local filesystem lease + container Network OFF
      │
      └── Full Working Access — Managed Network (optional/future)
            broad local filesystem lease
            container still has no unrestricted internet
            external retrieval only through a constrained host-side fetch/proxy broker
```

The capability belongs to each execution host, not to the central Plus Control Plane. Plus may route to a host, but the control plane must not gain that host's filesystem paths, cookies, ambient credentials, arbitrary network socket access, or permission to bypass local owner approval. Any future capability signaling must be justified by an actual routing/runtime consumer rather than pre-built as generic metadata.

Required invariants:

- reuse the same execution-host security contract in stable WebMCP and Plus rather than inventing two incompatible networking models;
- keep unrestricted Docker/container networking disabled while a broad filesystem lease is active;
- managed retrieval must use a separately policy-enforced host-side broker with destination/protocol allowlists, bounded `GET`/`HEAD`, bounded redirects/size/timeouts, and no arbitrary upload/request body/cookie/ambient credential by default;
- ordinary HTTP is not truly receive-only: DNS names, URLs, query strings, headers, redirects, and connection metadata can all become outbound exfiltration channels and therefore require validation;
- the broker itself must not read `/workspace` or other host files; it receives only the validated request and returns bounded untrusted response content;
- unfamiliar destinations require explicit local owner approval or fail closed; no silent broadening and no fallback to unrestricted networking;
- network capability is local-host policy and must not be auto-enabled merely because the Plus router selected that host;
- future two-host E2E must prove that managed-network permission on host A grants no network/filesystem authority on host B.

Implementation sequencing: keep the current Plus host identity / registry / route foundation minimal. When Managed Network is implemented in the stable execution-host layer, Plus should consume/reuse that host-level capability rather than duplicate it in the control plane.

### K. Shared execution-host code strategy

Status: **Design constraint, not a request to create another repository now.**

Stable WebMCP and Plus currently live in separate repositories, so execution-host improvements do not propagate automatically. For shared capabilities such as Native container policy, Secret Firewall, temporary elevation, and future Managed Network, keep the implementation boundaries reusable and behaviorally aligned. Only extract a shared package/core repository after repeated real maintenance shows that synchronized copies are becoming a source of drift; do not create a third framework pre-emptively.

## 7. Planning discipline

When a new material development idea is accepted:

1. add it to this roadmap;
2. record its status and sequencing;
3. link a detailed design document if one is needed;
4. record important non-goals/security boundaries;
5. update the status when implemented, committed, pushed, or superseded.

Chat history and assistant memory are not the canonical project roadmap.

The repository is.
