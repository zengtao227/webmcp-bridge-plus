# Security Policy

WebMCP Bridge exists to make AI-assisted local development safer. Security controls in this repository are part of the product contract, not optional guidance to the model.

Native WebMCP is the current production architecture. The former DevSpace runtime is retired from the production execution path. The former DeepSeek Web browser-extension subsystem was removed; DeepSeek Web integration is developed in the independent `deepseek-webmcp` project.

## Trust boundaries

Treat all of the following as untrusted unless explicitly validated:

- model-generated tool requests;
- MCP requests, results, runtime diagnostics, and remote metadata;
- repository/workspace contents returned by tools;
- files the model can modify inside the owner-selected workspace;
- user-supplied custom redaction patterns.

The AI model is not part of the trusted computing base.

## Security invariants

1. **Secret Firewall before model context.** Native JSON-RPC results and diagnostics cross the independent host response boundary only after deterministic validation/redaction. Provider-specific forwarding must not bypass the same principle.
2. **Blocked files are blocked before read whenever possible.** Structured Native file tools deny known-sensitive paths before returning content instead of relying only on post-read redaction.
3. **Fail closed.** Invalid policy/configuration, image/source mismatch, container-policy drift, malformed output, or ambiguous sensitive operations must not silently weaken the boundary.
4. **No secret logging.** Logs must never contain raw tunnel/runtime credentials, MCP bearer/refresh tokens, API keys, private keys, passwords, passphrases, or blocked file contents.
5. **Containerized execution, not host-user execution.** Filesystem and `bash` tools execute inside the verified Native container. The Docker socket is not mounted, the runtime is non-root, capabilities are dropped, and `no-new-privileges` is required.
6. **Fixed MCP root.** The model sees only `/workspace`. The owner selects the host filesystem root mapped there; protected WebMCP/tunnel control-plane paths remain carved out from model access.
7. **Host control plane stays outside model-writable workspace.** Tunnel credentials, runtime configuration, source/image pins, LaunchAgent state, and immutable host runtime material must not become ordinary workspace files.
8. **Git publication is separately authorized.** Normal coding does not require a host Git credential. When publication is enabled, use only repository-scoped, revocable, read-only-mounted credential material plus explicit Git identity and strict host-key checking.
9. **Tests use fake credentials only.** Never place real exchange, cloud, source-control, wallet, database, SSH, or tunnel credentials in tests or fixtures.

## Secret Firewall behavior

### Path policy

The initial deny policy includes common sensitive files and locations such as:

- `.env` and `.env.*`;
- PEM/key/keystore material;
- SSH private keys;
- `.ssh/`, `.aws/`, `.gnupg/`, `.kube/` credential locations;
- Kubernetes `kubeconfig`;
- credential stores;
- wallet/keystore paths.

Matching is performed against normalized path segments and basenames. The policy must not be bypassed by Windows separators, repeated separators, `.` segments, or simple `..` traversal syntax.

### Content redaction

The scanner redacts high-confidence secret material while preserving enough surrounding structure for the model to continue useful coding work. Initial detectors cover:

- assignments whose key names contain `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `API_KEY`, or `PASSPHRASE`;
- private-key PEM blocks;
- JWT-like bearer credentials;
- GitHub token prefixes;
- AWS access-key identifiers;
- bearer authorization values;
- high-confidence high-entropy quoted/token-like values;
- explicitly configured user regular expressions.

Redaction should report reasons/counts but never expose the raw matched secret in metadata.

## MCP / tunnel requirements

The production Secure MCP Tunnel connects to the immutable Native host entrypoint. The local MCP relay uses stdio framing: stdout is reserved for JSON-RPC and diagnostics go to stderr.

Tunnel/runtime credentials remain host-side and are not mounted into the Native container or exposed as MCP configuration.

The retired DevSpace stdio adapter/OAuth/session mechanisms are historical migration implementation, not production requirements.

## Native container boundary

The production backend is the verified Native container. The model-visible filesystem root is always `/workspace`, backed by an owner-selected host root. The safest normal configuration is the narrowest root that satisfies the task. macOS `/` is not an accepted normal root, and the Docker socket must never be mounted.

The Native server exposes exactly five reviewed tools:

- `open_workspace`;
- `read`;
- `write`;
- `edit`;
- `bash`.

Structured path-bearing tools enforce lexical/canonical workspace containment, sensitive-path policy, bounded files, and symlink-safe read/write behavior. `bash` is intentionally more powerful and cannot be reduced to structured path checks, so the workspace mount boundary and protected control-plane carve-outs are primary controls.

The container controller verifies the exact reviewed image/source identity and policy before any `docker exec`. It also verifies non-root identity, `CapDrop=ALL`, `no-new-privileges`, network mode, workspace mount, and any separately authorized Git secret mounts. Unexpected drift fails closed.

The Secret Firewall is defense in depth; it does not replace careful root selection or container isolation.

### Temporary elevated filesystem access

v1.1 adds a local-owner-controlled, time-bound filesystem lease without changing the five-tool MCP surface. The model cannot create, extend, renew, restore, or reactivate a lease. Grant begins from the immutable host CLI and requires a final approval in the logged-in macOS GUI session through the system `osascript` dialog; a remote SSH/pseudo-TTY session cannot replace that local approval. There is deliberately no remote endpoint, MCP tool, writable trigger file, generic permission framework, or cloud lease service. The elevation lifecycle CLI itself must execute from the verified source-gated immutable host snapshot; a writable repository checkout is not an authority-grant path.

The lease file lives in the protected WebMCP host control plane with mode `0600`. It carries a random lease identity, the current macOS boot identity, the current GUI login/audit-session identity, normal/elevated roots, and issue/absolute-expiry times. Missing, malformed, stale, expired, reboot-mismatched, login-session-mismatched, or normal-config-mismatched state is not authority.

An active lease does not move execution onto the host. The existing verified Native container is recreated with the owner-selected elevated root still mounted at `/workspace`, and it remains non-root with `CapDrop=ALL`, `no-new-privileges`, no Docker socket, the Secret Firewall, and the same protected control-plane masks. Elevated mode additionally forces network off and does not expose optional Git publication credentials. Literal macOS `/` remains unsupported.

Authorization is a fixed duration with a default and maximum of one hour; it is never automatically or remotely renewed. The immutable host relay keeps request bytes opaque and, before forwarding new input while elevated, checks the same absolute lease deadline used by the expiry timer. Once that deadline is reached, no new input is forwarded and the existing revocation path is triggered. Revocation/expiry stops the active executor, invalidates the lease, removes the temporary elevated container, and restores the normal workspace policy. If safe normal restoration cannot be proven, the service remains stopped/fail-closed.

A reboot or GUI logout/login never restores elevated authority because the lease is bound to both boot and GUI login/audit-session identity. An already-active lease remains usable by the connected WebMCP tunnel until it expires or is killed locally; v1.1 does not claim browser-session binding.

### Git publication from Native WebMCP

Git read/local-write operations inside the selected workspace do not require a host Git credential. Commit/push is an explicit user-authorized capability, not an automatic consequence of `bash`.

For `webmcp-bridge`, remote publication must use a dedicated, repository-scoped, revocable credential that cannot access unrelated repositories. The development identity must not receive repository administration, Actions/workflow write, secrets, tag deletion, force-push, or protection-bypass capability, and it must not publish directly to `main` when acting as the WebMCP development executor.

Credential material is read-only inside the Native container but must still be treated as potentially compromised by any process running there. Branch protection, narrow repository scope, revocability, strict SSH host-key checking, and separation from the owner's general-purpose SSH/GitHub credentials are part of the security boundary.

## Host-executed runtime boundary

Anything the model can modify beneath the owner-selected host root must be treated as untrusted development input. No LaunchAgent, tunnel runtime, container controller, or other unattended host process may execute mutable code through that workspace or through a symlink resolving into it.

Production host execution therefore uses immutable, source-gated runtime material outside the model-writable workspace. Before relay startup, the host boundary verifies the reviewed configuration, image/source identity, and expected container policy; only then may it start the Native MCP process through `docker exec`.

Protected WebMCP configuration/runtime state, tunnel/LaunchAgent state, and optional Git credentials remain host-side or explicitly masked from the workspace. The retired DevSpace host snapshot/recovery layout may remain in historical documents, but it is not a current production dependency.

### Installer boundary

The Base installer must configure the existing Native architecture rather than weaken or duplicate it. It fails before installation on missing dependencies and refuses partial, unsafe or unknown existing state instead of guessing ownership.

The permanent LaunchAgent executes only the protected managed `tunnel-client`, never repository source. Its `node` and `docker` dependencies must resolve outside the selected model-writable workspace root. The generated tunnel profile points only at the immutable Native host entrypoint, and the runtime API key remains a protected host-side file reference rather than a command-line value or container mount.

Fresh-install rollback may remove only artifacts created by that fresh attempt. Reconfiguration first proves the new workspace root, then changes only the verified Native container/configuration and restores the previous configuration/container/service on activation failure. Uninstall verifies installer ownership before removing local artifacts and deliberately preserves the remote tunnel and runtime credential for explicit owner revocation/reuse.

OpenAI tunnel creation/authorization and ChatGPT App connection remain explicit owner actions; the installer does not automate account/security UI decisions.

## Reporting a vulnerability

Do not open a public issue containing live credentials, private keys, session tokens, exploit payloads that expose real user data, or private infrastructure details.

For now, report security findings privately to the repository owner through a private GitHub communication channel available for the repository. Include a minimal reproduction using fake data and explain the expected security boundary.

## Review requirements

Changes require security-focused tests when they affect:

- Native workspace/path normalization or path allow/deny logic;
- container/image/source policy or control-plane carve-outs;
- content scanning/redaction;
- host relay/tool result forwarding;
- tunnel/MCP authorization or framing;
- Git publication credentials/scope;
- page/content/background message contracts for the optional browser provider subsystem;
- Chrome permissions;
- logging or telemetry;
- persistence/storage.

Any new Chrome permission, host capability, MCP tool class, credential flow, or broader filesystem/network authority must also update `docs/threat-model.md`.
