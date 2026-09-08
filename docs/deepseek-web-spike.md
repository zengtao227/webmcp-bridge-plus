# DeepSeek Web adapter spike

Date: 2026-09-07

## Purpose

This spike establishes the minimum browser boundary for observing an already-authenticated DeepSeek Web conversation without moving DeepSeek session credentials into extension storage, logs, MCP, or another third party.

DeepSeek Web is an internal web protocol, not a stable public API. Compatibility must therefore remain isolated behind `extension/deepseek/` and be treated as replaceable.

## Observed protocol shape

Current public reverse-engineering references agree on these relevant behaviors:

- DeepSeek Web sends chat completions to `https://chat.deepseek.com/api/v0/chat/completion`.
- The response is delivered as Server-Sent Events (SSE).
- Response data uses patch-like objects with fields such as `p`, `o`, and `v`; `APPEND`, `SET`, and `BATCH` are observed operations.
- Multi-turn continuation requires the response message lineage from the previous turn. Implementations updated in 2026 report extracting `response_message_id` from a `ready` SSE event and using it as the next `parent_message_id`.
- A completion can return HTTP 200 while an SSE `hint` event carries an application error such as a rate limit condition.
- Current web requests also use a DeepSeek proof-of-work (PoW) value. A fresh request cannot safely assume that a previously observed PoW header can be replayed.

These details are compatibility observations, not security authorities. The page is untrusted.

## Implemented boundary

```text
DeepSeek page JavaScript
        |
        | real fetch() to /api/v0/chat/completion
        v
MAIN-world passive observer
  - exact origin/path only
  - request metadata only
  - never forwards request headers/cookies/Bearer values
  - clones response and observes SSE
        |
        | window.postMessage, untrusted
        v
ISOLATED-world bridge
  - exact origin/source/version/kind checks
        |
        | chrome.runtime.sendMessage
        v
background service worker
  - validates sender tab + DeepSeek origin
  - bounded stream accumulator
  - strict WebMCP tool-call parser
```

The MAIN-world script is intentionally passive. It does not click the UI, fill the prompt box, scrape credentials, or expose an arbitrary page command channel.

## Credential invariant

The current spike does not read or export DeepSeek authentication headers at all.

Specifically, it does not send any of the following across the page/extension boundary:

- cookies
- Authorization/Bearer headers
- DeepSeek account/session tokens
- PoW headers
- the user's prompt request body

Only bounded conversation metadata and sanitized SSE JSON are emitted. DeepSeek session credentials therefore remain owned by the existing `chat.deepseek.com` page/session.

## Why MAIN world is not trusted

Chrome's MAIN execution world shares the JavaScript environment with the host page. DeepSeek page code can observe or interfere with objects in that world. Therefore:

- MAIN-world messages are data, never authorization;
- no page message may directly execute an MCP tool;
- tool-call syntax is parsed again in trusted extension code;
- tool policy and Secret Firewall enforcement remain outside page-controlled code;
- sender/origin checks narrow accidental cross-site messages but are not a cryptographic trust boundary against the DeepSeek page itself.

This is deliberate: the AI/page is outside the trusted computing base.

## Tool-call spike

The model-facing experimental syntax is deliberately narrow:

```text
<webmcp_tool_call>{"id":"call_1","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>
```

The parser enforces:

- at most 8 calls per assistant response;
- strict `id`, `name`, and `arguments` fields only;
- unique bounded call IDs;
- JSON-object arguments;
- nesting and object-key limits;
- rejection of prototype-pollution keys;
- fail-closed handling of malformed/unclosed markers.

This syntax is an adapter convention, not an MCP wire format.

## Active continuation is intentionally not claimed yet

The spike can observe a real completion, assemble assistant text, identify a strict WebMCP tool request, and retain the non-secret `response_message_id` lineage in memory.

It does **not yet** originate the follow-up DeepSeek completion that contains a tool result.

The remaining compatibility problem is fresh DeepSeek Web PoW. An active continuation implementation must generate or obtain a fresh PoW value in the page/session context without exporting session credentials. It must not solve this by:

- storing DeepSeek credentials in `chrome.storage`;
- copying cookies/Bearer values into the service worker;
- logging request headers;
- introducing DOM/browser automation;
- replaying a captured PoW value as if it were reusable.

If a safe page-local request path cannot be implemented, the limitation must remain explicit rather than weakening the credential boundary silently.

## Known limitations

1. Internal DeepSeek endpoints and SSE shapes can change without notice.
2. The service worker currently keeps in-progress SSE accumulator state in memory. A worker restart can lose the partial turn; the safe behavior is to abort rather than reconstruct from untrusted fragments.
3. Browser integration has not yet been live-validated against an authenticated DeepSeek account in this repository test environment. Unit tests use synthetic non-sensitive fixtures only.
4. The current observer instruments `window.fetch`. If DeepSeek changes transport mechanism, the adapter may stop observing rather than fall back to broader interception.

## Acceptance for this spike

The spike is considered successful when:

- manifest access remains limited to `chat.deepseek.com`;
- DeepSeek session credentials do not cross into extension storage/background/MCP;
- SSE parsing is bounded and fail-closed;
- response lineage can be extracted without credentials;
- page-originated events cannot directly authorize tool execution;
- malformed tool markers cannot trigger execution;
- active continuation remains blocked until the PoW boundary is solved safely.
