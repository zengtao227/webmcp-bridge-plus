# Task Eval: Secure MCP Tunnel for DevSpace

## Goal
- Let the owner's ChatGPT workspace use the containerized DevSpace tool surface through OpenAI Secure MCP Tunnel without a public inbound endpoint or a manual shutdown step.

## Acceptance Criteria
- No normal startup path runs `tailscale funnel` or requires a public DevSpace URL.
- The OpenAI `tunnel-client` reaches an MCP target over loopback or an internal Docker network only.
- The target does not trust `Host`, `X-Forwarded-For`, `X-Real-IP`, or a caller-supplied device identifier for authorization.
- Missing/invalid local credentials and malformed MCP requests fail closed.
- Tunnel runtime credentials are not committed and are not logged; tracked configuration contains secret references only.
- DevSpace retains its Docker isolation: approved `/work` mount only, no host home, SSH/AWS credentials, Git credentials, or Docker socket.
- Unit/integration tests cover unauthorized access, credential refresh/error handling, request/response bounds, redirect/origin handling, and log redaction.
- `tunnel-client doctor --profile <profile> --explain` succeeds for the final private target.
- `tunnel-client` reports healthy and ready while Tailscale reports no Funnel/Serve configuration.
- ChatGPT can list tools and complete one harmless read-only tool call through the Tunnel.
- Only task-owned changes are committed; the pre-existing untracked WebMCP Bridge files remain unstaged unless separately reviewed and explicitly included.

## Required Verification Commands
- `npm test`
- `npm run lint`
- `npm run build`
- `npm run check`
- Adapter-specific unit and integration tests defined by its package/build configuration.
- `/Users/zengtao/Doc/devspace-container/verify-isolation.sh`
- `/Users/zengtao/Doc/devspace-container/bin/tunnel-client doctor --profile <profile> --explain`
- Check Docker port bindings, container network membership, Tunnel `/healthz` and `/readyz`, and `tailscale funnel status`.

## Manual Checks
- In ChatGPT developer-mode app settings, select the existing Tunnel associated only with the intended personal workspace and Platform organization.
- Confirm tool discovery and run one harmless read-only tool call.
- Confirm behavior after one Mac login/reboot or an equivalent managed-runtime restart test.

## Actual Evidence

Ran 2026-09-08 against the live DevSpace container and tunnel runtime.

- `npm run check` → lint 44 modules, 143/143 tests, build OK, exit 0.
- Live stdio MCP after a DevSpace container rebuild: `initialize` returned server
  `devspace`; `tools/list` returned exactly `open_workspace, read, write, edit, bash`;
  stdout contained JSON-RPC only and diagnostics appeared on stderr.
- Live wrong owner credential failed closed; the fake credential was absent from
  stdout/stderr and the only relevant diagnostic was
  `{"event":"auth_failed","code":"INVALID_OWNER_TOKEN"}`.
- `tunnel-client doctor --profile devspace --profile-dir ~/.config/tunnel-client --explain`
  → `RESULT ok`; stdio reachability/OAuth URL checks were correctly skipped.
- Real per-user LaunchAgent `com.webmcp.devspace-tunnel` is loaded with
  `KeepAlive`; `install-launchd.sh --status` returned `ready=true`. A forced
  `launchctl kickstart -k` changed the PID and returned to `ready=true`.
- Exposure/isolation: `tailscale funnel status` → `No serve config`; no listener
  exists on 8787; DevSpace publishes only `127.0.0.1:7676`; runtime health uses a
  dynamic 127.0.0.1 port. `verify-isolation.sh` → all PASS.
- Container mount narrowed from all of `~/Doc` to the approved `~/Doc/My code`
  root. `/work/Backups` and `/work/devspace-container` are absent, and 14 detected
  credential files are covered by read-only empty-file mounts.
- Runtime key and LaunchAgent plist are both mode `0600`; the plist contains no
  key. The adapter is reached only as tunnel-client's stdio child.
- Startup scripts contain no Funnel enable command, fail closed if any Funnel
  config exists, normalize DevSpace `publicBaseUrl` to loopback, and use the
  LaunchAgent-aware `--status` check.

Still requiring an account-side manual confirmation:

- Send one harmless ChatGPT `@DevSpace` read-only request through the existing
  connector. All local and control-plane prerequisites are ready.

## Unresolved Risks

- DevSpace 1.0.8 requires OAuth on `/mcp`; the adapter performs that exchange over
  loopback and serves no OAuth metadata, so no public authorization endpoint exists.
- `bash.command` is shell text and cannot be exhaustively interpreted as path fields.
  Its boundary is therefore the narrowed Docker mount plus credential overlays and
  result redaction. This limitation is now explicit in `SECURITY.md` and the runbook.
- The approved root is `~/Doc/My code`, not a per-repository allowlist. Set
  `DEVSPACE_PROJECT_ROOT` to a narrower root when a session should see only one tree.
- `publicBaseUrl` is persisted in the `devspace-config` volume. `dsup.sh` now normalizes
  it, but any manual edit to that volume can silently break the OAuth resource check.
