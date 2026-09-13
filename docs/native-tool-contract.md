# Native WebMCP five-tool contract

Status: current production contract for Native WebMCP. The Native-only cutover is complete; DevSpace is not part of the production execution path.

## Contract principle

WebMCP exposes exactly five development tools:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

Project discovery is not a sixth tool or a routing subsystem. The executor opens the single authorized root, then uses ordinary `read`/`bash` calls to locate a child repository and read its local instructions.

Native WebMCP exposes only `/workspace`; a trusted host controller maps the owner-selected host root there. The former DevSpace `/work/My code` value is historical and is not part of the Native contract.

## `open_workspace`

Native input:

```json
{"path":"/workspace"}
```

Behavior:

- `/workspace` is the only accepted path.
- Repeated opens during one Native process return the same opaque `workspaceId`.
- A Native process restart creates a new `workspaceId`; old IDs fail closed.
- The result includes the root and an instruction to locate the intended child project and read its local `AGENTS.md`/`CLAUDE.md` before editing.
- Per-project alias routing is deliberately removed.
- DevSpace's old per-project `mode=worktree` open behavior is not part of the root-open contract. Git worktrees, when genuinely needed, are an explicit project-level Git operation through `bash`, not a workspace-routing feature.

Result shape used by the Native MCP tool:

```json
{
  "workspaceId": "ws_<runtime-bound-token>",
  "root": "/workspace",
  "mode": "checkout",
  "instruction": "..."
}
```

## `read`

Input:

```json
{
  "workspaceId": "ws_...",
  "path": "relative/file.txt",
  "offset": 1,
  "limit": 200
}
```

Behavior:

- UTF-8 text only in the Native MVP.
- `offset` is 1-based.
- `limit` is bounded.
- Result text preserves file content for the selected line range.
- `nextOffset` is returned when more content remains.
- Traversal, sensitive-path policy violations, stale workspace IDs, oversized files and non-regular files fail closed.
- A symlink is readable only after its canonical target has been verified to remain inside the workspace. `read` opens that canonical target with `O_NOFOLLOW`; `write`/`edit` never write through a symlink.

During the DevSpace migration, the observed tool returned read content as text. Native preserves that useful external property while adding an explicit continuation hint.

## `write`

Input:

```json
{
  "workspaceId": "ws_...",
  "path": "relative/file.txt",
  "content": "complete replacement text"
}
```

Behavior:

- creates or completely overwrites one UTF-8 file;
- requires an existing parent directory;
- does not auto-create an arbitrary directory tree;
- bounded input size;
- final-component symlinks fail rather than being silently followed;
- reports the byte count written.

The historical DevSpace tool returned a concise `Successfully wrote ... bytes ...` result; Native keeps that useful shape.

## `edit`

Input:

```json
{
  "workspaceId": "ws_...",
  "path": "relative/file.txt",
  "edits": [
    {"oldText":"unique exact text","newText":"replacement"}
  ]
}
```

Behavior:

- each `oldText` must occur exactly once in the original source;
- edit regions must not overlap;
- zero-match and non-unique-match requests fail closed;
- all replacements are calculated against the original content, then written as one resulting file;
- the write half re-runs the Native write/path checks.

The historical DevSpace tool returned `status: applied` plus a concise edit summary; Native preserves those useful fields.

## `bash`

Input:

```json
{
  "workspaceId": "ws_...",
  "command": "...",
  "workingDirectory": "optional/relative/path",
  "timeout": 30
}
```

Behavior:

- bash executes only inside the Native runtime container, never directly as the host user;
- default working directory is the opened workspace root;
- optional working directory must resolve to an in-workspace directory;
- command length, execution time and captured output are bounded;
- non-zero commands return a bounded tool error;
- stdout/stderr are captured for the tool result;
- the runtime invokes non-login `/bin/bash -c`; it does not source `.profile`/`.bash_profile` merely because a tool call starts;
- shell environment is an explicit allowlist rather than arbitrary host/launcher `process.env`;
- Git publication is possible only when the separately-authorized Git capability supplies a read-only key, a read-only `known_hosts`, and explicit commit author/committer identity.

Arbitrary bash is intentionally powerful inside the container. Request-side path policy for `read`/`write`/`edit` is not claimed to constrain arbitrary shell text.

Any writable workspace plus arbitrary bash also gives the model **host-code authorship**: it can write project hooks/scripts or other files the owner may later execute on the host. Advanced broad-filesystem mode widens this blast radius to host-level persistence locations; network-off does not remove that property. This is an explicit trust consequence, not something the path policy claims to prevent.

## MCP framing

The Native process speaks newline-delimited JSON-RPC 2.0 over stdio.

Supported methods:

- `initialize`
- `notifications/initialized` (notification; no response)
- `ping`
- `tools/list`
- `tools/call`

A small in-container `server/discover -> Method not found` compatibility response is retained while the current tunnel-client performs its newer-protocol probe. This compatibility belongs in the Native process, not in the host security boundary, and can be deleted once live tunnel evidence shows it is no longer required.

Malformed, unknown and oversized requests fail closed. Responses remain ordered on one stdio process.

## Host response boundary

The host relay does not authorize tool requests or inspect tool names/paths/arguments. Request bytes are forwarded unchanged to the container and are not parsed by the host boundary.

Before any `docker exec`, the source-gated host entrypoint runs the container controller and verifies/ensures the reviewed image, source digest, policy label, non-root identity, capability drop, `no-new-privileges`, network mode, workspace mount and optional Git secret mounts. Policy drift fails closed rather than executing into a same-named container.

Container responses are parsed only enough to:

- require a JSON-RPC result/error envelope;
- bound the response;
- run independent Secret Firewall/redaction;
- forward the sanitized JSON-RPC envelope.

Spawn failure, unexpected child exit, malformed/unsafe output, or response-bound violations produce a sanitized host diagnostic and terminate the host MCP process non-zero. The host does not synthesize correlated JSON-RPC errors for transport failure.

The host boundary does not contain project routing, workspace canonicalization, filesystem execution or bash execution.

## Intentional differences from DevSpace

The following are not preserved merely for compatibility:

- per-project registry/aliases;
- model-selected host paths;
- per-project `open_workspace` routing;
- DevSpace OAuth;
- DevSpace MCP session restoration;
- retired DevSpace SSE/HTTP compatibility;
- HTTP/unix adapter transports without a demonstrated consumer;
- project-discovery subsystem;
- DevSpace's implementation-specific filesystem quirks.

Only behavior that the WebMCP user/model actually needs is retained.

## Release/image identity

Native image release construction is source-gated:

1. release image build requires a completely clean Git tree;
2. the existing immutable source inspector selects the exact Native runtime Git blobs;
3. only those blobs are materialized into the Docker build context;
4. `npm run build:native` records the exact seven-file runtime-group identity as `dist/native/manifest.json` → `groupSha256.runtime`;
5. the Dockerfile records that same runtime-group digest as `com.webmcp.native.source-sha256`;
6. the built image must have a non-root default user and an immutable `sha256:` image ID;
7. the host-side image pin records both immutable image ID and that same runtime-group digest;
8. the container controller verifies the image label against that pin before inspecting/using the runtime container.

`manifest.payloadSha256` covers the full Native review bundle (runtime + host + deploy). It is a different, broader artifact identity and must not be compared to the runtime-only Docker image label.

Repository tests continue to exercise this identity chain with a fake Docker executor as a regression gate. Production has also completed the real macOS image/build and workspace-mount validation, Secure MCP Tunnel Native canary, ChatGPT → WebMCP → Native end-to-end validation, permanent cutover, reboot recovery, post-reboot validation, and DevSpace runtime retirement.
