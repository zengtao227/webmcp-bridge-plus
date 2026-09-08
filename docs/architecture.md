# Architecture

## Purpose

WebMCP Bridge connects an authenticated DeepSeek Web session to remote MCP tools without turning the browser extension into a privileged local agent.

The stable design principle is:

```text
Provider Adapter
      ↓
Tool Loop / Policy Core
      ↓
Remote MCP Client
```

DeepSeek Web is the first provider adapter. DevSpace is the first MCP backend.

## End-to-end flow

Request direction:

```text
DeepSeek Web response
      ↓
DeepSeek page adapter
      ↓
Tool request parser / tool loop
      ↓
Tool policy
      ↓
Remote HTTPS MCP client
      ↓
DevSpace MCP
      ↓
Docker sandbox
      ↓
/work/<approved project>
```

Return direction:

```text
MCP tool result
      ↓
Secret Firewall
  1. tool/result policy
  2. path policy
  3. content redaction
      ↓
approved/redacted result
      ↓
tool loop
      ↓
DeepSeek page adapter
      ↓
DeepSeek conversation continuation
```

The second diagram is a hard security invariant: raw untrusted tool output must never be forwarded directly to model context.

## Extension contexts

The intended Chrome MV3 layout is intentionally narrow.

### DeepSeek page adapter

Responsibilities:

- observe/interpret DeepSeek conversation output needed for the tool loop;
- construct continuation input from already-sanitized tool results;
- keep DeepSeek Web authentication behavior within the page/session context whenever technically possible;
- expose a typed, minimal message surface to the extension.

It must not:

- persist DeepSeek session credentials;
- send session credentials to MCP;
- become the authority for security decisions;
- receive raw blocked secret contents from the policy layer.

### Extension/background core

Responsibilities:

- maintain non-secret configuration;
- request per-origin MCP permissions when the user adds a server;
- validate tool requests;
- invoke the MCP client;
- enforce Secret Firewall policy before return data can reach the page adapter;
- keep auditable metadata that does not contain secrets.

Security-sensitive decisions belong here or in a comparably trusted extension context, not in page-controlled JavaScript.

### MCP client

Responsibilities:

- connect only to explicitly configured HTTPS MCP origins;
- implement the minimum MCP transport/authorization behavior required by DevSpace;
- return structured results to the policy boundary;
- never bypass the Secret Firewall on the return path.

The client is not responsible for local host filesystem or shell access. Those capabilities, when legitimately available, come from the remote MCP backend and are constrained by its sandbox.

## Secret Firewall

The first implementation is composed of small deterministic modules.

### `gateway/path-policy`

Normalizes path syntax and blocks known-sensitive files/directories before a read is allowed whenever the tool request exposes a target path.

Properties:

- separator-independent (`/` and `\\`);
- traversal-aware for simple `.` / `..` syntax;
- basename and path-segment checks;
- conservative matching for credential/wallet/keystore locations;
- explicit decision object rather than a boolean-only API.

### `gateway/secret-scanner`

Scans ordinary text tool output and replaces detected values with deterministic markers.

Properties:

- pattern-specific reason codes;
- no matched secret values in diagnostics;
- configurable user regex patterns;
- bounded, deterministic transformations;
- returns `{ text, redactions }` metadata.

### `gateway/tool-policy`

Composes path and content policy into the bridge-facing decision boundary. This layer is where tool-specific behavior can be added later without allowing individual adapters to skip policy.

## Chrome permissions

The intended baseline is similar to:

```json
{
  "permissions": ["storage"],
  "host_permissions": ["https://chat.deepseek.com/*"],
  "optional_host_permissions": ["https://*/*"]
}
```

The broad-looking optional pattern is **not pre-granted access**; the implementation should request only the exact HTTPS MCP origin the user explicitly adds. If Chrome's permission model permits a narrower declaration while still supporting arbitrary user-configured HTTPS MCP origins, prefer the narrower form.

Do not add:

- `<all_urls>`;
- `http://*/*`;
- pre-granted `https://*/*`;
- `nativeMessaging`;
- `debugger`.

Any permission change requires threat-model review.

## DeepSeek session handling

Preferred design:

1. DeepSeek Web remains logged in normally in the browser.
2. Requests that depend on page/session authentication are initiated in the page/session context.
3. WebMCP Bridge handles only the minimum request/response data required for the tool loop.
4. Cookie/session credential values are never copied into extension storage, logs, MCP payloads, or disk.

If DeepSeek's actual protocol makes this impossible, implementation must stop at a documented spike and record the exact reason/security impact before introducing a weaker credential boundary.

## DevSpace / Docker boundary

WebMCP Bridge does not copy or fork DevSpace. It consumes DevSpace through MCP.

The recommended deployment boundary is:

```text
DevSpace service
      ↓
Docker sandbox
      ↓
only explicitly approved project mount(s)
```

Forbidden convenience mounts include host `/`, host home, `~/.ssh`, `~/.aws`, key stores, and Docker socket. Host environment variables must not be blindly inherited.

## Failure behavior

Security failures must be explicit.

Examples:

- blocked path → deny before read where possible;
- invalid custom regex → reject policy configuration rather than ignore it;
- scanner failure → do not forward raw output;
- unknown sensitive result class → deny or redact conservatively;
- unavailable DeepSeek session-safe mechanism → document spike result rather than persist credentials as a shortcut.

## Future implementation sequence

1. repository/security baseline;
2. DeepSeek Web protocol/page-adapter spike;
3. minimal remote MCP connection;
4. Secret Firewall path blocking;
5. Secret Firewall content redaction;
6. integrated tool loop;
7. adversarial/security tests;
8. packaging/install experience.
