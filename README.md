# WebMCP Bridge Plus

WebMCP Bridge Plus is a **separate project and product line** built on the stable Native WebMCP execution-host foundation. It is not `webmcp-bridge` v2.0 and it does not replace the single-host product.

The stable `webmcp-bridge` project remains the minimal single-execution-host implementation. Plus inherits that proven runtime and security baseline, then adds a multi-host control plane above independent execution hosts.

Target architecture:

```text
ChatGPT / Web AI
      ↓
WebMCP Bridge Plus control plane
      ↓
explicit host/project routing
      ↓
OpenSSH execution-host connection
   ┌──┴───────────────┐
   ↓                  ↓
execution host A   execution host B
Native WebMCP      Native WebMCP
Docker isolation   Docker isolation
/workspace         /workspace
```

Each execution host keeps its own Secure MCP Tunnel identity, immutable host boundary, isolated Native container, `/workspace` root, Secret Firewall, credentials, and local owner controls. Plus must not collapse multiple hosts into one broad filesystem or credential boundary. The data-only registry carries routing identity only; the first E2E transport reuses owner-managed OpenSSH configuration with the stable `hostId` as the SSH alias.

The repository has been rebased conceptually onto the current Native/V1.1 WebMCP implementation. The former DevSpace runtime and routing work remains only as historical design input where useful. New Plus implementation must use the Native WebMCP execution-host model rather than revive the retired DevSpace production path.

## Native contract

The Native MCP surface intentionally contains exactly five development tools:

1. `open_workspace`
2. `read`
3. `write`
4. `edit`
5. `bash`

`open_workspace` accepts only:

```text
/workspace
```

`/workspace` exists inside the Native container. The machine owner selects a real host directory such as `~/Projects` or `~/Code`, and the trusted host controller mounts that directory at `/workspace`. Users do **not** create `/workspace` on macOS.

Projects beneath the selected host root do not need individual registration or aliases. Natural-language project discovery happens after `/workspace` is opened by using the existing `read`/`bash` tools.

The inherited Native execution-host layer intentionally stays narrow: five low-level tools, one approved `/workspace`, container isolation, and deterministic host-side security controls. Plus adds routing/orchestration **above** that boundary rather than broadening every host's primitive tool surface by default.

## Security model

The AI model is not part of the trusted computing base. Important controls are enforced in code:

- filesystem and shell execution run inside the Native container, not directly as the host user;
- the container runs non-root with `CapDrop=ALL` and `no-new-privileges`;
- the Docker socket is not mounted into the container;
- the selected host root is the filesystem blast radius and is mounted at `/workspace`;
- protected WebMCP/tunnel control-plane paths are carved out even when they fall beneath a broad selected root;
- structured file tools use canonical path validation and fail closed on traversal/path escape;
- writes/edits do not follow symlinks;
- the host relay independently applies the Secret Firewall to Native JSON-RPC results and diagnostics before they leave the host boundary;
- tunnel/runtime credentials remain host-side and are not mounted into the Native container;
- Git publication is disabled by default and, when explicitly enabled, uses separate read-only repository-scoped credential mounts and explicit commit identity;
- image/source/policy drift fails closed before `docker exec`.

A writable workspace plus arbitrary `bash` is still **host-code authorship**: the model can modify files that the owner may later execute on the host. The safest normal configuration is therefore the narrowest useful host root. Broad filesystem access is a high-trust capability even when container isolation remains intact.

See [`SECURITY.md`](./SECURITY.md) and [`docs/threat-model.md`](./docs/threat-model.md).

## Current validation state

The Native production path has completed the real release gates on the reference macOS host, including:

- real Native image/build and workspace mount validation;
- Secure MCP Tunnel Native canary;
- real ChatGPT → WebMCP → Native E2E;
- permanent Native cutover;
- macOS reboot recovery;
- post-reboot ChatGPT validation;
- DevSpace runtime retirement;
- final Native smoke test and housekeeping.

Repository-side Native/security tests remain the regression gate, but they are no longer the only evidence for the production architecture.

## Repository layout

```text
webmcp-bridge-plus/
├── native/
│   ├── src/       # in-container MCP server + five-tool execution
│   ├── host/      # minimal host relay + response Secret Firewall
│   └── deploy/    # image/config/container/source gates
├── gateway/       # retained path/secret policy modules used by Native
├── adapter/deploy/deploy-host-runtime.js  # generic immutable host snapshot/source gate reused by Native
├── plus/          # Plus-only host identity, routing, and OpenSSH E2E logic
├── docs/
├── scripts/
└── tests/
```

## Development

Requires Node.js 22 or newer. The current baseline intentionally has no third-party Node runtime or development dependencies.

```bash
npm test
npm run lint
npm run build
npm run check
```

`npm run build` validates the Native source package. `dist/native/manifest.json` records the Native runtime/host/deploy source groups and digests; generated output is ignored by Git.

Base macOS onboarding is now exposed through one Native lifecycle surface:

```bash
npm run webmcp -- install --root "$HOME/Projects" --tunnel-id 'tunnel_<id>'
npm run webmcp -- status
npm run webmcp -- doctor
npm run webmcp -- reconfigure --root "$HOME/Code"
npm run webmcp -- uninstall
```

The installer reuses the existing reviewed Native image, workspace probe/configuration, container controller, immutable host-runtime promotion and `tunnel-client` mechanisms; it does not add another daemon or runtime architecture. Secure MCP Tunnel creation/credential acquisition and the final ChatGPT App connection remain explicit owner actions. See [`docs/installation.md`](./docs/installation.md).

V1.1 adds local owner-approved temporary elevated access. A tiny optional native macOS Menu Bar controller provides Full Working Access (the current user's home directory), narrower folder selection, 30-minute / 1-hour / custom duration selection, a visible countdown, and one-click revoke while still delegating all authority to the immutable host installer:

```bash
npm run test:menubar
open "dist/WebMCP Menu.app"
```

Low-level `native:*` commands remain available for release engineering and focused diagnostics, but normal onboarding should not require users to manage image IDs, workspace probes, container policy digests, runtime profiles or LaunchAgent internals directly.

## Documentation

Current Native documents:

- [`docs/architecture.md`](./docs/architecture.md) — production Native architecture and trust boundaries;
- [`docs/installation.md`](./docs/installation.md) — macOS install/status/doctor/reconfigure/uninstall and owner-required UI actions;
- [`docs/native-tool-contract.md`](./docs/native-tool-contract.md) — five-tool MCP behavior;
- [`docs/usage.md`](./docs/usage.md) — normal `@WebMCP` workflow;
- [`docs/development-roadmap.md`](./docs/development-roadmap.md) — active Plus roadmap, inherited Native baseline, multi-host phases, and durable-session direction;
- [`docs/plus-control-plane.md`](./docs/plus-control-plane.md) — minimal Phase 1 stable host identity, data-only registry, route decision, and protected control-plane contract;
- [`docs/plus-transport-options.md`](./docs/plus-transport-options.md) — first concrete OpenSSH E2E transport and its fail-closed boundary;
- [`docs/threat-model.md`](./docs/threat-model.md) — security threats and mitigations;
- [`docs/release-review-policy.md`](./docs/release-review-policy.md) — independent release-review rules.

Historical migration material retained in the active tree:

- [`docs/native-cutover-runbook.md`](./docs/native-cutover-runbook.md) — completed Native cutover procedure/evidence model;
- [`docs/adr/0001-devspace-private-tunnel.md`](./docs/adr/0001-devspace-private-tunnel.md) — historical DevSpace private-tunnel decision.

Other retired migration implementation notes, troubleshooting records, evals, and superseded roadmaps remain available in Git history rather than the active documentation set.

## Product direction

Plus development starts **before** a second production host becomes urgent. The goal is to build the multi-host foundation deliberately while the stable single-host WebMCP remains available and uncomplicated.

The planned sequence is:

1. establish stable host identity and a data-only host/project registry;
2. add explicit, fail-closed host routing without filesystem scanning or fallback guessing;
3. use OpenSSH as the first concrete E2E transport, with stable `hostId` reused directly as the owner-managed SSH Host alias and no custom cryptography;
4. validate the fixed SSH → immutable Native stdio path on two owner-controlled hosts, adding live host state only if an actual runtime consumer requires it;
5. add durable agent/session management only after identity, routing, and transport are proven;
6. only then consider higher-level scheduling/orchestration.

The existing five-tool Native execution-host surface remains the default primitive boundary. Plus should prefer coordination above that surface instead of adding new host powers unless a concrete capability requires them.
