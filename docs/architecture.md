# Architecture

## 1. Architecture at a glance

WebMCP Bridge currently has two related but distinct concerns:

1. **Private DevSpace access for ChatGPT** — this is the path that is already running and validated in the real environment.
2. **Web AI provider integration** — DeepSeek Web remains the first browser provider adapter and can evolve independently above the same security principles.

The current production-safe ChatGPT → DevSpace path is:

```text
ChatGPT
   ↓
OpenAI Secure MCP Tunnel
   ↑  outbound HTTPS from the Mac
   │
tunnel-client
   │  stdin/stdout
private stdio adapter
   │  loopback HTTP + bearer token
   ↓
DevSpace 127.0.0.1:7676
   ↓
Docker sandbox
   ↓
/work/<approved project root>
```

The historical V1 → V2 decision, incident context, and retired public-ingress design are recorded in [`adr/0001-devspace-private-tunnel.md`](./adr/0001-devspace-private-tunnel.md).

Daily operation and troubleshooting are documented in:

- [`usage.md`](./usage.md)
- [`troubleshooting.md`](./troubleshooting.md)
- [`private-tunnel-adapter.md`](./private-tunnel-adapter.md)

### Version framing

- **V2.0** = the private Secure MCP Tunnel described above: no public inbound path, stdio adapter, loopback-only DevSpace.
- **V2.1** = V2.0 plus an optional Agent Skill that routes a natural-language project name to the approved path before calling the existing `open_workspace` tool.

V2.1 adds no MCP tool, no transport, no credential and no permission change. It is a pure convenience layer above the V2.0 security architecture, which remains unchanged.

## 2. Core principle

The current design is not “publish DevSpace more safely”. The design is:

> **Do not expose a normal public inbound DevSpace endpoint at all.**

The Mac initiates the outbound Tunnel connection. DevSpace remains loopback-only, and the adapter itself has no TCP port or Unix socket in the default transport.

The security direction is deliberately fail-closed:

```text
missing step / bad credential / malformed payload / policy failure
                         ↓
                      unavailable
```

not:

```text
operator forgot a shutdown step
            ↓
       publicly reachable
```

## 3. How the current private path works

### 3.1 OpenAI Secure MCP Tunnel

`tunnel-client` is supervised as a per-user LaunchAgent and establishes an outbound connection to the OpenAI Tunnel control plane.

Normal operation is DevSpace loopback-only plus an outbound OpenAI Secure MCP Tunnel connection. There is no public DevSpace URL.

Expected network state:

```text
adapter TCP :8787     absent
DevSpace :7676        127.0.0.1 only
Tunnel connection     outbound from the Mac
```

### 3.2 Why the adapter uses stdio

The adapter originally went through an intermediate loopback HTTP design (`127.0.0.1:8787`). That was safer than a public endpoint but still left a locally reachable address.

The final default transport is stdio:

```text
tunnel-client
    │
    ├── stdin  → adapter
    └── stdout ← adapter
```

`tunnel-client` spawns the adapter as its child process. The adapter does not listen on a TCP port or Unix socket, which removes a separate local connection point.

stdout is reserved for JSON-RPC framing. Diagnostics go to stderr.

### 3.3 Local DevSpace OAuth

DevSpace 1.0.8 requires bearer authentication on `/mcp`. The adapter does not disable that requirement.

Instead, the OAuth exchange happens entirely on loopback:

```text
adapter
  ↓ metadata discovery
127.0.0.1:7676
  ↓ local authorize / PKCE / token exchange
adapter receives bearer token
  ↓
127.0.0.1:7676/mcp
```

Important properties:

- the owner credential never needs to be published to ChatGPT;
- the DevSpace access token stays inside the adapter process;
- advertised OAuth endpoints are rewritten to the configured loopback upstream;
- the adapter does not publish OAuth metadata to the Tunnel;
- upstream 401/403 authentication challenges are terminated locally and are not forwarded as a remote OAuth challenge.

### 3.4 MCP compatibility layer

The adapter contains only the compatibility needed for real ChatGPT / tunnel-client ↔ DevSpace behavior observed so far.

#### `server/discover`

A current ChatGPT/tunnel-client probe can send `server/discover` using a newer MCP discovery shape. Legacy DevSpace does not support this method and, when the probe was forwarded before initialization, returned an unusable `id: null` session error.

The stdio adapter therefore returns a correlated JSON-RPC:

```text
-32601 Method not found
```

with the original request id, allowing the caller to downgrade in the same process.

#### Fresh `initialize`

An MCP `initialize` creates a fresh session. The adapter deliberately does not attach an old `mcp-session-id` to a new initialize request.

This prevents ChatGPT's second validation initialize from failing because of an earlier session.

#### Adapter-side legacy session restore

`tunnel-client` can retain remote connector state while the local adapter process is restarted. In that case, a request such as `tools/list` can arrive before a new initialize.

When the adapter itself has no current session, it performs:

```text
initialize
→ notifications/initialized
→ original tools/list or tools/call
```

This restores the adapter-side legacy session without requiring the remote connector to restart its own state machine.

Known limitation: if the adapter stays alive while DevSpace restarts and loses the session, the adapter may still hold a stale session id. Automatic stale-session recovery is intentionally not guessed at until the real DevSpace invalid-session signal is characterized.

### 3.5 Secret Firewall — request side

Before a tool call reaches DevSpace, the adapter applies deterministic request policy.

Current reviewed tool allowlist:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

For structured path-bearing tools, path candidates are extracted and evaluated before forwarding. A denied sensitive path is therefore blocked before DevSpace is asked to read it.

Examples include `.env`, private keys, credential stores, wallet/keystore locations, traversal attempts and other configured sensitive paths.

### 3.6 Secret Firewall — response side

Every supported DevSpace JSON / SSE tool response is sanitized before it is returned through stdio.

The return path is:

```text
DevSpace result
   ↓
auth metadata scrubber
   ↓
path/content Secret Firewall
   ↓
approved or redacted JSON-RPC
   ↓
stdio → Tunnel → ChatGPT
```

Unknown content types, unparsable payloads, oversized responses and policy failures are rejected rather than forwarded raw.

JSON-RPC integer `error.code` is preserved as protocol metadata, while OAuth-style authorization codes remain redacted.

### 3.7 Docker boundary

The Secret Firewall is not the only security control.

DevSpace runs inside Docker and only sees explicitly approved project roots. The current default is narrower than the original deployment:

```text
~/Doc/My code  →  /work/My code
```

`~/Doc/Backups`, the DevSpace management directory and unrelated home data are not part of the normal mount.

Detected credential files can additionally be covered by read-only empty-file mounts.

This matters especially for `bash`: shell text cannot be completely understood by structured path extraction, so the Docker mount boundary remains a primary security control.

### 3.8 `publicBaseUrl`

DevSpace persists `publicBaseUrl` in the `devspace-config` volume. A legacy public URL can therefore survive after the environment variable is removed.

The startup path normalizes the value to:

```text
http://127.0.0.1:7676
```

so OAuth resource validation stays aligned with the private loopback topology.

## 4. Browser provider layer

The longer-term WebMCP Bridge provider architecture remains:

```text
Provider Adapter
      ↓
Tool Loop / Policy Core
      ↓
MCP Client / private backend path
```

DeepSeek Web is the first provider adapter. It is intentionally isolated under `extension/deepseek/` because the DeepSeek Web protocol is not a stable public API.

Its session credentials should remain in the page/session context and must not be copied into MCP, logs or persistent extension storage.

The browser extension must not become a privileged host agent. Local filesystem and shell capability comes from the constrained DevSpace backend, not from Native Messaging or direct host access.

## 5. Security invariants

The following are architectural constraints:

1. DevSpace must not have a normal public MCP endpoint.
2. The current runtime topology is loopback-only DevSpace plus the outbound OpenAI Secure MCP Tunnel connection.
3. The stdio adapter is the default Tunnel target; no unauthenticated loopback HTTP adapter is permitted.
4. DevSpace upstream must remain loopback-only.
5. Raw tool output must not bypass Secret Firewall before model context.
6. New DevSpace tools are denied until reviewed and added to the allowlist.
7. Runtime credentials are references / protected local files, not tracked plaintext.
8. Docker mounts remain restricted to approved project roots.
9. Security failures fail closed instead of falling back to a weaker transport or bypass.
10. A return to any public inbound DevSpace design requires a new explicit architecture decision.

## 6. Current validated state

As of 2026-09-08, the current path has been validated with:

- ChatGPT Developer-mode Plugin → Secure MCP Tunnel → DevSpace real tool call;
- full `npm run check` (lint, test suite, and build) passing;
- Tunnel LaunchAgent `ready=true`;
- no listener on `8787`;
- DevSpace published only on `127.0.0.1:7676`.

For detailed operational evidence, see the evals under `.agent/evals/` and the private Tunnel runbook.

## 7. V2.2 registry routing and adapter enforcement

V2.2 keeps the project-centric natural-language entry, but routing correctness
no longer depends on the online Skill being selected before the DevSpace App.
The canonical registry is:

```text
project identity
   ↓
config/devspace-projects.yaml
   ↓
registered host/app + exact approved path
```

There are now two layers with different responsibilities:

```text
Online routing Skill
→ UX guidance / project-name intent

Private adapter
→ authoritative registry enforcement
→ tools/list narrows open_workspace.path to registered references
→ tools/call resolves canonical name / alias / exact registered path
→ forwards only the exact registered project.path
```

The Skill is not a security boundary. If it is skipped, stale, or not selected,
`open_workspace` still cannot reach DevSpace with an unknown or guessed path.
Unknown names, unregistered absolute paths, ambiguous matches, an unavailable
registry, and projects registered to a different non-selectable backend all fail
closed before the upstream DevSpace tool is called.

The `app` field remains routing/planned metadata for future per-host backend
selection. The current adapter automatically selects the sole registered host;
once the registry contains more than one host, each adapter runtime must provide
`DEVSPACE_HOST_ID`, otherwise startup fails closed.

The mandatory routing invariant remains:

```text
Unique registered project on this backend -> rewrite to exact path -> execute
Ambiguous registered match                -> fail closed / require disambiguation
Missing or unregistered                   -> fail closed
Registry unavailable or invalid           -> adapter startup fails closed
Different registered backend              -> fail closed; never fall back
```

This enforcement changes only the private adapter's routing boundary. The Tunnel,
OAuth flow, Secret Firewall, Docker isolation, and the reviewed five-tool MCP
surface remain unchanged.
