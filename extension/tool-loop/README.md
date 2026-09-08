# Tool loop

This directory will coordinate provider tool requests, remote MCP execution, Secret Firewall enforcement, and conversation continuation.

Required ordering:

```text
provider tool request
  -> request/tool policy
  -> MCP execution
  -> Secret Firewall
  -> sanitized result
  -> provider continuation
```

A raw MCP result must never be passed directly to the DeepSeek adapter. The bridge-facing policy entry point currently lives at `gateway/tool-policy/index.js`.

Future integrated tests should make policy bypass structurally difficult and explicitly fail if an adapter receives an unsanitized result.
