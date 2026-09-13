# Tunnel host-runtime boundary

Status: Historical DevSpace Phase A design. This host-runtime snapshot boundary was part of the retired DevSpace migration path and is preserved as security/design history; Native WebMCP is the current production runtime.

## Security invariant

The DevSpace project mount is a development workspace, not a host execution trust root.

```text
host ~/Doc/My code  <->  container /work/My code
```

DevSpace can modify that tree. Therefore no unattended host process may execute code directly from it or through a symlink that resolves into it.

The pre-Phase-A Tunnel launcher violated this invariant:

```text
tunnel-client
  -> ~/.local/bin/webmcp-devspace-adapter
  -> symlink into ~/Doc/My code/webmcp-bridge/adapter/bin/start.js
```

A container write to the repository could then affect code later executed by the host user.

## Phase A design

The repository remains the canonical development source, but Tunnel execution uses a host-only immutable snapshot:

```text
~/Doc/devspace-container/runtime/webmcp-adapter/
  releases/
    <git40>-<payload64>/
      manifest.json
      package.json
      adapter/
        bin/start.js
        src/...
      gateway/
        ...
      config/
        devspace-projects.yaml
  current -> releases/<git-commit>-<payload-sha256>
```

`~/Doc/devspace-container` is outside the normal DevSpace project mount and is not visible to the container.

The deployed payload is explicit. It contains only the adapter runtime closure required by the current implementation:

- `package.json`;
- `adapter/bin/start.js`;
- the exact tracked adapter runtime closure required by `adapter/bin/start.js` (recovery code is excluded);
- only the gateway policy modules actually imported by the Secret Firewall (`path-policy`, `secret-scanner`, `tool-policy`);
- `config/devspace-projects.yaml`.

Deployment scripts, `gateway/tool-executor`, and Auto-Recovery WIP are not runtime payload.

## Source gate

Deployment fails closed unless every declared payload file is:

- present;
- a regular file, not a symlink;
- tracked as a Git blob at `HEAD`;
- byte-identical to the `HEAD` object;
- free of staged/unstaged changes for the payload path;
- not an untracked file standing in for a declared payload path.

Snapshot bytes are read from the exact Git `HEAD` objects after the working-tree checks. This prevents a mutable working-tree read from becoming the release source after validation.

A runtime configuration change such as `config/devspace-projects.yaml` therefore requires a new reviewed Git state and a new snapshot deployment before it affects the Tunnel process.

## Manifest

Every release contains `manifest.json` with:

- schema version;
- artifact ID binding the full 40-hex Git commit and full 64-hex aggregate payload digest;
- exact Git commit;
- aggregate payload SHA-256;
- creation timestamp;
- runtime entrypoint;
- exact file set with per-file SHA-256, size, and deployed mode.

Release verification rejects:

- missing/extra payload files;
- symlinks;
- malformed manifest fields;
- per-file digest or size mismatch;
- aggregate digest mismatch;
- artifact ID inconsistency.

The manifest records relative payload paths only; it does not record or execute the repository source path.

## Build and promotion

Deployment order is:

```text
verify source
  -> build .staging-<id>
  -> write manifest
  -> verify complete staging release
  -> rename staging to releases/<artifact-id>
  -> verify release again
  -> atomically rename a temporary symlink to current
```

The existing `current` release is verified before a new deployment starts. A build or verification failure leaves the existing `current` pointer unchanged.

`current` is the only symlink in the runtime layout. Release directories themselves contain no symlinks.

## Tunnel command

The Tunnel installer now deploys the host-only snapshot before it interrupts any existing Tunnel process.

`tunnel-client runtimes connect` receives:

```text
--mcp-command ~/Doc/devspace-container/runtime/webmcp-adapter/current/adapter/bin/start.js
```

It no longer receives a repository path or `~/.local/bin/webmcp-devspace-adapter` symlink back into the repository.

After the new host-only runtime is proven ready, the installer may remove only the exact legacy symlink that points to the repository entrypoint. It does not remove unrelated user files or symlinks.

## Separate gates

Phase A source remediation is separate from live migration.

This change does not:

- stop or restart the current Tunnel;
- install or reload a LaunchAgent;
- stop or rebuild DevSpace;
- change Docker or host network-exposure state;
- install Auto-Recovery;
- change routing, OAuth, Secret Firewall behavior, or DevSpace container creation.

Live migration requires a separate reviewed host operation that deploys a snapshot, verifies the generated Tunnel command and runtime health, switches the Tunnel service, and confirms the old repository symlink is no longer in the active execution path.
