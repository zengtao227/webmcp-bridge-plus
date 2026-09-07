# WebMCP Bridge — Project Context

## 1. Project identity

- Product name: **WebMCP Bridge**
- Repository: `zengtao227/webmcp-bridge`
- Local macOS path: `/Users/zengtao/Doc/My code/webmcp-bridge`
- DevSpace path: `/work/My code/webmcp-bridge`
- Default branch: `main`
- This is an **independent clean implementation**. It is not a fork of DeepSeek++ or DevSpace.

## 2. Why this project exists

WebMCP Bridge connects a browser-based AI session (initially DeepSeek Web) to a controlled MCP development environment, so the user can perform local coding work without giving a browser extension unrestricted access to the host machine.

The primary security concern is **not the value of the DeepSeek account itself**. The critical risk is accidental or malicious disclosure of high-value local secrets that may be present while developing, for example:

- cryptocurrency exchange API keys and secrets
- wallet/private keys
- cloud credentials
- GitHub tokens
- SSH private keys
- `.env` values
- database credentials
- passwords, passphrases and bearer tokens

A secret must not become model context merely because an AI agent requested a file, command or tool result.

## 3. MVP — locked scope

Version 0.x starts with exactly three core capabilities:

1. **DeepSeek Web tool loop**
   - Integrate with the authenticated `chat.deepseek.com` web experience.
   - Allow model responses to request tools and continue after tool results.
   - Do not require a DeepSeek API key for the DeepSeek Web path.

2. **Remote MCP client**
   - Connect to a user-configured MCP endpoint over HTTPS.
   - Initial target backend is DevSpace.
   - Reuse DevSpace's MCP/OAuth/workspace capabilities instead of copying or forking DevSpace.

3. **Secret Firewall**
   - Enforce local policy before MCP results are allowed into model context.
   - Block known sensitive paths and files.
   - Detect and redact likely secrets in otherwise normal source/tool output.
   - Fail closed for sensitive or ambiguous cases.

Anything outside these three capabilities is out of MVP scope unless this document is intentionally revised.

## 4. Explicit non-goals / prohibited capabilities for MVP

The browser extension must not add broad host-machine powers merely for convenience.

Do **not** implement in MVP:

- Native Messaging shell access
- direct host filesystem access
- `chrome.debugger`
- general browser automation
- `<all_urls>` host permission
- blanket `http://*/*` or `https://*/*` permission
- DeepSeek API-key storage or API-key based model execution
- Google Drive / OneDrive integration
- memory systems unrelated to the core bridge
- arbitrary local command execution outside the sandboxed MCP backend

## 5. Security invariants

These rules are architectural constraints, not prompt suggestions.

### 5.1 Least privilege

The extension should request only the permissions required for:

- `chat.deepseek.com`
- explicitly approved MCP server origins
- minimal extension state

MCP host permissions should be granted per origin by explicit user action whenever technically possible.

### 5.2 DeepSeek session credentials

DeepSeek Web session credentials must be treated as secrets.

Preferred rule:

- keep them in the DeepSeek page/session context
- use them only for DeepSeek requests
- do not persist them in extension storage
- do not send them to MCP
- do not log them

If implementation constraints require handling session headers outside the page adapter, the design must be documented and reviewed before merging.

### 5.3 No host-shell trust expansion

WebMCP Bridge must not turn the Chrome extension into a privileged local agent.

Local coding powers should come from the MCP backend (initially DevSpace) running inside a constrained environment, preferably Docker.

### 5.4 Docker boundary

For the intended DevSpace deployment:

- mount only explicitly approved project directories
- do not mount the whole home directory
- do not mount `~/.ssh`
- do not mount `~/.aws`
- do not mount password/key stores
- do not mount `/`
- do not mount the Docker socket
- do not blindly forward host environment variables

The container boundary is part of the security model.

### 5.5 Secret Firewall before model context

Tool output must pass policy before being returned to the model.

Initial path/file deny candidates include:

- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `id_rsa`
- `id_ed25519`
- credential stores
- wallet/keystore files
- SSH/AWS/GPG/Kubernetes credential locations

Initial content detection should include at least:

- variable/key names containing `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `API_KEY`, `PASSPHRASE`
- private-key headers
- common cloud/source-control token formats
- JWT-like credentials
- high-confidence high-entropy secrets
- configurable user-defined patterns

Blocking/redaction must happen in code, not only through AI instructions.

### 5.6 Logs must not contain secrets

Never log:

- DeepSeek session tokens
- MCP bearer/access/refresh tokens
- API keys
- passwords/passphrases
- raw blocked secret values
- complete sensitive file contents

Diagnostic logging should use metadata, hashes where appropriate, redaction reasons, and bounded previews only when safe.

### 5.7 Fail closed

When the system cannot determine whether a requested operation/result is safe, prefer denial or redaction over silently forwarding potentially sensitive content.

## 6. Initial architecture

```text
DeepSeek Web
     |
     v
WebMCP Bridge Chrome Extension
  - DeepSeek page adapter
  - tool-call loop
  - minimal MCP client
     |
     | HTTPS + MCP/OAuth
     v
Secret Firewall / policy boundary
     |
     v
DevSpace
     |
     v
Docker sandbox
     |
     v
/work/<approved project>
```

The exact placement of the Secret Firewall may evolve. The invariant is that **untrusted tool output must not reach model context before policy enforcement**.

## 7. Upstream relationship policy

DeepSeek++ and DevSpace may be studied as references, but WebMCP Bridge owns its implementation.

Rules:

- do not fork DeepSeek++ as the project base
- do not automatically merge upstream DeepSeek++ changes
- do not copy large subsystems wholesale
- use upstream behavior/documentation to understand protocols and compatibility
- implement the minimum required behavior independently
- keep DeepSeek-specific behavior behind a dedicated adapter
- consume DevSpace through its public MCP interface

This reduces supply-chain coupling and makes upstream changes explicit review events rather than automatic code inheritance.

## 8. Compatibility boundaries

Design modules so that the stable core is independent of one web model provider:

```text
Provider Adapter (DeepSeek Web initially)
          |
          v
Tool Loop / Policy Core
          |
          v
MCP Client
```

Future providers may be added only through separate adapters without weakening the security model.

## 9. Development rules

- Security-sensitive changes require tests.
- Never use real production API keys or wallet secrets in tests, fixtures, screenshots or documentation.
- Use unmistakably fake test credentials.
- Keep dependencies minimal.
- Pin/review security-sensitive dependencies.
- Prefer explicit typed message contracts between page, content script and background contexts.
- Treat page/model-supplied data as untrusted.
- Keep privileged decisions in trusted extension/background or gateway code, not in page-controlled payloads.
- Any new Chrome permission requires a documented reason and threat-model review.

## 10. Repository hygiene

Before any meaningful implementation, maintain at least:

- `CONTEXT.md` — project baseline and locked intent
- `README.md` — user-facing setup and purpose
- `SECURITY.md` — vulnerability/security operating model
- `docs/architecture.md`
- `docs/threat-model.md`
- `.gitignore` with strong secret exclusions

Do not commit generated credentials, local tokens, browser session data or DevSpace auth material.

## 11. Current implementation priority

Implement in this order unless deliberately changed:

1. repository/security baseline
2. DeepSeek Web protocol/page adapter spike using fake/non-sensitive data
3. minimal remote MCP connection to DevSpace
4. Secret Firewall path blocking
5. Secret Firewall content redaction
6. integrated tool-call continuation
7. adversarial/security tests
8. packaging/install experience

## 12. Definition of a safe first milestone

The first usable milestone should demonstrate all of the following:

- a user can open DeepSeek Web normally
- WebMCP Bridge can connect to an explicitly configured DevSpace MCP endpoint
- the model can perform a harmless tool sequence such as list/read/edit/test/git-diff inside an approved project
- `.env` and known secret files are blocked before their contents reach the model
- secrets embedded in ordinary test source/output are redacted
- no Native Messaging host or direct Mac shell is installed
- no DeepSeek API key is required or stored
- extension permissions remain narrowly scoped

---

**Security principle:** The AI may be intelligent and useful, but it is not part of the trusted computing base. Access must be constrained and secrets must be protected by deterministic local controls.
