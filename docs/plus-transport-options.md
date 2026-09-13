# WebMCP Bridge Plus — First Concrete Transport: OpenSSH

Status: Option B topology retained; first concrete execution-host E2E transport selected as OpenSSH over the owner's existing mesh/VPN

Plus topology remains:

```text
ChatGPT
   ↓
one WebMCP Bridge Plus App
   ↓
Plus Control Plane
   ↓
exact project → stable hostId
   ↓
OpenSSH
   ↓
selected Native execution host
```

This selection does not introduce a transport framework or a WebMCP cryptographic protocol.

## Why OpenSSH is sufficient for the current requirement

The current requirement is only:

1. exact routing to one selected stable host;
2. authenticated connection to that host;
3. wrong-host/spoof resistance;
4. secure channel integrity/confidentiality and transport-level replay protections;
5. preservation of each host's independent Native filesystem/credential authority.

OpenSSH already supplies the transport security properties. No additional WebMCP HMAC handshake, HKDF session key, frame MAC, replay window, or reconnect protocol is justified.

## hostId is the SSH alias

The transport mapping is intentionally not stored in the Plus Registry.

The stable Plus identity itself is passed to OpenSSH:

```text
ssh host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

An owner-managed OpenSSH stanza can resolve the transport details:

```text
Host host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    HostName <owner-managed mesh hostname or address>
    User <owner-managed account>
    IdentityFile <owner-managed key if needed>
    # Port / ProxyJump / HostKeyAlias may also be owner-managed when needed.
```

Plus does not parse `~/.ssh/config` and does not copy HostName, user, port, key path, endpoint, mesh identity, or known-host state into its Registry.

This keeps the responsibilities separate:

```text
Plus Registry     projectId → stable hostId
OpenSSH config    hostId alias → transport connection details
Native host       filesystem/credentials/Docker/Secret Firewall/owner authority
```

## SSH invocation boundary

The first E2E runner calls `/usr/bin/ssh` directly with fixed argv. Model-controlled SSH options and remote commands are not accepted.

Required options are forced by the runner:

- no TTY;
- `BatchMode=yes`;
- `StrictHostKeyChecking=yes`;
- password and keyboard-interactive prompting disabled;
- one connection attempt with a bounded connect timeout;
- forwarding disabled;
- local SSH commands disabled;
- hostname canonicalization disabled so the exact stable hostId remains the input alias.

There is no `accept-new` fallback and no automatic retry against another host.

## Remote Native command

No new remote entrypoint is required. The existing immutable/source-gated Native host runtime already provides the needed stdio boundary:

```text
~/.local/share/webmcp/host-runtime/current/native/host/start.js
```

The fixed SSH remote command invokes that entrypoint with the same bounded PATH used by the Native host lifecycle. The remote command contains no project name, filesystem path from the model, shell fragment from the model, SSH option from the model, or arbitrary command parameter.

The E2E request sequence is fixed to:

```text
initialize
→ tools/list
→ tools/call open_workspace { path: "/workspace" }
```

The host runtime continues to own Docker isolation, workspace authorization and the host Secret Firewall.

## Failure behavior

Before SSH:

- invalid project → fail;
- missing project → fail;
- malformed requested hostId → fail;
- explicit requested host different from the registered host → fail.

During SSH:

- host-key verification failure → explicit SSH failure;
- authentication failure → explicit SSH failure;
- selected host unavailable → explicit SSH failure;
- fixed remote Native command failure → explicit SSH failure.

No failure triggers another host.

## Current live-E2E limitation of the development executor

The WebMCP development shell is intentionally isolated from the owner's SSH credential/configuration state. In the current execution environment `HOME=/tmp`, there is no `~/.ssh`, and `/usr/bin/ssh` cannot even resolve the container's uid through passwd. Therefore repository-side implementation/tests can verify argv, routing and fail-closed behavior, but this executor cannot perform the real owner-host two-machine SSH dial without weakening the existing boundary or copying credentials into the development container.

That is an environment boundary, not a reason to create a second endpoint/credential registry. The real two-host E2E should be run from an owner-controlled host environment that already has the intended `Host host_<id>` OpenSSH aliases and known-host/authentication state.

## Still out of scope

- transport interface/adapter hierarchy;
- generic connection manager;
- custom cryptographic handshake;
- application session keys or frame authentication;
- host-state/heartbeat/capability metadata;
- reconnect supervisor;
- failover/load balancing;
- discovery;
- Durable Agent Sessions;
- credential/key lifecycle management in Plus.
