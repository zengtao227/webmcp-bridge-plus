# Threat Model

## Security objective

Allow a browser-hosted AI model to use useful coding tools through remote MCP while preventing high-value local credentials from becoming model context or escaping through bridge-controlled channels.

The model, web page content, tool requests, tool output, and remote service responses are treated as potentially adversarial.

## Assets

Primary assets to protect include:

- exchange API keys and secrets;
- wallet/private keys and seed material;
- `.env` credentials;
- GitHub tokens;
- AWS/cloud credentials;
- SSH private keys;
- database passwords;
- bearer/access/refresh tokens;
- passphrases;
- DeepSeek Web session credentials;
- MCP OAuth credentials;
- sensitive source/configuration that the user did not authorize for model disclosure.

## Trust boundaries

Current production Native path:

```text
[ChatGPT / Web AI model]
          |
          | untrusted MCP requests
          v
[OpenAI Secure MCP Tunnel]
          |
          v
[immutable Native host boundary]
          |
          | verified relay / lifecycle only
          v
[Native WebMCP container]
          |
          | five-tool execution
          v
[/workspace / owner-selected host root]
```

A second critical boundary exists on the return path:

```text
raw Native MCP result / diagnostic -> host Secret Firewall -> sanitized model context
```

No provider adapter or transport may bypass that boundary. The DeepSeek/Chrome-extension subsystem is separate and retains its own browser-origin trust boundary.

## Threats and mitigations

### T1 — Prompt-driven secret read

**Scenario:** The model requests `.env`, `~/.ssh/id_ed25519`, AWS credentials, a wallet, or another sensitive file.

**Mitigations:**

- deterministic path policy before file reads whenever a path is available;
- the Native sandbox exposes only the owner-selected `/workspace` mount plus explicitly reviewed protected/optional mounts;
- known secret filenames/directories denied by default;
- deny decision is returned instead of file contents.

**Residual risk:** Secrets may exist under unexpected filenames inside an approved project, requiring content scanning as defense in depth.

### T2 — Secret embedded in ordinary source or command output

**Scenario:** A normal source/config/log file contains `API_KEY=...`, a bearer token, JWT, private key, cloud credential, or high-entropy secret.

**Mitigations:**

- content redaction after MCP execution and before model continuation;
- multiple high-confidence detectors;
- user-defined regex support;
- scanner metadata contains reason/count only, not raw matches.

**Residual risk:** No heuristic scanner detects every possible secret. Sandboxing, path controls, minimal mounts, and future entropy/context improvements remain necessary.

### T3 — Path traversal / separator bypass

**Scenario:** A request uses `src/../.env`, repeated separators, or Windows separators to evade basename checks.

**Mitigations:**

- normalize separators;
- collapse `.` and `..` segments conservatively;
- evaluate normalized segments and basename;
- adversarial tests for traversal variants.

### T4 — Malicious custom redaction configuration

**Scenario:** Invalid or pathological user regex configuration weakens scanning or crashes the policy layer.

**Mitigations:**

- compile/validate policy at configuration time;
- invalid rules fail closed;
- limit flags/features supported by the public policy API;
- do not silently skip malformed patterns.

**Future work:** Add explicit complexity/length limits if arbitrary regex configuration is exposed in the UI.

### T5 — DeepSeek session credential extraction

**Scenario:** Extension code copies browser-managed DeepSeek credentials into storage, logs, MCP requests, or another context where they can leak.

**Mitigations:**

- prefer authenticated requests inside `chat.deepseek.com` page/session context;
- never persist session credential values;
- never include them in MCP payloads or logs;
- require design review before any exception.

### T6 — MCP OAuth credential leakage

**Scenario:** MCP access/refresh tokens are persisted in ordinary extension state or returned to the model via errors/logs.

**Mitigations:**

- keep auth handling isolated from model-visible messages;
- redact authorization headers and bearer values;
- never log raw tokens;
- persist endpoint configuration separately from credentials.

### T7 — Broad Chrome permissions

**Scenario:** The extension gains access to unrelated websites or host powers, increasing compromise blast radius.

**Mitigations:**

- only `chat.deepseek.com` is pre-authorized;
- MCP origins requested individually by explicit user action;
- no `<all_urls>`, blanket HTTP access, Native Messaging, or `chrome.debugger`;
- permission changes require threat-model review.

### T8 — Direct host compromise through bridge design

**Scenario:** The model or optional browser-provider subsystem gains a path to unrestricted host shell/filesystem access, or the Native runtime is created with a broader host boundary than the owner authorized.

**Mitigations:**

- no Native Messaging or direct host-user shell in the base product;
- coding operations execute only inside the verified Native container;
- the model-visible root is fixed at `/workspace` and backed only by the owner-selected host root;
- macOS `/` and the Docker socket are not accepted as normal workspace exposure;
- protected WebMCP/tunnel control-plane paths are carved out even when they fall beneath a broad selected root;
- do not blindly inherit host environment variables.

### T9 — Tool result bypass

**Scenario:** A code path sends raw MCP output directly to the DeepSeek continuation mechanism without scanning.

**Mitigations:**

- one bridge-facing `tool-policy` entry point;
- adapters receive sanitized results only;
- integrated tests should assert that forwarding raw results is structurally impossible;
- avoid exporting lower-level transport results directly to page code.

### T10 — Secret leakage through logs/diagnostics

**Scenario:** Debug logs capture tool payloads, blocked file contents, authorization headers, or session credentials.

**Mitigations:**

- log metadata/reason codes rather than raw sensitive payloads;
- no raw blocked values in redaction reports;
- diagnostics should use bounded safe previews only where necessary;
- production logging defaults should be conservative.

### T11 — Malicious repository content attacks the model

**Scenario:** A repository file contains prompt injection instructing the model to read or exfiltrate secrets.

**Mitigations:**

- repository/tool output remains untrusted;
- model instructions cannot override path/tool/content policy;
- all subsequent tool calls are independently authorized;
- secret values remain filtered even if the model asks for them explicitly.

### T12 — Compromised or malicious MCP backend

**Scenario:** The configured MCP endpoint sends crafted results, misleading metadata, or secret-looking content.

**Mitigations:**

- connect only to user-approved HTTPS origins;
- treat all MCP results as untrusted;
- scan return content regardless of backend trust;
- do not grant an MCP server access to DeepSeek session credentials.

### T13 — Container-to-host execution through writable runtime code

**Scenario:** Native WebMCP can modify files in the owner-selected writable workspace, while a host LaunchAgent, tunnel runtime, or container controller later executes code directly from that same tree (or through a symlink into it). Workspace write access would then become a path to execute code as the host user.

**Mitigations:**

- no unattended host process executes code from the model-writable workspace tree;
- production host runtime/controller code is deployed as immutable source-gated material outside the workspace;
- deployment accepts only reviewed source identity and verifies exact manifests/digests;
- host execution does not follow repository/workspace symlinks into mutable code;
- image/source/policy identity is verified before any `docker exec`;
- protected runtime/tunnel/configuration paths remain outside or masked from the workspace.

### T14 — Native Git publication credential abuse

**Scenario:** A model, malicious repository instruction, or compromised process uses the separately authorized Native Git credential to publish unintended commits or to attack repositories outside the approved scope.

**Mitigations:**

- keep Git publication disabled by default;
- use a dedicated, revocable credential scoped only to `webmcp-bridge` when publication is explicitly enabled;
- never expose the owner's normal SSH key, GitHub CLI token, or credential store;
- keep the WebMCP development identity unable to publish directly to `main`;
- require the repository CI gate for review-branch/PR validation and run the same gate on `main` pushes;
- permit the development identity to publish review branches such as `chatgpt/*`, but not to force-push, delete refs/tags, administer the repository, write workflows/secrets, or bypass branch protection;
- treat an independently invoked release reviewer and its publication identity as a separate trust role governed by `docs/release-review-policy.md`; it must not obtain or reuse the development publication credential;
- advertise Git writes as supported without making commit/push automatic.

**Residual risk:** Any process in the Native container can use or copy an enabled repository-scoped credential. Treat it as potentially compromised and revoke it if unexpected branches or authentication activity appear.

### T15 — Native container/control-plane substitution

**Scenario:** The tunnel launches the Native host relay while a same-named container was created with weaker mounts, networking, capabilities, user identity, or a different image/source payload. A bare `docker exec webmcp-native ...` would silently cross the intended trust boundary.

**Mitigations:**

- Native host startup runs the source-gated container controller before any `docker exec`;
- image pin binds immutable image ID to the reviewed Native runtime-group digest (`dist/native/manifest.json` → `groupSha256.runtime`);
- controller checks the image source label before inspecting/using the container;
- container policy digest and image identity are recorded as labels;
- controller independently checks non-root UID/GID, `CapDrop=ALL`, `no-new-privileges`, network mode, workspace mount and optional Git secret mounts;
- policy drift fails closed; the host boundary never silently replaces or executes into a mismatched container;
- host controller/policy/config parser dependencies are themselves part of the immutable host-runtime source gate.

### T16 — Writable workspace becomes future host code

**Scenario:** `bash`, `write`, or `edit` changes files in a host-mounted writable workspace that the owner later executes on the host. In a project this can include Git hooks, package scripts, build files, or source code. With a broad home/filesystem mount it can include shell startup files or other host persistence locations.

**Mitigations / trust statement:**

- treat every writable workspace with arbitrary `bash` as **host-code authorship**, not as a guarantee that model effects end at the container boundary;
- use narrow Project mode by default when broad filesystem access is unnecessary;
- Advanced broad-filesystem mode is explicitly highest-trust and defaults to network off;
- keep WebMCP's own launcher/config/runtime/tunnel trust plane carved out even in broad modes;
- do not claim that network isolation, `CapDrop`, or Secret Firewall prevents later host execution of files the owner deliberately allowed the model to write;
- do not attempt to enumerate/mask every possible host persistence vector; that would be incomplete and would create a false security claim.

### T17 — Remote or stale temporary-elevation authority

**Scenario:** The model attempts to mint/renew broader filesystem authority remotely, reuse a lease after reboot/expiry, forward new work after the absolute deadline, or keep an old elevated container reachable after the lease should have ended.

**Mitigations:**

- no MCP tool, remote endpoint, writable workspace file, or non-interactive approval flag can create or renew a lease;
- the elevation lifecycle CLI must execute from the verified source-gated immutable host snapshot; grant attempts from a writable checkout are rejected;
- grant starts from the immutable local CLI but authority is created only after the logged-in macOS GUI session approves a system `osascript` confirmation dialog; a remote SSH/pseudo-TTY cannot substitute for that local approval, and lifetime is capped at one hour;
- lease state is mode-`0600` in the protected host control plane and is bound to a random lease ID plus both the current macOS boot identity and GUI login/audit-session identity;
- malformed, stale, expired, reboot-mismatched, login-session-mismatched, or normal-root-mismatched lease state grants no authority;
- authorization is fixed-duration with a default and maximum of one hour, with no automatic or remote renewal; before forwarding new elevated input, the immutable host relay checks the same absolute deadline as the lease/expiry timer and triggers the existing revocation path once expired;
- an elevated container is separately lease-labelled, runs with network off and without Git publication secret mounts, and retains the normal hardening/control-plane masks;
- expiry/revocation closes the active executor before removing the elevated container and restoring normal `/workspace` policy;
- if an old elevated container cannot be identified safely, cleanup fails closed instead of deleting/reusing ambiguous state; if normal restoration fails, the tunnel/service remains stopped.

**Residual risk:** During an intentionally active lease, the model can modify any non-carved-out file beneath the owner-selected elevated root, including files the owner may later execute. v1.1 also does not bind an active lease to one browser session; local-only grant prevents remote renewal, not use of an already-active tunnel session.

## Out of scope for the base product

The base Native product intentionally does not attempt to secure capabilities it does not provide:

- Native Messaging;
- direct host-user shell;
- unrestricted host filesystem access outside the owner-selected `/workspace` root;
- Chrome debugger control;
- general browser automation;
- Google Drive / OneDrive;
- unrelated memory systems;
- DeepSeek API-key execution.

Adding any of these changes the threat model and requires an explicit architecture decision first.

## Security test minimums

Security tests should cover at least:

- every default blocked path class;
- traversal/separator bypass attempts;
- allowed near-miss paths to control false positives;
- named secret assignments in common syntaxes;
- private-key blocks;
- bearer/JWT/GitHub/AWS patterns;
- high-entropy values and safe high-entropy-looking near misses;
- multiple redactions in one result;
- custom regex validation and redaction;
- no raw secret values in redaction metadata;
- fail-closed behavior when policy/scanning fails.

## Review trigger

Update this threat model before merging changes that add:

- a Chrome permission;
- a new storage location;
- a new credential flow;
- a new MCP transport/auth mechanism;
- a tool class with broader filesystem/network/command capabilities;
- telemetry/logging;
- a provider adapter beyond DeepSeek Web.
