# WebMCP Bridge Plus — Minimal Multi-host Foundation

Status: Phase 1 routing foundation implemented; first concrete E2E transport is direct OpenSSH

This document defines the smallest Plus-only control-plane state needed to route one exact project to one execution host. It sits above independent Native WebMCP execution hosts and does not widen the stable five-tool execution-host boundary.

## 1. Stable host identity

Each execution host has one opaque persistent identity:

```text
host_<32 lowercase hex characters>
```

The identity is generated randomly and stored outside the model-writable workspace at:

```text
~/.local/share/webmcp-plus/host-identity.json
```

The loader requires the identity to be a regular non-symlink file owned by the current owner UID, mode `0600`, with strict bounded JSON containing only `version`, `hostId`, and `createdAt`.

The value is not derived from hostname, user name, IP address, hardware name, project path, transport endpoint, or credentials. It answers only:

> Which execution host is this?

It grants no filesystem, credential, or transport authority by itself.

## 2. Data-only host/project registry

The registry contains only routing metadata:

```json
{
  "version": 1,
  "hosts": [
    {
      "hostId": "host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "label": "MacBook Pro"
    }
  ],
  "projects": [
    {
      "projectId": "webmcp-bridge-plus",
      "hostId": "host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

Resolution is exact by `projectId` and has only three outcomes:

```text
unique
missing
invalid
```

The registry deliberately contains no host filesystem path, endpoint, hostname, IP, SSH user, port, key path, credential, Tailscale identity, workspaceId, session id, online state, or capability grant.

## 3. Thin route decision

`resolveProjectRoute()` converts a validated registry result into only:

```text
projectId + stable hostId
```

and rejects an explicit requested-host mismatch before transport is invoked. It does not choose endpoints, inspect filesystems, or grant execution authority.

## 4. First concrete E2E transport

The first transport binding is intentionally not a framework:

```text
projectId
→ Registry
→ Route Decision
→ stable hostId
→ /usr/bin/ssh <hostId>
→ fixed immutable Native host entrypoint
→ Native MCP stdio
```

The stable `hostId` is reused directly as the OpenSSH `Host` alias. Owner-managed `~/.ssh/config` remains responsible for resolving transport details such as `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, and host-key configuration. Plus does not parse or duplicate that configuration.

The SSH E2E probe enforces command-line safety controls that are part of the current requirement:

- fixed `/usr/bin/ssh` argv; no local shell interpolation;
- `BatchMode=yes` and password/keyboard-interactive prompts disabled;
- `StrictHostKeyChecking=yes`; no `accept-new` fallback;
- forwarding and local-command side effects disabled;
- exactly one validated stable `hostId` is dialed;
- the remote command is fixed to the existing immutable/source-gated Native host runtime;
- no fallback host is attempted.

The existing remote entrypoint is reused:

```text
~/.local/share/webmcp/host-runtime/current/native/host/start.js
```

It already exposes Native MCP over stdin/stdout and reuses the existing Docker isolation and host Secret Firewall, so no new remote wrapper or arbitrary shell API is added.

## 5. Protected Plus control-plane state

`~/.local/share/webmcp-plus` is included in the inherited Native protected-path set so broad Full Working Access cannot expose Plus routing/control state through `/workspace`.

The inherited Native container verifier verifies the complete expected mount set, including the already-computed control-plane `maskPlan`, and rejects missing masks or unauthorized extra mounts.

## 6. Still deliberately absent

Do not reintroduce without a concrete requirement:

- custom cryptographic handshake or session keys;
- per-frame MAC / sequence / replay protocol;
- online/offline/unknown host-state subsystem;
- heartbeat/probe or reconnect supervisor;
- generic capability metadata/negotiation;
- generic transport abstraction or registry;
- endpoint/credential state in the Plus Registry;
- failover, load balancing, scheduling, or Durable Agent Sessions.

A connection failure is simply an explicit connection failure until a real product consumer requires persistent liveness state.

## 7. Trust-boundary separation

```text
Routing identity       stable hostId used for project → host mapping
Transport identity     SSH server host key + owner-managed SSH authentication/config
Transport security     OpenSSH confidentiality, integrity and connection replay protections
Application auth       no additional cryptographic layer currently required
Filesystem authority   remains local to each Native execution host
```

Managed Network, if implemented later in Stable WebMCP, remains an execution-host capability. Plus may route to that host but must not duplicate the Managed Network runtime or gain the host's filesystem/network authority.
