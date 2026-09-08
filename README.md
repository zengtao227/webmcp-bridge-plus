# WebMCP Bridge

WebMCP Bridge is an independent Chrome extension project that connects an authenticated browser AI session to a remote MCP development environment while enforcing a deterministic local security boundary before tool output can become model context.

Initial target flow:

```text
DeepSeek Web
      ↓
WebMCP Bridge Chrome Extension
      ↓
Remote MCP
      ↓
DevSpace
      ↓
Docker sandbox
      ↓
/work/<approved project>
```

On the return path, every untrusted MCP tool result must pass the Secret Firewall before it can be sent back into the DeepSeek conversation.

## MVP scope

The 0.x MVP has exactly three core capabilities:

1. DeepSeek Web tool loop using the user's existing `https://chat.deepseek.com` login session.
2. Remote HTTPS MCP client, with DevSpace as the first backend.
3. Secret Firewall with deterministic path blocking and content redaction.

The MVP intentionally does **not** implement Native Messaging, direct macOS filesystem access, arbitrary host shell, `chrome.debugger`, general browser automation, broad host permissions, DeepSeek API-key storage, or unrelated cloud-drive/memory features.

See [`CONTEXT.md`](./CONTEXT.md) for the locked project baseline.

## Security model

The model is not trusted with unrestricted tool output. High-value credentials must be protected by code enforcement rather than prompt instructions.

The first Secret Firewall version provides:

- path/file blocking for common secret locations and credential filenames;
- deterministic redaction for named secrets such as `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `API_KEY`, and `PASSPHRASE`;
- detection of private-key material, JWT-like credentials, common GitHub/AWS token formats, and high-confidence high-entropy values;
- user-defined regular-expression redaction rules;
- fail-closed handling for invalid policy input.

See [`SECURITY.md`](./SECURITY.md) and [`docs/threat-model.md`](./docs/threat-model.md).

## Repository layout

```text
webmcp-bridge/
├── extension/
│   ├── deepseek/
│   ├── mcp/
│   └── tool-loop/
├── gateway/
│   ├── secret-scanner/
│   ├── path-policy/
│   └── tool-policy/
├── docs/
│   ├── architecture.md
│   └── threat-model.md
├── scripts/
├── tests/
├── CONTEXT.md
├── README.md
├── SECURITY.md
├── .gitignore
└── package.json
```

## Development

Requires Node.js 22 or newer. The current baseline intentionally has no third-party runtime or development dependencies.

```bash
npm test
npm run lint
npm run build
npm run check
```

`npm run build` validates the extension source and creates a clean `dist/extension` package from tracked extension files. Generated output is ignored by Git.

## Current milestone

This repository currently establishes the security/repository baseline and the first Secret Firewall implementation. The DeepSeek Web adapter, remote MCP transport, and integrated tool loop remain deliberately separated behind module boundaries so they can be implemented next without weakening the security boundary.

## Upstream references

DeepSeek++ and DevSpace may be studied to understand behavior or protocol compatibility, but WebMCP Bridge remains a clean independent implementation:

- no fork;
- no automatic upstream merges;
- no wholesale subsystem copying;
- no DeepSeek++ runtime dependency;
- DevSpace is consumed through MCP rather than copied into this repository.
