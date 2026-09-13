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

A raw MCP result must never be passed directly to the DeepSeek adapter. The retired standalone `gateway/tool-policy` wrapper was removed because no production extension path called it; any future integrated execution path must apply the retained path policy and Secret Firewall at the actual call boundary rather than through an unused wrapper.

Future integrated tests should make policy bypass structurally difficult and explicitly fail if an adapter receives an unsanitized result.
