# Threat Model

## Security objective

Allow a browser-hosted AI model to use useful coding tools through remote MCP while preventing high-value local credentials from becoming model context or escaping through bridge-controlled channels.

The model, web page content, tool requests, tool output, and remote service responses are treated as potentially adversarial.

## Assets

Primary assets to protect include:

- exchange API keys and secrets;
- wallet/private keys and seed material;
- `.env` credentials;
- GitHub tokens;
- AWS/cloud credentials;
- SSH private keys;
- database passwords;
- bearer/access/refresh tokens;
- passphrases;
- DeepSeek Web session credentials;
- MCP OAuth credentials;
- sensitive source/configuration that the user did not authorize for model disclosure.

## Trust boundaries

```text
[DeepSeek Web page / model]
          |
          | untrusted messages
          v
[WebMCP Bridge trusted policy core]
          |
          | authenticated HTTPS MCP
          v
[Remote MCP / DevSpace]
          |
          | sandboxed operations
          v
[Docker / approved project mount]
```

A second critical boundary exists on the return path:

```text
raw MCP result -> Secret Firewall -> sanitized model context
```

No adapter or transport may bypass that boundary.

## Threats and mitigations

### T1 — Prompt-driven secret read

**Scenario:** The model requests `.env`, `~/.ssh/id_ed25519`, AWS credentials, a wallet, or another sensitive file.

**Mitigations:**

- deterministic path policy before file reads whenever a path is available;
- sandbox exposes only approved project mounts;
- known secret filenames/directories denied by default;
- deny decision is returned instead of file contents.

**Residual risk:** Secrets may exist under unexpected filenames inside an approved project, requiring content scanning as defense in depth.

### T2 — Secret embedded in ordinary source or command output

**Scenario:** A normal source/config/log file contains `API_KEY=...`, a bearer token, JWT, private key, cloud credential, or high-entropy secret.

**Mitigations:**

- content redaction after MCP execution and before model continuation;
- multiple high-confidence detectors;
- user-defined regex support;
- scanner metadata contains reason/count only, not raw matches.

**Residual risk:** No heuristic scanner detects every possible secret. Sandboxing, path controls, minimal mounts, and future entropy/context improvements remain necessary.

### T3 — Path traversal / separator bypass

**Scenario:** A request uses `src/../.env`, repeated separators, or Windows separators to evade basename checks.

**Mitigations:**

- normalize separators;
- collapse `.` and `..` segments conservatively;
- evaluate normalized segments and basename;
- adversarial tests for traversal variants.

### T4 — Malicious custom redaction configuration

**Scenario:** Invalid or pathological user regex configuration weakens scanning or crashes the policy layer.

**Mitigations:**

- compile/validate policy at configuration time;
- invalid rules fail closed;
- limit flags/features supported by the public policy API;
- do not silently skip malformed patterns.

**Future work:** Add explicit complexity/length limits if arbitrary regex configuration is exposed in the UI.

### T5 — DeepSeek session credential extraction

**Scenario:** Extension code copies browser-managed DeepSeek credentials into storage, logs, MCP requests, or another context where they can leak.

**Mitigations:**

- prefer authenticated requests inside `chat.deepseek.com` page/session context;
- never persist session credential values;
- never include them in MCP payloads or logs;
- require design review before any exception.

### T6 — MCP OAuth credential leakage

**Scenario:** MCP access/refresh tokens are persisted in ordinary extension state or returned to the model via errors/logs.

**Mitigations:**

- keep auth handling isolated from model-visible messages;
- redact authorization headers and bearer values;
- never log raw tokens;
- persist endpoint configuration separately from credentials.

### T7 — Broad Chrome permissions

**Scenario:** The extension gains access to unrelated websites or host powers, increasing compromise blast radius.

**Mitigations:**

- only `chat.deepseek.com` is pre-authorized;
- MCP origins requested individually by explicit user action;
- no `<all_urls>`, blanket HTTP access, Native Messaging, or `chrome.debugger`;
- permission changes require threat-model review.

### T8 — Direct host compromise through bridge design

**Scenario:** The extension gains arbitrary host shell/filesystem access or connects to an MCP backend that exposes the entire host.

**Mitigations:**

- no Native Messaging or direct macOS filesystem API in MVP;
- coding operations come from remote MCP;
- DevSpace should run inside Docker with only approved project mounts;
- do not mount home, `/`, Docker socket, `.ssh`, `.aws`, or secret stores;
- do not blindly inherit host environment variables.

### T9 — Tool result bypass

**Scenario:** A code path sends raw MCP output directly to the DeepSeek continuation mechanism without scanning.

**Mitigations:**

- one bridge-facing `tool-policy` entry point;
- adapters receive sanitized results only;
- integrated tests should assert that forwarding raw results is structurally impossible;
- avoid exporting lower-level transport results directly to page code.

### T10 — Secret leakage through logs/diagnostics

**Scenario:** Debug logs capture tool payloads, blocked file contents, authorization headers, or session credentials.

**Mitigations:**

- log metadata/reason codes rather than raw sensitive payloads;
- no raw blocked values in redaction reports;
- diagnostics should use bounded safe previews only where necessary;
- production logging defaults should be conservative.

### T11 — Malicious repository content attacks the model

**Scenario:** A repository file contains prompt injection instructing the model to read or exfiltrate secrets.

**Mitigations:**

- repository/tool output remains untrusted;
- model instructions cannot override path/tool/content policy;
- all subsequent tool calls are independently authorized;
- secret values remain filtered even if the model asks for them explicitly.

### T12 — Compromised or malicious MCP backend

**Scenario:** The configured MCP endpoint sends crafted results, misleading metadata, or secret-looking content.

**Mitigations:**

- connect only to user-approved HTTPS origins;
- treat all MCP results as untrusted;
- scan return content regardless of backend trust;
- do not grant an MCP server access to DeepSeek session credentials.

### T13 — Container-to-host execution through writable runtime code

**Scenario:** DevSpace can modify a repository mounted read/write, while a host
LaunchAgent or tunnel runtime later executes adapter code directly from that same
tree (or through a symlink into it). Repository write access would then become a
path to execute code as the host user.

**Mitigations:**

- no unattended host process executes code from the DevSpace-writable project tree;
- Tunnel adapter runtime is deployed to a host-only directory outside the project mount;
- deployment accepts only a clean, exact Git-tracked runtime payload;
- releases contain regular copied files only, never repository symlinks;
- each release has an exact manifest and aggregate payload digest;
- `current` switches only after release verification and is updated atomically;
- `config/devspace-projects.yaml` is canonical in Git but runtime reads the deployed copy.

## Out of scope for MVP

The MVP intentionally does not attempt to secure capabilities it does not provide:

- Native Messaging;
- native shell;
- direct host filesystem access;
- Chrome debugger control;
- general browser automation;
- Google Drive / OneDrive;
- unrelated memory systems;
- DeepSeek API-key execution.

Adding any of these changes the threat model and requires an explicit architecture decision first.

## Security test minimums

Security tests should cover at least:

- every default blocked path class;
- traversal/separator bypass attempts;
- allowed near-miss paths to control false positives;
- named secret assignments in common syntaxes;
- private-key blocks;
- bearer/JWT/GitHub/AWS patterns;
- high-entropy values and safe high-entropy-looking near misses;
- multiple redactions in one result;
- custom regex validation and redaction;
- no raw secret values in redaction metadata;
- fail-closed behavior when policy/scanning fails.

## Review trigger

Update this threat model before merging changes that add:

- a Chrome permission;
- a new storage location;
- a new credential flow;
- a new MCP transport/auth mechanism;
- a tool class with broader filesystem/network/command capabilities;
- telemetry/logging;
- a provider adapter beyond DeepSeek Web.
