# Remote MCP client

This directory will contain the minimal HTTPS MCP client used by WebMCP Bridge.

Initial backend: DevSpace through its existing MCP/OAuth contract. WebMCP Bridge must not fork, copy, or embed DevSpace.

Security constraints:

- connect only to explicitly configured HTTPS MCP endpoints;
- never receive DeepSeek session credentials;
- keep MCP OAuth/access/refresh credentials out of model-visible data and logs;
- do not add blanket pre-granted host permissions;
- return raw MCP results only to the trusted policy boundary, never directly to the DeepSeek adapter.

The exact per-origin Chrome permission flow will be implemented only after verifying the narrowest permission model that supports user-added MCP origins.
