# Agent Demand Gate: Private ChatGPT MCP access

## 1. Friction Point
- Historical friction: The retired public-ingress workflow depended on a manual shutdown step, creating a fail-open exposure risk.
- Who experiences it: The repository owner using ChatGPT Web from one MacBook Pro.
- Why fixed rules or normal automation are insufficient: An AI agent is not required. A deterministic outbound-only tunnel plus fail-closed local service supervision removes the manual security step.
- Evidence source: Incident evidence and the retired design rationale are maintained in `docs/adr/0001-devspace-private-tunnel.md`.

## 2. Quantified Gap
- Baseline metric: One known forgotten shutdown caused about one day of public exposure; 33 scanner requests reached the public endpoint during the reviewed window.
- Target metric: Zero public DevSpace listeners during normal ChatGPT MCP use and automatic tunnel reconnection after login or transient network loss.
- Failure or exit point: Any public DevSpace endpoint, any MCP listener bound beyond loopback or an internal Docker network, or any unauthenticated path from the host/public network to DevSpace blocks rollout.
- Acceptable error / misclassification rate: Zero fail-open authorization decisions and zero secrets written to tracked files or diagnostic logs.
- Measurement window: Initial end-to-end validation plus the first seven days of local runtime health and public-listener checks.
- If missing: Not applicable for the gate; the incident and request counts provide a measured baseline. Seven-day monitoring remains a post-rollout validation step.

## 3. Solution Choice
- Recommended path: non-agent-automation
- Why this path fits current data and change frequency: The required behavior is deterministic networking, authentication, secret handling, and service supervision. Model reasoning would add risk without improving the decision boundary.
- Why the rejected paths are weaker: Prompt chains and workflow agents cannot enforce network isolation. Fine-tuning is unrelated. Retaining any public-ingress workflow with reminders preserves the original human failure mode.
- Smallest useful prototype: A loopback/internal-network MCP adapter compatible with Secure MCP Tunnel, a restricted runtime-key reference, and a supervised `tunnel-client` process; DevSpace remains containerized with only approved mounts.

## 4. Success Preview And Risk Plan
- Success standard: ChatGPT can discover and invoke an expected DevSpace tool through Secure MCP Tunnel while DevSpace remains loopback-only and no DevSpace port is publicly bound.
- Pause / kill signal: OAuth credentials cannot be refreshed without a public authorization endpoint, the adapter can be reached outside its trust boundary, raw secrets appear in output/logs, or Tunnel workspace association cannot be restricted as intended.
- Degraded fallback: Stop the managed tunnel runtime and use local-only DevSpace. The retired public-ingress workflow is not an automatic fallback.
- Owner and review cadence: Repository owner; inspect health and public-listener state after deployment, after the first reboot, and after seven days.
