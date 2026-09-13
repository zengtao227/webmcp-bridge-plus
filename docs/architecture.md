# Architecture

## 1. Current production architecture

WebMCP Bridge now uses the Native runtime as the production ChatGPT/WebMCP execution path:

```text
ChatGPT / Web AI
      ↓
OpenAI Secure MCP Tunnel
      ↓
per-user tunnel-client runtime
      ↓
immutable minimal host boundary
      ↓  verify/ensure reviewed container before relay
isolated Native WebMCP container
      ↓
Native MCP server
      ↓
/workspace
      ↑
owner-selected host filesystem root
```

DevSpace is no longer a production runtime dependency. The former DevSpace adapter/OAuth/session/recovery architecture is historical migration context and is documented separately in the ADR and legacy runbooks.

The existing DeepSeek/Chrome-extension subsystem is a separate provider integration concern. It does not determine the Native ChatGPT runtime architecture.

## 2. Core design principle

The system deliberately separates three things:

```text
AI-visible filesystem contract     /workspace
host filesystem selection          owner-controlled configuration
host/runtime trust plane           outside model-writable workspace
```

The model never chooses an arbitrary host path. It sees only `/workspace`.

The machine owner chooses a real host directory such as:

```text
~/Projects
~/Code
~/Doc/My code
```

The trusted host controller canonicalizes and verifies that directory, then mounts it into the Native container as `/workspace`.

The owner should choose the narrowest useful root. A broader root increases convenience and also increases the set of host files the model is allowed to author.

## 3. Native MCP boundary

The Native server exposes exactly five tools:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

`open_workspace` accepts only:

```text
/workspace
```

There is no per-project registry, project alias table, model-selected host path, or routing subsystem in the Native base.

Project discovery is ordinary workflow after the root is open:

```text
open /workspace
→ inspect child directories / lightweight metadata
→ identify the requested project
→ read nested AGENTS.md / CLAUDE.md
→ work inside that project
```

A new sibling project beneath the selected root is therefore visible without registration or configuration changes.

## 4. Runtime-bound workspace identity

Each Native MCP process creates an opaque workspace ID.

Properties:

- repeated `open_workspace("/workspace")` calls in the same process return the same ID;
- a Native process restart creates a new ID;
- stale IDs fail closed;
- workspace IDs are runtime state, not persistent routing/configuration identifiers.

This removes the need for long-lived project/session identity in the routing layer.

## 5. Filesystem and shell execution

Filesystem and shell operations run inside the Native container, not directly as the host user.

Structured file tools enforce:

- lexical containment beneath `/workspace`;
- canonical `realpath` containment;
- sensitive-path policy;
- bounded file sizes;
- regular-file requirements;
- no symlink-following writes/edits;
- validated in-workspace symlink reads only.

`bash` is intentionally more powerful. It runs inside the container with:

- bounded command length;
- bounded timeout;
- bounded output;
- a small explicit environment allowlist;
- non-login `/bin/bash -c` semantics;
- a working directory that must resolve inside `/workspace`.

Request-side path policy is not claimed to parse or constrain arbitrary shell text. The container mount boundary is therefore a primary security control for `bash`.

## 6. Container isolation

The production Native container is created and verified by the trusted host controller.

Required properties include:

```text
non-root runtime UID:GID
CapDrop=ALL
no-new-privileges
no Docker socket
exact reviewed image identity
exact reviewed policy digest
owner-selected root mounted at /workspace
explicit network mode
optional Git secret mounts only when separately authorized
```

The controller verifies an existing same-named container before use. Policy/image/source drift fails closed; it does not silently execute inside or replace an unexpected container.

### Network policy

The current mode defaults are intentional:

```text
project/workspace mode  → network enabled by default
advanced mode           → network disabled by default
```

Normal coding often needs package managers, Git/networked development dependencies or integration tests. Advanced broad-filesystem access has a much larger host blast radius, so its default is more restrictive.

Network isolation does not remove the trust consequence of writable host-mounted files.

## 7. Owner-selected root and control-plane carve-outs

The selected host root is the principal filesystem blast radius.

Before configuration is persisted, an ephemeral hardened probe proves that the selected host directory is really visible at `/workspace` with the intended bind semantics.

The workspace bind uses non-recursive semantics so nested host mounts are not inherited automatically.

Protected WebMCP/tunnel control-plane paths are canonicalized. If a protected path falls beneath the selected host root, the Native container receives an explicit mask for that path.

Protected areas include the active WebMCP configuration/runtime state and tunnel/LaunchAgent state. Optional Git credentials are also treated as protected host-side material.

This allows a broad owner-selected root without treating WebMCP's own control plane as normal workspace data.

## 8. Immutable host boundary

No unattended host process executes mutable code from the model-writable workspace.

The repository is development source; production host execution uses an immutable source-gated snapshot outside the workspace.

At startup the host boundary:

```text
load reviewed configuration/image pin
→ inspect reviewed image/source identity
→ build expected container policy
→ verify/start/create the exact Native container
→ only then create the MCP relay
```

No `docker exec` occurs before the container checks pass.

The host boundary deliberately does not contain project routing, workspace filesystem logic, tool authorization, or bash execution.

### Installation and lifecycle

The macOS Base installer is a thin orchestration layer over the same production mechanisms. It does not own a second policy engine or background controller.

For a fresh install it performs dependency/state checks, builds and pins the reviewed Native image, deploys the immutable host boundary, proves the owner-selected workspace root, asks the existing container controller to create/verify the hardened container, generates the Native tunnel profile through `tunnel-client`, and installs one per-user LaunchAgent for that tunnel client.

The LaunchAgent never executes repository code. It runs the protected local `tunnel-client`, which starts the immutable Native host entrypoint from the generated profile. Host `node` and `docker` executables used by that unattended path must resolve outside the model-writable workspace root.

Installer-created tunnel/runtime state, LaunchAgent state, image/config pins and immutable host runtime remain in protected control-plane locations. The runtime API key remains a host-side `0600` file and is never mounted into the Native container.

`status`/`doctor` verify rather than silently repair drift. Workspace reconfiguration reuses the existing mount probe and container policy with bounded rollback; uninstall removes only recognized installer-owned local artifacts and preserves the remote OpenAI tunnel and owner workspace.

## 9. Host relay and Secret Firewall

Requests remain opaque at the host relay and are forwarded to the verified Native MCP process.

The response path is:

```text
Native JSON-RPC result / diagnostic
      ↓
host JSON-RPC envelope validation
      ↓
Secret Firewall / log sanitization
      ↓
Secure MCP Tunnel
      ↓
ChatGPT / Web AI
```

The host boundary independently rejects malformed, oversized or policy-unsafe output.

Unexpected child/process/runtime failures terminate the host MCP process non-zero with sanitized diagnostics. The relay does not synthesize a weaker fallback path.

The Secret Firewall is defense in depth. It does not replace careful workspace-root selection and container isolation.

## 10. Git publication

Git read/local-write operations inside the selected workspace do not require a host Git credential.

Remote Git publication is a separate optional capability and is disabled by default.

When explicitly enabled, the container receives only:

- a repository-scoped credential as a read-only mount;
- a reviewed `known_hosts` file as a read-only mount;
- explicit author/committer identity;
- strict SSH host-key checking.

The owner's general-purpose SSH keys, GitHub CLI credential store and unrelated repository credentials are not part of the Native contract.

## 11. Fail-closed behavior

The architecture prefers unavailability over silent trust expansion.

Examples:

```text
invalid workspace config          → unavailable
mount identity probe failure      → configuration not persisted
image/source mismatch             → no container execution
container policy drift            → no docker exec
stale workspace ID                → tool failure
path/symlink escape               → tool failure
Secret Firewall failure           → response blocked
malformed/oversized runtime output→ host process fails
```

There is no fallback to arbitrary host paths, weaker container settings, raw output forwarding or a retired DevSpace path.

## 12. Production validation state

The Native path has passed real host/runtime validation on the reference macOS deployment:

- reviewed Native image and mount-policy validation;
- Secure MCP Tunnel canary;
- real ChatGPT → WebMCP → Native E2E;
- permanent Native cutover;
- real macOS reboot recovery;
- post-reboot ChatGPT validation;
- DevSpace runtime retirement;
- final Native smoke test and housekeeping.

Repository tests remain important regression evidence, but production status no longer depends on inferring success from repository tests.

## 13. Historical DevSpace architecture

DevSpace was important during architecture discovery. It established several principles retained by Native WebMCP:

- container isolation;
- no public inbound development endpoint;
- Secure MCP Tunnel;
- stdio-oriented local transport;
- independent Secret Firewall;
- immutable host runtime outside model-writable source;
- fail-closed behavior.

Native WebMCP did **not** preserve DevSpace implementation mechanisms that were no longer necessary:

- DevSpace OAuth;
- bearer/session restoration;
- HTTP/SSE translation;
- `publicBaseUrl` normalization;
- per-project registry/aliases;
- separate DevSpace container recovery;
- adapter-to-DevSpace proxy logic.

For historical detail see:

- [`adr/0001-devspace-private-tunnel.md`](./adr/0001-devspace-private-tunnel.md);
- [`private-tunnel-adapter.md`](./private-tunnel-adapter.md);
- [`host-runtime-boundary.md`](./host-runtime-boundary.md);
- [`roadmap-v2.2-multi-host-routing.md`](./roadmap-v2.2-multi-host-routing.md).

## 14. Future capability boundary

The stable base remains:

```text
single execution host
+ one owner-selected root
+ five Native MCP tools
+ isolated container
+ immutable host boundary
+ deterministic security controls
```

Multi-host routing, broad computer control, browser/page capture and locally approved time-bound elevated Mac access are separate future capabilities. They should be added only when a concrete user requirement justifies expanding the trust model.
