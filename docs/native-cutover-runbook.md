# Native WebMCP host canary and cutover runbook

Status: Completed historical host-side cutover procedure. Native WebMCP is already the production runtime and the former DevSpace runtime is retired.

The text below preserves the pre-cutover gate sequence and evidence model as executed during migration. Present/future tense inside the procedure describes the conditions that applied before cutover; it is not an instruction to recreate the retired DevSpace path or rerun migration activation as a current operational step.

## 1. Preconditions

Do not start host activation from the current development worktree.

Required first:

- independent review of the final repository diff;
- reviewed changes committed/merged through the repository release policy;
- clean checked-out reviewed commit on the macOS host;
- `npm run check` PASS on that commit;
- Docker Desktop/Engine available;
- the then-current DevSpace production path remained recoverable until Native canary and cutover gates passed;
- tunnel runtime API key remains host-side;
- no tunnel credential is ever mounted into the Native container.

## 2. Build and pin the reviewed Native image

Use an explicitly pinned Node base image (`name@sha256:digest`), never a mutable tag:

```bash
npm run native:image -- \
  --base-image 'node:22-bookworm-slim@sha256:<reviewed-base-digest>'
```

The image builder:

1. requires the entire Git worktree to be clean;
2. reads the exact Native runtime payload from reviewed Git blobs;
3. sends only those blobs to the Docker build context;
4. computes the image source identity with the same aggregate function used by `npm run build:native` for `dist/native/manifest.json` → `groupSha256.runtime`;
5. records that **runtime-group digest** in `com.webmcp.native.source-sha256` and in the host image pin;
6. verifies the image is non-root by default;
7. writes `~/.local/share/webmcp/native-image.json` only after the image/source check succeeds.

`manifest.payloadSha256` identifies the complete Native review bundle (runtime + host + deploy) and is intentionally **not** the image source identity because the Docker image contains only the runtime group.

Release blocker: the image pin `sourceSha256`, the image label `com.webmcp.native.source-sha256`, and `dist/native/manifest.json` → `groupSha256.runtime` must be byte-for-byte equal. The pin must also contain the immutable image ID.

## 3. Configure and prove the selected host root

Read the immutable image ID from the newly-created image pin and use it as the probe image.

Example for the current owner workspace:

```bash
npm run native:configure -- \
  --root "$HOME/Doc/My code" \
  --mode workspace \
  --probe-image 'sha256:<native-image-id>'
```

The configuration is persisted only after an ephemeral hardened probe proves:

- the exact nonce written to the selected host root is visible at `/workspace`;
- `bind-recursive=disabled` is accepted;
- required WebMCP control-plane paths are inaccessible through `/workspace`;
- the probe cleans up its temporary sentinel.

On macOS a literal `/` is rejected. Every accepted macOS/Linux root still goes through the same identity probe.

If Git publication is required for this personal development deployment, enable it explicitly and provide commit identity:

```bash
npm run native:configure -- \
  --root "$HOME/Doc/My code" \
  --mode workspace \
  --probe-image 'sha256:<native-image-id>' \
  --git-publication on \
  --git-user-name '<reviewed development identity>' \
  --git-user-email '<reviewed development email>'
```

Generic WebMCP installs and Advanced mode have Git publication disabled by default.

## 4. Create/verify the Native container

Without Git publication:

```bash
npm run native:container -- \
  --image-pin "$HOME/.local/share/webmcp/native-image.json"
```

With Git publication, the container controller additionally requires a repository-scoped private key and a reviewed `known_hosts` file:

```bash
npm run native:container -- \
  --image-pin "$HOME/.local/share/webmcp/native-image.json" \
  --git-credential '<absolute repository-scoped key path>' \
  --git-known-hosts '<absolute reviewed known_hosts path>'
```

The controller must fail closed on policy/image/source drift. It must never silently replace a mismatched existing container.

Host canary checks should inspect the actual running container and confirm at least:

- non-root runtime UID:GID;
- `CapDrop=ALL`;
- `no-new-privileges`;
- expected network mode;
- selected host root mounted at `/workspace`;
- no Docker socket;
- control-plane carve-outs effective;
- optional Git key/known-hosts mounts read-only and absent when capability is disabled.

## 5. Deploy the immutable host boundary

From the clean reviewed commit:

```bash
npm run native:deploy-host
```

The resulting `current/native/host/start.js` is an immutable source-gated snapshot outside the model-writable workspace.

At process start it verifies/ensures the reviewed Native container **before** it creates the MCP relay. A policy mismatch must prevent any `docker exec`.

## 6. Native Secure MCP Tunnel canary

Use a dedicated canary alias; do not replace the live DevSpace runtime yet.

Example using the current host conventions:

```bash
npm run native:canary -- \
  --tunnel-client "$HOME/Doc/devspace-container/bin/tunnel-client" \
  --tunnel-id 'tunnel_<32-lowercase-hex>' \
  --runtime-key-file "$HOME/Library/Application Support/tunnel-client/secrets/devspace-runtime-api-key" \
  --runtime-entrypoint "$HOME/.local/share/webmcp/host-runtime/current/native/host/start.js" \
  --profile-dir "$HOME/.config/tunnel-client"
```

The canary tool accepts only the `webmcp-native-canary*` alias namespace. It pre-stops only that alias, connects the Native immutable entrypoint, requires `process_running=true` and `ready=true`, and stops its own alias again on a failed readiness check.

During the live canary, verify from ChatGPT/WebMCP itself:

- `tools/list` exposes exactly the five Native tools;
- `open_workspace` accepts only `/workspace`;
- `read`, `write`, `edit`, and `bash` work on a disposable canary file;
- a stale workspace ID fails after Native process restart;
- Secret Firewall redacts a synthetic secret in a tool result;
- forbidden credential paths remain denied for structured file tools;
- host logs contain no raw synthetic secret;
- if Git publication is enabled, create a disposable review-branch commit and push only to the authorized repository/branch namespace;
- if Git publication is disabled, no Git secret mounts exist in the container.

Stop the canary with:

```bash
npm run native:canary -- \
  --stop \
  --tunnel-client "$HOME/Doc/devspace-container/bin/tunnel-client"
```

## 7. Stop/go gate before permanent launchd cutover

Permanent activation is **blocked** until the real canary above proves the tunnel-client behavior on the reference host.

The canary must answer the remaining external question that repository tests cannot: how the installed `tunnel-client` behaves when the Native runtime is introduced alongside/replacing the then-current DevSpace runtime for the same personal tunnel.

Only after that evidence exists should the final launchd cutover implementation be frozen. Do not guess whether two local runtime aliases can coexist for one tunnel or whether the final activation must stop the old runtime first.

## 8. Permanent cutover requirements (after canary evidence)

The final activation must preserve the already-proven bounded rollback discipline:

1. capture recoverable old LaunchAgent/profile/runtime state;
2. validate the candidate Native plist before service switching;
3. ensure that permanent Native plist/control-plane paths already exist as trusted host artifacts before creating the final container, so the final carve-out policy masks them; do not reuse a canary container whose earlier policy did not include a newly-created control-plane path;
4. use only the immutable Native host entrypoint as `--mcp-command`;
5. prove the Native tunnel ready before retiring the then-current DevSpace service;
6. on any pre-ready failure, restore the previous service/profile/runtime state;
7. after success, reboot the Mac and prove the Native host boundary recreates/starts/verifies the container through the normal tunnel startup path;
8. only after the reboot/recovery proof may Phase 9 delete the load-bearing DevSpace adapter/OAuth/recovery/runtime code.

No separate Native container-recovery daemon is required unless the real host proves one necessary: tunnel startup already invokes the immutable Native host boundary, and that boundary ensures/verifies the container before MCP relay startup.

## 9. Trust warning

A writable workspace plus arbitrary `bash` is host-code authorship. Files written by the model can later be executed by the host owner (project hooks/scripts in narrow mode; shell/login persistence locations in broad mode). Advanced broad-filesystem mode is therefore highest-trust even when network is disabled.

This is not a failure of Docker isolation; it is a direct consequence of deliberately granting write authority over host-mounted data. WebMCP protects its own control plane, but it does not claim to enumerate every file the host may execute later.
