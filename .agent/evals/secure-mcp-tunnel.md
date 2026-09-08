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

Ran 2026-09-08 against the live DevSpace container.

- `npm run check` → lint 37 modules, 110/110 tests, build OK, exit 0.
- MCP through the adapter (defaults, no `DEVSPACE_OAUTH_RESOURCE` override):
  `initialize` → 200 + `mcp-session-id` forwarded; `tools/list` → 200 with
  `open_workspace, read, write, edit, bash`.
- OAuth metadata surface: `/.well-known/oauth-protected-resource{,/mcp}`,
  `/.well-known/oauth-authorization-server{,/mcp}`, `/register`, `/authorize`,
  `/token`, `/callback` → all 404, so the tunnel stays in unauthenticated-target mode.
- Fail-closed: wrong owner password → HTTP 502 `upstream_auth_unavailable`;
  log line is only `{"event":"auth_failed","code":"INVALID_OWNER_TOKEN"}` — no password, no stack.
- Isolation/binding: `docker ps` → `127.0.0.1:7676->7676/tcp`; `tailscale funnel status`
  → `No serve config`; `verify-isolation.sh` → all PASS; listener is `127.0.0.1:8787` only.
- Startup scripts: `dsup.sh` no longer contains any command that enables a Funnel and no
  longer sets `DEVSPACE_PUBLIC_BASE_URL`; it also pins the persisted
  `publicBaseUrl` in the `devspace-config` volume to `http://127.0.0.1:7676`.

Not yet done (blocked on credentials / a GUI session):

- `tunnel-client doctor --profile devspace --explain` — needs `CONTROL_PLANE_API_KEY`.
- Real ChatGPT tool call through the Tunnel — same blocker.
- LaunchAgent load — `launchctl bootstrap` returns `5: Input/output error` from this
  non-GUI shell; the plist is written and valid, and must be loaded from Terminal.app.

## Unresolved Risks

- DevSpace 1.0.8 requires OAuth on `/mcp`; the implementation must not reintroduce a
  public authorization endpoint merely to satisfy that flow.
  *Mitigated:* the adapter performs the whole OAuth exchange over loopback and serves no
  OAuth metadata, so no public authorization endpoint exists.
- The adapter is plain HTTP on loopback: any other local process can reach 127.0.0.1:8787.
  Device-bound identity therefore still needs mTLS (adapter must serve HTTPS first,
  because tunnel-client rejects mTLS on a non-HTTP binding).
- `publicBaseUrl` is persisted in the `devspace-config` volume. `dsup.sh` now normalizes
  it, but any manual edit to that volume can silently break the OAuth resource check.
