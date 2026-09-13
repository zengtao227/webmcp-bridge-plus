# WebMCP Bridge Plus — Handoff

This is the single repo-root handoff for continuing WebMCP Bridge Plus on another agent or machine. It records the current implemented state and the next evidence gate. It is not a proposal for more architecture.

## 1. Engineering rule

Use first principles and make the minimum necessary change.

Before changing anything, ask:

1. What concrete current requirement, correctness blocker, or known security/failure mode requires the change?
2. Is any change necessary?
3. Can an existing proven mechanism solve it?
4. Can something be deleted or simplified instead?
5. What is the smallest safe change?

Default order:

```text
delete → reuse → simplify → modify → add
```

Do not add abstractions, services, state, controllers, credential systems, compatibility layers, transport frameworks, or future-proofing for hypothetical needs. Do not weaken authentication/authorization, required tests, data-integrity guarantees, or minimum production observability in the name of simplification.

If the real two-host E2E succeeds without revealing a blocker, stop. No additional transport architecture is justified merely because it could be built.

## 2. Repository and Git state at handoff creation

Repository:

```text
https://github.com/zengtao227/webmcp-bridge-plus
```

Owner host path:

```text
~/Doc/My code/webmcp-bridge-plus
```

WebMCP workspace path:

```text
/workspace/My code/webmcp-bridge-plus
```

Current branch:

```text
chatgpt/plus-host-identity-registry
```

Development baseline before this Plus change set:

```text
de5c3ea65896d1498436fa26af1a86a229dab024
```

At handoff creation, this Plus change set was intentionally **uncommitted and unpushed**. If this document is being read from a later published branch/commit, the actual checked-out commit is authoritative and supersedes that creation-time Git state.

Historical stashes are not part of this work and must not be touched:

```text
stash@{0}: On main: archive: pre-simplification auto-recovery WIP
stash@{1}: On main: future: WorkBuddy delegation proposal
```

Unless the owner explicitly authorizes it, do not:

- reset;
- restore;
- clean;
- stash;
- apply/drop historical stashes;
- commit;
- push.

Actual Git/filesystem state is authoritative if it differs from this document.

## 3. Publication prerequisite before a second machine can reproduce Plus

At handoff creation, the Plus implementation had not yet been published, so a fresh machine cloning GitHub `main` could not reproduce the working tree. If this document is being read from the exact reviewed branch/commit after publication, this prerequisite has already been satisfied for that commit.

Otherwise, before the second-Mac validation, the owner must deliberately complete this publication sequence:

```text
review final diff
→ explicitly authorize commit/push
→ publish the exact branch/commit
→ record the resulting commit SHA
→ second machine clones/fetches that exact branch/commit
```

Do not substitute “latest main” or an approximate branch state for the exact reviewed commit.

## 4. Current completed Plus state

### 4.1 Stable host identity

Implemented in:

```text
plus/control/host-identity.js
```

Identity format:

```text
host_<32 lowercase hex characters>
```

Default protected location:

```text
~/.local/share/webmcp-plus/host-identity.json
```

The loader requires a current-owner, mode-`0600`, regular non-symlink file with bounded JSON containing exactly:

```text
version
hostId
createdAt
```

The host identity is opaque routing identity only. It is not derived from hostname, IP, user, path, endpoint, or credentials and grants no transport/filesystem authority by itself.

### 4.2 Data-only registry

Implemented in:

```text
plus/control/host-registry.js
```

The registry contains only:

```text
host:    hostId + label
project: projectId + hostId
```

Project resolution is exact and has only:

```text
unique
missing
invalid
```

The registry deliberately contains no:

- endpoint;
- hostname/IP;
- SSH user;
- SSH port;
- key path or credential;
- filesystem path;
- Tailscale/mesh identity;
- workspace/session ID;
- liveness state;
- capability metadata.

Previous speculative alias machinery was deleted and must not be restored without a concrete requirement. This includes aliases, alias normalization, ambiguous matching, references multimaps, and ambiguous routing branches.

### 4.3 Thin route decision

Implemented in:

```text
plus/control/route-decision.js
```

The route decision produces only:

```text
projectId + stable hostId
```

An explicitly requested host that does not own the selected project fails before transport is invoked.

### 4.4 Native container verifier security fix

The inherited Native container verifier now reuses the already-computed `policy.maskPlan` and verifies the complete expected mount set:

- exact writable `/workspace` mount;
- expected file masks;
- expected directory masks;
- authorized Git secret mounts only when configured;
- no unauthorized extra mounts.

Regression coverage includes:

```text
valid expected mount set → PASS
missing expected control-plane mask → FAIL CLOSED
extra mount → FAIL CLOSED
```

Do not redesign the verifier unless a real defect is demonstrated.

## 5. Current SSH design

The first concrete transport is intentionally one direct OpenSSH E2E runner:

```text
plus/ssh-e2e.js
```

The path is:

```text
projectId
→ data-only Registry
→ Route Decision
→ stable hostId
→ /usr/bin/ssh <hostId>
→ existing immutable Native host/start.js
→ initialize
→ tools/list
→ open_workspace("/workspace")
```

The key binding is:

> **stable Plus `hostId` == OpenSSH `Host` alias**

Example owner-managed SSH configuration shape:

```text
Host host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    HostName <owner-managed private-mesh hostname or address>
    User <owner-managed remote account>
    IdentityFile <owner-managed private key if needed>
```

`Port`, `ProxyJump`, `HostKeyAlias`, and other connection details also remain owner-managed when needed.

Plus does not parse `~/.ssh/config` and does not copy these transport details into the Registry. `known_hosts` remains the OpenSSH peer host-key trust store.

The runner calls fixed `/usr/bin/ssh` argv and enforces the current required safety boundary:

- no TTY;
- `BatchMode=yes`;
- `StrictHostKeyChecking=yes`;
- no `accept-new` fallback;
- password and keyboard-interactive prompting disabled;
- forwarding disabled;
- agent/X11 forwarding disabled;
- local SSH commands disabled;
- hostname canonicalization disabled;
- bounded connect timeout;
- one connection attempt;
- one selected host only;
- no automatic fallback;
- no arbitrary model-controlled SSH options;
- no arbitrary model-controlled remote command.

The fixed remote command reuses the existing immutable/source-gated Native entrypoint:

```text
~/.local/share/webmcp/host-runtime/current/native/host/start.js
```

No new remote wrapper or general shell API was added.

## 6. Deliberately deleted or deferred complexity

Do not recreate these mechanisms without concrete runtime evidence that one is required:

- custom HMAC handshake;
- HKDF/application session key;
- per-frame MAC;
- application sequence/replay protocol;
- custom reconnect protocol;
- Plus-specific TLS framing;
- host online/offline/unknown state;
- heartbeat/probe;
- capability metadata/negotiation;
- generic transport interface/adapter hierarchy;
- generic connection manager;
- endpoint/credential state in the Plus Registry;
- failover;
- load balancing;
- scheduler;
- automatic discovery;
- DB or queue for routing state;
- distributed registry;
- credential-rotation framework;
- shared-core repo/package;
- Durable Agent Sessions;
- Managed Network implementation in Plus;
- new MCP tools solely for this E2E.

OpenSSH already supplies the required transport authentication, confidentiality, integrity, host-key verification, and transport replay protections for the current requirement. There is no demonstrated application-layer cryptographic gap to fill.

## 7. Latest completed repository validation

The latest completed full gate for this Plus implementation was:

```text
npm run check
→ 372 / 372 tests PASS

lint
→ PASS
→ 104 JavaScript modules

extension build
→ PASS

native build
→ PASS
→ 24 source files
→ payload 400e61d171e023e11f96765ccf3078452ef3c31afb037d5ac4de47005613536a

git diff --check
→ PASS
```

Relevant negative SSH/routing tests already cover:

- wrong explicit host → fail before SSH;
- unknown project → fail before SSH;
- host-key/authentication/unavailable SSH failure → `SSH_CONNECTION_FAILED`;
- selected host only;
- no fallback.

## 8. Security boundary of the development executor

The isolated WebMCP development executor is intentionally not the owner's SSH environment. In the recovered environment it has had:

```text
uid=501
HOME=/tmp
no passwd entry for uid 501
no owner ~/.ssh
no owner known_hosts/authentication state
/usr/bin/ssh present
Tailscale CLI absent
```

That is an environment/security boundary, not a code defect.

Do not “fix” it by:

- copying SSH private keys into WebMCP;
- mounting the owner's `~/.ssh` into the development executor;
- adding credentials to the Plus Registry;
- adding endpoint details to the Plus Registry;
- adding another transport daemon/service;
- weakening strict host-key verification.

The real two-machine E2E must run from an owner-controlled host environment with the intended OpenSSH configuration and authentication state.

## 9. Fresh second-Mac prerequisites

The Base installer currently targets macOS and requires:

- Apple Silicon (`arm64`) or Intel (`x64`) macOS;
- Node.js 22 or newer;
- Git;
- Docker Desktop/Engine with the Docker engine running;
- supported `tunnel-client` on `PATH`, or its absolute path supplied explicitly;
- a normal logged-in non-root macOS user with access to the per-user `launchd` GUI domain;
- a clean Git checkout of the exact reviewed WebMCP source commit.

A source archive without Git metadata is not an installation source because the source-gated image/runtime mechanisms read reviewed Git blobs.

The owner of the second Mac must also choose the narrowest useful workspace root and locally possess the owner-created Secure MCP Tunnel identity/runtime credential. Never paste the runtime API key into ChatGPT or another model conversation.

## 10. Base fresh-user validation on the second Mac

Do this only after the exact Plus branch/commit has been published and checked out on the new Mac.

From the clean checkout, use the existing fresh-user harness rather than inventing a second installer path:

```bash
npm run validate:fresh-user -- \
  --root "$HOME/Projects" \
  --tunnel-id 'tunnel_<32-lowercase-hex>' \
  --runtime-key-file '/absolute/path/to/runtime-api-key'
```

If `tunnel-client` is not on `PATH`, add:

```text
--tunnel-client '/absolute/path/to/tunnel-client'
```

Use the actual owner-selected narrow workspace root instead of `$HOME/Projects` when different.

The fresh-user harness already:

1. runs the existing installer `status` first;
2. requires `state=fresh` before mutation;
3. delegates to the existing `install`;
4. runs `doctor`;
5. runs final `status`;
6. never runs `uninstall`;
7. does not duplicate Docker, Tunnel, LaunchAgent, workspace, or credential policy.

If state is installed, partial, drifted, or unsafe, stop and diagnose it. Do not delete files merely to force the fresh-user path.

After a local harness PASS, complete the existing Base owner acceptance: connect/authorize the WebMCP App in ChatGPT and prove that the first `open_workspace("/workspace")` reaches the owner-selected workspace root.

A successful Base fresh-user validation establishes the existing immutable Native execution-host runtime needed by Plus.

## 11. Prepare the second Mac as a Plus execution host

Do not build a new host bootstrap subsystem for this test.

After Base Native installation is healthy:

1. Establish/reuse the stable Plus host identity using the existing `plus/control/host-identity.js` mechanism. The identity belongs under the protected default Plus control directory, not inside the model-writable workspace.
2. Record the resulting public routing identifier only:

   ```text
   host_<32 lowercase hex>
   ```

3. On the **control-side owner machine**, create/review the OpenSSH `Host` stanza whose alias is exactly that `hostId`.
4. Keep `HostName`, remote `User`, `Port`, `IdentityFile`, `ProxyJump`, and equivalent details only in owner-managed SSH configuration.
5. Establish the remote host key in the control-side owner's `known_hosts` through an owner-verified process. Do not bypass host-key checking.
6. Ensure the selected remote Unix account can execute the already-installed immutable Native host entrypoint:

   ```text
   ~/.local/share/webmcp/host-runtime/current/native/host/start.js
   ```

7. On the control side, prepare the data-only Plus registry at its protected default location so the chosen test `projectId` maps exactly to this `hostId`. Keep the schema limited to `hostId + label` and `projectId + hostId`.

There is currently no need to add a bootstrap service, discovery mechanism, endpoint registry, credentials registry, or liveness subsystem merely to prepare this test.

## 12. Real two-host positive E2E

Run this from the **owner-controlled Plus control-side machine**, not from the isolated WebMCP development executor:

```bash
node plus/ssh-e2e.js <projectId>
```

Expected successful path:

```text
projectId
→ registry resolves exact hostId
→ OpenSSH resolves Host host_<id>
→ strict host-key verification + owner authentication
→ fixed immutable Native host entrypoint
→ MCP initialize
→ tools/list
→ open_workspace("/workspace")
```

A PASS must show that the returned server is `webmcp-native`, `open_workspace` is present, and the remote root is exactly `/workspace`.

When testing an explicit host binding, the supported CLI form is:

```bash
node plus/ssh-e2e.js <projectId> --host <hostId>
```

Do not add retry/fallback behavior if the selected host fails.

## 13. Required real negative checks

Run these after the positive owner-host path is working.

### Wrong explicit host

```text
request a valid project with a different valid hostId
→ WRONG_HOST
→ fail before SSH dial
```

### Unknown project

```text
request an unregistered projectId
→ PROJECT_NOT_FOUND
→ fail before SSH dial
```

### Selected host unavailable

```text
make only the selected host unavailable
→ SSH_CONNECTION_FAILED
→ no fallback host
```

### Host-key or authentication failure

```text
cause strict host-key verification or SSH authentication to fail
→ SSH_CONNECTION_FAILED
→ no fallback host
```

Do not weaken or remove the real trust configuration just to manufacture a negative test. Use a controlled reversible test setup that does not expose credentials.

No persistent host-state subsystem is justified merely to represent any of these failures.

## 14. Evidence to record

Record enough non-secret evidence for an independent reviewer to reproduce the conclusion:

- exact published branch name and commit SHA used on both machines;
- date/time and role of each machine (control side vs execution host);
- Base fresh-user harness result on the new Mac;
- final Base `doctor`/`status` result showing healthy Native runtime;
- selected test `projectId`;
- stable public `hostId` used as the OpenSSH alias;
- positive `plus/ssh-e2e.js` result showing `webmcp-native` and root `/workspace`;
- each required negative-test error code;
- evidence that wrong-host/unknown-project produced no SSH dial;
- evidence that SSH failures attempted only the selected host and did not fallback;
- any actual blocker, with the smallest reproducible failure and the exact layer where it occurred.

Redact or omit transport endpoints when they are not needed to prove the result.

## 15. Secrets and sensitive state that must never be copied/shared

Do not paste into ChatGPT, commit to Git, copy into the WebMCP executor, or place in the Plus Registry:

- SSH private keys;
- SSH agent credentials/sockets;
- raw Secure MCP Tunnel runtime API keys;
- bearer/access/refresh tokens;
- owner `~/.ssh` directory contents;
- private credential files;
- unrelated `known_hosts` contents;
- Docker/runtime secret material;
- secrets from the remote workspace.

Public identifiers such as the Git commit SHA, `projectId`, and opaque `hostId` are suitable evidence. Host-key fingerprints may be recorded only as non-secret verification evidence; never replace owner verification with blind trust-on-first-use for this test.

## 16. Failure classification

Classify a failed real E2E before changing code.

### A. Publication/source mismatch

Examples:

- second Mac cannot obtain the exact reviewed branch/commit;
- checked-out commit differs between machines.

Action: fix publication/reproduction only. Do not change transport design.

### B. Base fresh-install/runtime failure

Examples:

- prerequisite missing;
- fresh-user harness rejects non-fresh/unsafe state;
- installer/doctor/status fails;
- immutable Native runtime is absent or unhealthy.

Action: diagnose the existing Base mechanism at that layer. Do not add a Plus transport workaround.

### C. Plus routing/control-data failure before SSH

Examples:

- invalid/missing project;
- wrong requested host;
- malformed or unavailable registry.

Action: correct the data/route input. Do not dial another host automatically.

### D. Owner SSH configuration/trust/authentication failure

Examples:

- `Host <hostId>` cannot resolve in the owner environment;
- host key is not trusted;
- authentication fails;
- selected host is unreachable.

Expected Plus result: `SSH_CONNECTION_FAILED` and no fallback.

Action: fix the owner-managed SSH/private-mesh setup if appropriate. Do not copy endpoint/credential state into Plus merely to work around it.

### E. Remote Native MCP failure after SSH succeeds

Examples:

- fixed Native entrypoint cannot run;
- malformed MCP output;
- server is not `webmcp-native`;
- `open_workspace` is missing;
- `/workspace` does not open as required.

Expected Plus classification: remote MCP failure.

Action: isolate the demonstrated Native/runtime defect. Add the smallest change only if the failure is a repository defect rather than host misconfiguration.

## 17. Next decision gate

The next useful evidence is a real owner-host two-machine E2E after publication of the exact reviewed commit.

If the positive E2E and required negative checks pass and reveal no blocker:

> **STOP.**

Do not automatically build more transport architecture.

Only add a mechanism when real evidence creates a current requirement. Examples:

- persistent connection only if one-shot SSH is demonstrated insufficient;
- host liveness only if a real consumer requires persistent liveness state;
- Durable Agent Sessions only if session loss becomes a demonstrated blocker;
- application-layer cryptography only if mature SSH is shown not to provide a required security property.

Until then, the smallest correct system is the current one.
