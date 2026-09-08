# Task Eval: ChatGPT DevSpace Tunnel compatibility

## Goal

- ChatGPT can create and use a developer-mode Plugin through the existing private Secure MCP Tunnel without exposing a public listener.

## Acceptance Criteria

- [x] A `server/discover` probe receives a valid JSON-RPC response with the same request ID and does not reach legacy DevSpace before initialization.
- [x] A legacy `initialize` request still succeeds in the same stdio process after the discovery probe.
- [x] JSON-RPC numeric `error.code` values survive auth-metadata scrubbing while OAuth authorization codes remain redacted.
- [x] Repeated `initialize` requests do not reuse an earlier MCP session.
- [x] The full project check passes.
- [x] The existing LaunchAgent is ready after restart; Funnel remains disabled and DevSpace remains loopback-only.
- [x] ChatGPT creates the Plugin with the existing tunnel and can discover/call a DevSpace tool.

## Verification

- Command: `node --test tests/adapter-stdio.test.js tests/adapter-sanitize.test.js`
- Expected: all targeted tests pass.
- Command: `npm run check`
- Expected: lint, complete test suite, and build pass.
- Command: `./adapter/deploy/install-launchd.sh --status`
- Expected: `ready=true`.

## Manual Checks

- [x] ChatGPT Plugin creation succeeds with Tunnel and No Auth.
- [x] A harmless DevSpace tool call succeeds from ChatGPT.
- [x] No TCP listener is exposed by the adapter and Tailscale Funnel has no configuration.

## Result

- Status: PASS
- Evidence:
  - Root cause reproduced: the legacy DevSpace response used `id: null` for `server/discover`, so tunnel-client could not correlate the request.
  - A second live failure was traced to the adapter reusing the first DevSpace session header on ChatGPT's second `initialize`; both initializations now return HTTP 200.
  - `npm run check`: lint passed, all 156 tests passed, and the extension build succeeded.
  - `install-launchd.sh --status`: `ready=true`; `tailscale funnel status`: `No serve config`.
  - Listener inspection showed DevSpace only on `127.0.0.1:7676` and no listener on port 8787.
  - ChatGPT created and connected DevSpace, then used it to open `/work/My code/brand-production-studio` and list `.DS_Store`, `.agent`, and `.agents` without modifying files.
- Known limitation: if DevSpace loses MCP session state while the adapter remains alive, the adapter may retain a stale session ID; automatic stale-session recovery is not implemented in this patch.
