# DeepSeek Web adapter

This directory owns only DeepSeek-specific browser/session behavior.

The first spike must determine the minimum request/continuation flow required to use the already-authenticated `https://chat.deepseek.com` session without a DeepSeek API key.

Security constraints:

- prefer authenticated requests in the DeepSeek page/session context;
- do not persist session credentials to `chrome.storage`, disk, or logs;
- do not send DeepSeek session credentials to MCP or third parties;
- do not perform policy decisions in page-controlled code;
- accept only already-sanitized tool results from the trusted bridge core.

If the real protocol cannot satisfy the preferred credential boundary, document the exact constraint and security impact before implementing a weaker design.
