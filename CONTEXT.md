# WebMCP Bridge Plus — Current Project Context

Status: WebMCP Bridge Plus is a separate multi-host product line built on the stable Native WebMCP execution-host foundation. The retired DeepSeek Web extension and DevSpace execution path are not current runtime dependencies.

## Product boundary

Stable `webmcp-bridge` remains the single-execution-host product. Plus adds routing/orchestration above independent Native execution hosts; it does not widen one host into a cross-machine filesystem or credential boundary.

Shared Native/runtime/security behavior is sourced from Base and selectively synchronized into Plus. Inherited Base baseline: `webmcp-bridge@080e335f01c1c7c63eb031817df3241c9f27549a` (Phase-1 slimming, PR #12). Plus-specific routing/control-plane behavior may intentionally diverge and must have an explicit product reason.

## Execution-host foundation

Each execution host retains the Base Native contract: exactly `open_workspace`, `read`, `write`, `edit`, and `bash`; fixed MCP root `/workspace`; hardened non-root Docker execution; capability drop and `no-new-privileges`; no Docker socket; canonical path controls; Secret Firewall; immutable/source-gated host runtime; and separately authorized Git publication.

Repository edits or merges do not automatically activate production. Host installation, runtime/image activation, LaunchAgent changes, container recreation, network changes, and other production operations require separate explicit owner authorization and a separately reviewed procedure.

## Plus control plane

Plus currently uses a data-only project/host registry and fail-closed route decision above the execution-host boundary. The first concrete transport is owner-managed OpenSSH:

```text
projectId → registry → hostId → SSH Host alias → fixed immutable Native stdio entrypoint
```

Routing identity (`hostId`) is not transport authority. OpenSSH host keys and owner-managed SSH authentication/configuration provide transport identity/security. Registry state contains no host filesystem paths, credentials, keys, endpoints, workspace IDs, sessions, or capability grants.

Current Plus-specific design lives in `docs/plus-control-plane.md` and `docs/plus-transport-options.md`. Do not add liveness state, failover, scheduling, generic transport abstractions, durable sessions, or new host powers until a concrete consumer requires them.

## Security and lifecycle

Protected Base control-plane paths remain masked from `/workspace`; Plus additionally protects its routing/control state under `~/.local/share/webmcp-plus`. A selected host/project mismatch or unavailable route fails explicitly; there is no fallback guessing.

Base installer/fresh-user/elevated-access behavior remains inherited execution-host functionality. Plus must not duplicate those mechanisms in its control plane.

## Development workflow

`AGENTS.md` is authoritative for Git and development-executor permissions. Use the workspace Skill/resume protocol for recovery; Git/filesystem state is authoritative over stale checkpoints.

Base is the source of truth for shared `native/`, `gateway/`, generic immutable-host-runtime code, and corresponding shared security behavior. After a relevant Base change is merged, perform an explicit Plus applicability review: selectively synchronize applicable shared hunks, keep files byte-identical where there is no Plus-specific reason to diverge, and document intentional divergence where it exists.

Prefer deletion, reuse and simplification. Use ordinary bounded `bash` batching for predictable repository checks. The authoritative repository gate is `npm run check`.

Current product/architecture/security details live in `README.md`, `SECURITY.md`, `docs/architecture.md`, `docs/native-tool-contract.md`, `docs/development-roadmap.md`, `docs/plus-control-plane.md`, `docs/plus-transport-options.md`, and `docs/threat-model.md`. Retired migration detail not deliberately retained in the active tree remains available in Git history.
