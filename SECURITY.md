# Security Policy

WebMCP Bridge exists to make browser-based AI coding safer. Security controls in this repository are part of the product contract, not optional guidance to the model.

## Trust boundaries

Treat all of the following as untrusted unless explicitly validated:

- model-generated tool requests;
- DeepSeek page content and page-originated messages;
- MCP tool results;
- repository contents returned by tools;
- remote MCP server metadata and errors;
- user-supplied custom redaction patterns.

The AI model is not part of the trusted computing base.

## Security invariants

1. **Secret Firewall before model context.** No MCP tool result may be forwarded to DeepSeek until deterministic path/tool/content policy has approved or redacted it.
2. **Blocked files are blocked before read whenever possible.** The bridge should deny requests for known-sensitive paths instead of relying only on post-read redaction.
3. **Fail closed.** Invalid policy configuration, malformed custom patterns, or ambiguous sensitive operations must not silently weaken filtering.
4. **No secret logging.** Logs must never contain raw session credentials, MCP bearer/refresh tokens, API keys, private keys, passwords, passphrases, or blocked file contents.
5. **Least privilege.** Chrome permissions must stay limited to the DeepSeek origin, extension storage required for non-secret configuration, and explicitly approved MCP origins.
6. **No host privilege expansion.** The extension must not gain Native Messaging, direct host filesystem access, Docker socket access, or arbitrary host shell in the MVP.
7. **Session credentials stay ephemeral.** DeepSeek Web session credentials must not be persisted to `chrome.storage`, disk, logs, MCP, analytics, or third parties.
8. **Tests use fake credentials only.** Never place real exchange, cloud, source-control, wallet, database, SSH, or DeepSeek credentials in tests or fixtures.

## Secret Firewall behavior

### Path policy

The initial deny policy includes common sensitive files and locations such as:

- `.env` and `.env.*`;
- PEM/key/keystore material;
- SSH private keys;
- `.ssh/`, `.aws/`, `.gnupg/`, `.kube/` credential locations;
- Kubernetes `kubeconfig`;
- credential stores;
- wallet/keystore paths.

Matching is performed against normalized path segments and basenames. The policy must not be bypassed by Windows separators, repeated separators, `.` segments, or simple `..` traversal syntax.

### Content redaction

The scanner redacts high-confidence secret material while preserving enough surrounding structure for the model to continue useful coding work. Initial detectors cover:

- assignments whose key names contain `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `API_KEY`, or `PASSPHRASE`;
- private-key PEM blocks;
- JWT-like bearer credentials;
- GitHub token prefixes;
- AWS access-key identifiers;
- bearer authorization values;
- high-confidence high-entropy quoted/token-like values;
- explicitly configured user regular expressions.

Redaction should report reasons/counts but never expose the raw matched secret in metadata.

## DeepSeek Web adapter requirements

If the adapter needs authenticated DeepSeek Web requests, the preferred design is to execute those requests in the `chat.deepseek.com` page/session context so browser-managed session credentials never leave that context.

Before any implementation that copies a DeepSeek session credential into an extension context, document:

- why page-context execution is insufficient;
- exactly which credential is moved;
- where it exists in memory;
- how long it exists;
- why it cannot be persisted or logged;
- additional threat impact and mitigations.

That design requires explicit review before merging.

## MCP / OAuth requirements

MCP endpoint configuration may be persisted only when it contains no bearer/access/refresh token. OAuth tokens and equivalent authorization material must use an appropriate ephemeral or browser-managed mechanism and must never be included in diagnostics.

MCP server host access should be requested per approved HTTPS origin rather than through blanket `http://*/*`, `https://*/*`, or `<all_urls>` permissions.

For the local DevSpace tunnel deployment, the adapter transport defaults to
stdio and stdout is reserved exclusively for JSON-RPC. Diagnostics go to stderr.
HTTP mode is for explicit debugging only and refuses to start without a bearer
token; loopback address membership is not treated as caller identity.

## Docker / DevSpace boundary

The intended backend sandbox mounts only explicitly approved project directories. Do not mount the host home directory, `/`, `~/.ssh`, `~/.aws`, password stores, or `/var/run/docker.sock`, and do not blindly pass host environment variables into the sandbox.

The DevSpace adapter forwards only the reviewed tool names
`open_workspace`, `read`, `write`, `edit`, and `bash`. A backend upgrade cannot
silently add a newly privileged tool. Because shell text cannot be parsed into a
complete set of filesystem accesses, the `bash` boundary depends on the Docker
mount allowlist, credential-file overlays, and result redaction as well as the
request path checks.

The Secret Firewall is defense in depth; it does not replace sandbox isolation.

## Host-executed runtime boundary

Anything that DevSpace can modify must be treated as untrusted development input,
including the checked-out repository under `~/Doc/My code` / `/work/My code`.
No LaunchAgent, tunnel runtime, or other unattended host process may execute code
through that writable tree or through a symlink that resolves into it.

The private Tunnel therefore runs the adapter from a reviewed host-only snapshot
under `~/Doc/devspace-container/runtime/webmcp-adapter`. The repository remains the
canonical source, but deployment copies an exact Git-verified payload into an
immutable release directory, verifies its manifest and file digests, then atomically
switches a host-only `current` pointer. Runtime configuration such as
`config/devspace-projects.yaml` changes only when a new reviewed snapshot is
deployed.

## Reporting a vulnerability

Do not open a public issue containing live credentials, private keys, session tokens, exploit payloads that expose real user data, or private infrastructure details.

For now, report security findings privately to the repository owner through a private GitHub communication channel available for the repository. Include a minimal reproduction using fake data and explain the expected security boundary.

## Review requirements

Changes require security-focused tests when they affect:

- path normalization or path allow/deny logic;
- content scanning/redaction;
- tool result forwarding;
- page/content/background message contracts;
- MCP authorization;
- Chrome permissions;
- logging or telemetry;
- persistence/storage.

Any new Chrome permission or new class of tool capability must also update `docs/threat-model.md`.
