# Base WebMCP installation and onboarding

Base WebMCP is installed as the existing Native production architecture. The installer does not create a second runtime model and does not restore DevSpace.

The intended macOS flow is:

```text
clean WebMCP Git checkout
→ run the Base installer
→ choose one host workspace root
→ connect the local Native runtime to an owner-created Secure MCP Tunnel
→ installer verifies the Native runtime is ready
→ owner connects the WebMCP App in ChatGPT
→ open_workspace("/workspace")
```

`/workspace` is the fixed path **inside** the Native container. Do not create `/workspace` on macOS. The installer maps the owner-selected host directory, for example `~/Projects`, to container `/workspace`.

## 1. Prerequisites

The current Base installer targets macOS only and checks prerequisites before it mutates installation state.

Required:

- macOS on Apple Silicon (`arm64`) or Intel (`x64`);
- Node.js 22 or newer;
- Git;
- Docker Desktop/Engine with the Docker engine running;
- the supported `tunnel-client` CLI, either available on `PATH` or supplied with `--tunnel-client <absolute-path>`;
- a normal logged-in non-root macOS user session with access to its per-user `launchd` GUI domain;
- a clean Git checkout of the reviewed WebMCP source.

The source-gated image and host-runtime mechanisms intentionally read reviewed Git blobs. A source archive without Git metadata is not yet an installation source.

The installer uses one reviewed digest-pinned Native base image by default. Release engineering may override it only with another explicit `name@sha256:digest` reference.

## 2. Owner decisions and owner-only actions

The installer asks the owner to decide only the information the owner actually controls.

### Workspace root

Choose the narrowest useful host directory, for example:

```text
~/Projects
```

or a single project directory.

Do not choose a host path merely because it is convenient. The selected root is the main filesystem write boundary for Native WebMCP. macOS `/` is rejected, and broad home-directory access is not the normal default.

### Secure MCP Tunnel

Creating or selecting the OpenAI Secure MCP Tunnel, and obtaining its tunnel ID/runtime API key, remains an explicit owner/security action. The repository has a supported local `tunnel-client runtimes connect` path, but it does not contain an approved mechanism for creating the owner account/tunnel or completing the relevant OpenAI UI authorization on the owner's behalf.

Never paste the runtime API key into ChatGPT or another model conversation.

For installation, either:

- let the installer prompt for the runtime API key locally in the Terminal without echo; or
- provide a local key file with `--runtime-key-file <path>`.

The installer stores the credential in the existing protected host-side tunnel-client secret location with mode `0600`. It is never mounted into the Native container.

### ChatGPT App connection

Connecting/authorizing the WebMCP App in ChatGPT remains an explicit owner UI action after the local runtime is healthy. The installer does not automate that security-sensitive account action.

## 3. Install

From the clean WebMCP checkout:

```bash
npm run webmcp -- install \
  --root "$HOME/Projects" \
  --tunnel-id 'tunnel_<32-lowercase-hex>'
```

If `tunnel-client` is not on `PATH`:

```bash
npm run webmcp -- install \
  --root "$HOME/Projects" \
  --tunnel-id 'tunnel_<32-lowercase-hex>' \
  --tunnel-client '/absolute/path/to/tunnel-client'
```

For a non-interactive local terminal workflow, use a protected local key file instead of putting the key on the command line. The source key file must not remain inside the selected WebMCP workspace root:

```bash
npm run webmcp -- install \
  --root "$HOME/Projects" \
  --tunnel-id 'tunnel_<32-lowercase-hex>' \
  --runtime-key-file '/absolute/path/to/runtime-api-key'
```

Do not pass the raw runtime API key as a CLI argument.

### What the installer automates

For a fresh installation, one installer control surface reuses the existing production mechanisms to:

1. verify required local dependencies before installation;
2. classify existing WebMCP state and refuse partial/unsafe state;
3. copy the approved `tunnel-client` executable into the protected WebMCP control plane;
4. create the isolated local tunnel-client state home;
5. store/reuse the protected runtime-key file without exposing it to the model;
6. build and pin the reviewed Native image from exact Git blobs;
7. deploy the immutable source-gated Native host boundary outside mutable repository source;
8. create and validate the Native per-user LaunchAgent before final workspace policy is established;
9. canonicalize/probe the chosen host root and persist the verified `/workspace` mapping;
10. create or verify the hardened Native container through the existing container controller;
11. use `tunnel-client runtimes connect` to generate the Native profile against only the immutable host entrypoint;
12. bootstrap the per-user LaunchAgent and wait for bounded Native tunnel readiness;
13. run the same installation verification used by `status`/`doctor`.

The LaunchAgent does not execute repository code. Its supervised process is the protected local `tunnel-client`, which starts the immutable Native host entrypoint through the generated Native profile.

The installer also rejects host `node` or `docker` executables that resolve from inside the selected model-writable workspace root.

## 4. Existing installation behavior

The installer distinguishes these states rather than silently replacing them:

```text
fresh                         → may install
already correctly installed   → install is idempotent / unchanged
configuration drift           → stop; use doctor/reconfigure or inspect the drift
partial installation          → stop; do not guess ownership
unsafe/unknown state          → stop; manual inspection required
```

An existing same-named Native container is never silently replaced during normal install. The existing container controller verifies exact image/source/policy identity and fails closed on drift.

## 5. Status and doctor

Use the compact state check:

```bash
npm run webmcp -- status
```

For a healthy installation this reports only non-secret operational state such as the selected root, container readiness, LaunchAgent readiness, tunnel readiness and immutable host artifact ID.

Run the stricter health check with:

```bash
npm run webmcp -- doctor
```

`doctor` verifies the existing Native configuration/image pin, immutable host runtime, exact container policy, Native tunnel profile, managed LaunchAgent and tunnel readiness. It does not repair drift automatically.

## 6. First ChatGPT connection

After `doctor` passes:

1. connect/authorize the WebMCP App in ChatGPT using the owner account/UI;
2. invoke `@WebMCP`;
3. the first workspace call is always:

```text
open_workspace("/workspace")
```

Individual projects appear below `/workspace`; there is no per-project registry or alias table.

## 7. Reconfigure the workspace root

To change only the owner-selected host root:

```bash
npm run webmcp -- reconfigure --root "$HOME/Code"
```

Reconfiguration first proves the new root with the existing hardened mount probe. Only then does it stop the local Native tunnel, replace the verified Native container with one using the new root, and restart the same service. If activation fails, it performs a bounded rollback to the previous workspace configuration/container/service.

Reconfiguration does not create a project registry or a second runtime profile.

### 7.1 Temporary elevated filesystem access (v1.1 production-accepted on reference Mac)

Temporary elevation is an opt-in local-owner action. It does not add an MCP permission tool and it does not permanently change the normal workspace configuration.

From the owner's local Mac Terminal, or through the native Menu Bar controller, use the source-gated CLI copied into the protected immutable host runtime by the v1.1 installer. Terminal use may prompt for a missing root; non-Terminal callers must pass an explicit `--root` and still require the same local macOS approval dialog:

```bash
WEBMCP_CONTROL="$HOME/.local/share/webmcp/host-runtime/current/native/deploy/installer.js"
node "$WEBMCP_CONTROL" elevate --root "$HOME/Documents" --duration 30m
```

Do not run the security-sensitive grant from a model-writable checkout. The immutable command displays the selected scope, requested/max duration, network/Git restrictions, warning, and local kill command when used from Terminal. Final authority is created only after the logged-in macOS GUI session approves the system confirmation dialog. A Menu Bar or other non-TTY local caller may supply an explicit root, but it cannot replace that GUI approval. A remote SSH/pseudo-TTY can at most trigger the dialog; it cannot approve it. The CLI intentionally has no `--yes` or non-interactive approval bypass.

Rules while elevated:

- authorization has a fixed duration, defaults to 1 hour, and cannot exceed 1 hour; shorter durations are supported;
- authorization has no activity-based early expiry and no automatic or remote renewal;
- after the absolute deadline, the host relay blocks new input before forwarding it and triggers the existing revocation flow;
- the selected root is verified/canonicalized with the existing mount probe; literal macOS `/` remains rejected;
- `/workspace` remains the only MCP-visible root;
- the Native container remains non-root with capability drop, `no-new-privileges`, Docker-socket isolation and control-plane carve-outs;
- network is forced off and optional Git publication credentials are not mounted;
- reboot/login restart invalidates the prior lease rather than restoring it.

View the local lease state/countdown with:

```bash
node "$WEBMCP_CONTROL" elevate-status
```

Immediately revoke it with:

```bash
node "$WEBMCP_CONTROL" elevate-stop
```

Expiry or revocation stops the active executor before removing the temporary elevated container and restoring the normal `/workspace` policy. If normal restoration cannot be established safely, WebMCP remains stopped/fail-closed. Run ordinary `status`, `doctor`, `reconfigure`, or `uninstall` lifecycle operations after returning to normal mode.

#### Menu Bar controller

For daily use, v1.1 also includes a tiny native macOS Menu Bar controller. It is intentionally only a local UI over the same immutable `elevate`, `elevate-status`, and `elevate-stop` commands; it owns no lease state and does not duplicate the backend policy.

Build and self-test it on the Mac:

```bash
npm run test:menubar
open "dist/WebMCP Menu.app"
```

The menu provides:

- **Grant Full Working Access** — selects the current user's home directory as the temporary root, while the existing WebMCP control-plane carve-outs and elevated-container restrictions remain enforced;
- **Choose Folder…** — grants a narrower owner-selected folder instead;
- **Duration: 30 minutes / 1 hour / Custom…** — 1 hour is the default and custom values are bounded to 1–60 minutes;
- a visible elevated countdown in the menu bar;
- **Stop Elevated Access** — invokes the same local `elevate-stop` kill path without requiring a Terminal command;
- **Launch at Login** — optional and off by default; uses Apple's native `SMAppService.mainApp`, with **Open Login Items Settings…** shown if macOS requires approval;
- **Refresh Status** and **Quit WebMCP Menu**.

Launch at Login adds no helper app, LaunchAgent, daemon, or new WebMCP authority path; it only asks macOS to relaunch the same Menu Bar app after the owner signs in.

Granting from the Menu Bar still causes the immutable installer to display the mandatory macOS `ELEVATE` confirmation dialog. The Menu Bar app cannot bypass, renew, or extend authority remotely. If the app quits or crashes while a lease is active, the host-enforced fixed expiry remains authoritative.

Real-Mac validation on 2026-09-13 has proven the core local grant/read/write/network-off path, immediate local revoke, fixed absolute expiry, automatic Normal restoration, sleep/wake across an expiry deadline, running work across expiry, and reboot while elevated without lease resurrection. This is sufficient to close v1.1 on the reference Mac. GUI logout/login resurrection resistance remains an optional hardening follow-up, while fresh-Mac/new-user installer validation remains a separate Base-installer gate.

## 8. Uninstall

Use:

```bash
npm run webmcp -- uninstall
```

The Base uninstaller removes only recognized local installer-owned runtime artifacts:

- Native LaunchAgent plist;
- Native tunnel profile;
- WebMCP workspace config and image pin;
- immutable Native host-runtime snapshots/pointer;
- managed local `tunnel-client` copy and isolated tunnel state;
- the verified `webmcp-native` container;
- Native tunnel logs.

It deliberately preserves:

- the remote OpenAI Secure MCP Tunnel;
- the protected local runtime API key, so the owner can reuse or revoke it explicitly;
- the already-built Docker image;
- the owner-selected workspace and all projects/files beneath it.

If local state cannot be recognized safely, uninstall stops instead of deleting by pattern.

## 9. Troubleshooting

### Missing dependency

The installer stops before partial installation and reports the missing dependency. Start Docker Desktop/Engine if `docker` exists but the engine is unavailable. Install or explicitly locate the supported `tunnel-client` if it cannot be found.

### Workspace root rejected

The selected root must exist and resolve to a real directory. The canonical root must satisfy the existing Native workspace/control-plane policy. Literal macOS `/`, unresolved paths, unsafe mount syntax and direct control-plane-root conflicts fail closed. Host `node`/`docker` executables and any supplied runtime-key source file must not resolve from ordinary model-writable content beneath that root.

Paths containing ordinary spaces are supported.

### Existing drift/partial state

Do not delete files merely to make `install` continue. Run:

```bash
npm run webmcp -- status
npm run webmcp -- doctor
```

and inspect the reported condition. The installer intentionally does not guess whether unknown local artifacts belong to WebMCP.

### LaunchAgent cannot bootstrap

Installation requires a normal logged-in macOS GUI user session. A sandboxed/non-Aqua execution environment may be able to inspect `launchd` but not bootstrap a per-user LaunchAgent. Run installation from the owner's normal Terminal session during the fresh-user validation phase.

### Tunnel is not ready

Confirm the owner-created Secure MCP Tunnel ID and protected runtime credential are correct. The installer uses the supported `tunnel-client` CLI and does not expose the credential in diagnostics.

### Optional Git publication

Base installation leaves Git publication disabled. A repository-scoped publication credential is a separate opt-in capability governed by the existing Native container policy and repository authorization rules; it is intentionally not silently enabled by onboarding.

## 10. Fresh-user acceptance gate

This installer implementation is repository-tested and ready for a separate fresh-Mac/new-user validation phase. This phase does **not** reinstall or modify the owner's current production deployment merely to exercise installer code.

Run the acceptance harness only from a genuinely fresh macOS user or fresh Mac:

```bash
npm run validate:fresh-user -- \
  --root "$HOME/Projects" \
  --tunnel-id 'tunnel_<32-lowercase-hex>' \
  --runtime-key-file '/absolute/path/to/runtime-api-key'
```

If `tunnel-client` is not on `PATH`, add `--tunnel-client '/absolute/path/to/tunnel-client'`.

The harness is deliberately only an orchestration layer. Before any install mutation it runs the existing Base installer `status` command and requires `state=fresh`; any installed, partial, drifted or unsafe state is rejected. It then delegates to the existing `install`, `doctor`, and final `status` commands. It does not duplicate Docker, Tunnel, LaunchAgent, workspace or credential policy, and it never runs `uninstall`.

A local harness PASS proves the fresh-user host installation is healthy. The final owner acceptance step remains outside the harness: connect/authorize the WebMCP App in ChatGPT and prove the first `open_workspace("/workspace")` call reaches the selected host workspace root.
