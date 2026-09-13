# DevSpace / Secure MCP Tunnel 排障与踩坑记录

Status: Historical DevSpace migration troubleshooting. Native WebMCP is the current production runtime; the DevSpace adapter/install/recovery implementation referenced here has been removed. Commands and paths below are retained only as migration evidence and are not current production operations.

这份文档记录迁移期间已经踩过的坑、已知限制和当时的排查顺序。目标是保留可复用的故障证据，避免把退役 DevSpace 路径误认为当前 Native production 操作手册。

## 1. 先确认正常基线

正常状态应该同时满足：

```text
LaunchAgent / tunnel     ready=true
adapter :8787            无监听
DevSpace :7676           127.0.0.1 only
DevSpace publicBaseUrl   http://127.0.0.1:7676
adapter transport        stdio
```

常用检查：

```bash
./adapter/deploy/install-launchd.sh --status
lsof -nP -iTCP:8787 -sTCP:LISTEN
docker ps --filter name=devspace --format '{{.Ports}}'
```

如果这些基线不成立，先修运行环境，不要先改协议代码。

## 2. 坑：不要恢复旧公网入站架构

旧公网方案、事故原因和退役决策只在
[`adr/0001-devspace-private-tunnel.md`](./adr/0001-devspace-private-tunnel.md) 中维护。

当前拓扑固定为：DevSpace 只监听 loopback，Mac 主动建立 OpenAI Secure MCP Tunnel outbound connection。
排障时不得把“临时建立公网入口”当成 fallback；如果私有链路不可用，应 fail closed。

## 3. 坑：loopback HTTP adapter 仍然是一个可连接地址

### 现象

私有 Tunnel 的早期版本使用：

```text
127.0.0.1:8787
```

虽然不对公网开放，但同一台 Mac 上的其他进程仍然可以连接该端口。

### 根因

loopback 是网络范围限制，不是调用者身份认证。

### 现在的处理

默认改成 stdio：

```text
tunnel-client → stdin/stdout → adapter
```

adapter 没有 TCP 端口，也没有 Unix socket。

排查时如果发现 8787 监听，说明运行的不是当前默认拓扑。

## 4. 坑：launchd 不能直接托管一个没人连接的 stdio adapter

### 现象

如果把 adapter 本身作为长期 stdio daemon 交给 launchd，它没有调用方，stdio 模型就失去意义。

### 正确拓扑

```text
launchd
  ↓
tunnel-client
  ↓ spawn
stdio adapter
```

由 tunnel-client 创建 adapter 子进程并持有它的 stdin/stdout。

## 5. 坑：DevSpace `publicBaseUrl` 会持久化在 volume

### 现象

已经删除 `DEVSPACE_PUBLIC_BASE_URL` 环境变量，但 OAuth 仍然指向旧公网域名，导致当前私有链路授权失败，例如出现：

```text
AUTHORIZATION_NO_CODE
```

### 根因

DevSpace 读取 `publicBaseUrl` 的优先级包含持久化 volume：

```text
环境变量
→ devspace-config volume 中的 config.json
→ 本机地址 fallback
```

所以历史公网 URL 可能继续留在 volume 里。

### 现在的处理

启动 DevSpace 时把它规范化为：

```text
http://127.0.0.1:7676
```

排查命令：

```bash
docker run --rm -v devspace-config:/root/.devspace alpine cat /root/.devspace/config.json
```

## 6. 坑：OAuth metadata 广告的 host 可能不可达

### 现象

DevSpace metadata 可能广告旧公网 host。Tunnel 模式下该 host 已经不存在或不可达。

### 处理原理

adapter 只保留 metadata 中的 endpoint path，并把 host 重写回配置的 loopback upstream。

注册、authorize、token 都在：

```text
127.0.0.1:7676
```

完成。

不要为了匹配 metadata 重新开启公网 endpoint。

## 7. 坑：DevSpace 401/403 auth challenge 不能直接透传

### 现象

如果 adapter 把 DevSpace 的 401/403 原样返回给 Tunnel，远端可能误以为自己需要执行 OAuth，并尝试访问本机 loopback authorization URL。

### 现在的处理

本地 upstream auth failure 被终止在 adapter：

```text
DevSpace 401/403
→ adapter invalidate/retry or local failure
→ sanitized 502-style error
```

不会把 DevSpace 的 `WWW-Authenticate` 或本地 OAuth 地址暴露出去。

## 8. 坑：`server/discover` 新协议探测与 legacy DevSpace 不兼容

### 现象

ChatGPT / tunnel-client 会发送较新的：

```text
server/discover
```

legacy DevSpace 在 initialize 之前收到它时曾返回 `id: null` 的 session error，调用方无法把响应关联回原请求。

### 现在的处理

stdio adapter 本地返回：

```text
JSON-RPC -32601 Method not found
```

并保留原 request id，让调用方在同一个进程里降级到 legacy initialize 流程。

如果未来这段逻辑出现问题，先确认 tunnel-client / MCP protocol revision 是否发生变化。

## 9. 坑：第二次 `initialize` 不能复用旧 session

### 现象

ChatGPT 做第二次验证 initialize 时，如果 adapter 自动带上前一次 `mcp-session-id`，DevSpace 会返回 HTTP 400。

### 根因

`initialize` 是创建新 MCP session 的请求，不应该附带旧 session。

### 现在的处理

所有 `initialize`：

```text
useSession = false
```

成功后再从 response header 学习新的 session id。

## 10. 坑：adapter 重启后，Tunnel 可能直接发送 tool request

### 现象

`tunnel-client` 的远端 connector state 可能继续存在，但本地 adapter 进程已经重新启动，内存中的 session id 丢失。

此时第一条请求可能直接是：

```text
tools/list
```

或：

```text
tools/call
```

而不是 `initialize`。

### 现在的处理

adapter 没有 session 时会合成 legacy handshake：

```text
initialize
→ notifications/initialized
→ 原始请求
```

相关测试会锁定这个顺序。

## 11. 已知限制：DevSpace 重启后 stale session

### 场景

```text
adapter 继续存活
→ adapter 内存里仍有 sessionId
→ DevSpace container 重启并丢失 MCP session
→ adapter 继续发送旧 sessionId
```

### 当前状态

Phase B 已提供 **repository-side** 的 DevSpace container lifecycle recovery installer，
但它不等于 stale MCP session 自动修复。后者仍未实现，因为目前还没有对真实 DevSpace
做足够 probe，确认“invalid/stale MCP session”的精确错误 signal 是 HTTP 400、404、
某个 JSON-RPC error code，还是其他形式。

不要凭猜测把所有 400 都当成 stale session，否则可能把真正的 malformed request 错判成 session failure。

container lifecycle recovery 的行为边界是：launchd 周期性直接执行 host-only
`~/Doc/devspace-container/dsup.sh --ensure`。如果 Docker 暂时不可用，本轮应非零退出，
不做破坏性操作，等待下一周期；如果已有容器的配置不满足安全条件，`--ensure` 必须
fail closed，不删除、不替换、不尝试绕过原 `dsup.sh` 的安全创建路径。

Container lifecycle recovery（重启/容器被替换后的自愈）在迁移期曾 live activated，并在
2026-09-10 通过真实 machine reboot 验证：recovery LaunchAgent 在登录后自动用
`dsup.sh --ensure` 重建容器（新容器 ID 与 reboot 前不同，证明是重建而非复用），
镜像/网络/挂载安全约束逐项核对一致，全程无人工介入。但这只解决容器本身的自愈，
不等于本节说的 stale MCP session 问题——那个仍是下面"后续正确做法"里描述的未实现项。

### 当前恢复方式

- caller 再发送一次 `initialize`；或
- adapter process restart，让内存 sessionId 清空。

### 后续正确做法

先针对真实 DevSpace 复现 stale session，再基于准确 signal 设计：

```text
invalidate session
→ one bounded reinitialize
→ one bounded retry
```

## 12. 坑：SSE / Accept header

### 现象

DevSpace Streamable HTTP 不接受只声明 `application/json` 的请求，曾返回 HTTP 406。

### 现在的处理

adapter 使用：

```text
Accept: application/json, text/event-stream
```

并支持把 SSE 中的 JSON-RPC data 转成 stdio JSON-RPC message。

如果出现 406，先查 Accept header，不要先怀疑 OAuth。

## 13. 坑：stdout 不能打印日志

stdio 模式下：

```text
stdout = MCP wire protocol
```

任何日志写进 stdout 都可能破坏 JSON-RPC framing。

因此：

- stdout 只写 MCP JSON-RPC；
- diagnostics 写 stderr。

如果出现无法解析的 stdio 响应，先检查有没有普通日志混入 stdout。

## 14. 坑：Secret Firewall 的 `code` 字段与 JSON-RPC `error.code`

### 现象

OAuth authorization code 是敏感字段，所以 sanitizer 会红掉普通 `code` 字段；但 JSON-RPC：

```json
{"error":{"code":-32601}}
```

中的整数 `error.code` 是协议元数据，不能被抹掉。

### 现在的处理

只保留严格 JSON-RPC error 结构里的整数 `error.code`。

字符串 `code`、嵌套 OAuth authorization code 等仍然 redacted。

## 15. 坑：Tunnel profile 格式会随 tunnel-client 版本变化

不要长期手写假设某个 profile schema 永远不变。

当前安装脚本优先使用：

```bash
tunnel-client runtimes connect
```

生成并预检与当前版本匹配的 profile。

如果升级 tunnel-client 后突然无法启动，先检查 profile schema / `mcp.commands`，不要直接改 adapter 协议逻辑。

## 16. 坑：仓库路径包含空格

仓库路径包含：

```text
My code
```

某些运行参数解析可能错误拆分路径，因此常驻 Tunnel 不应直接执行仓库里的 adapter entrypoint。

当前 installer 会先部署 host-only snapshot，并让 tunnel-client 使用稳定的 `current` 入口：

```text
~/Doc/devspace-container/runtime/webmcp-adapter/current/adapter/bin/start.js
```

如果 launch/runtime 报找不到 adapter，检查最终 `--mcp-command` 是否引用这个 host-only `current` snapshot，而不是仓库路径。

## 17. 坑：Docker mount 太宽

旧环境曾经把 `~/Doc` 整体暴露给 DevSpace。

当前默认收窄为：

```text
~/Doc/My code
```

并让 Backups、DevSpace 管理目录等不可见。

因为 `bash.command` 是任意 shell text，不能依靠结构化 path policy 完全理解里面所有文件访问，所以 mount boundary 是核心防线之一。

遇到“AI 是否可能看到某个本机文件”的问题时，第一步不是只看 Secret Firewall，而是先看那个文件有没有被 Docker mount 进去。

## 18. 历史 DevSpace 排查顺序（已退役）

下面步骤只适用于复盘或维护退役 DevSpace 迁移实现。当前 Native WebMCP production 故障不得按这套 DevSpace runtime/OAuth 流程操作。

### A. Tunnel 是否在线

```bash
./adapter/deploy/install-launchd.sh --status
```

预期：

```text
ready=true
```

### B. adapter 是否错误监听 8787

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

预期：无输出。

### C. DevSpace 是否只在 loopback

```bash
docker ps --filter name=devspace --format '{{.Ports}}'
```

预期包含：

```text
127.0.0.1:7676->7676/tcp
```

### D. publicBaseUrl 是否又变成旧公网 URL

检查 `devspace-config` volume。

### E. 运行本地验证

```bash
npm run check
tunnel-client doctor --profile devspace --explain
```

### F. 最后才考虑协议代码

如果 network/runtime/OAuth 都健康，再检查：

- `server/discover` compatibility；
- initialize/session；
- SSE；
- auth challenge sanitization；
- Secret Firewall。

不要一看到连接失败就先改 production code。

## 19. 坑：DevSpace container replacement 后 stale OAuth client/token

### 现象

DevSpace container 被 auto-recovery 重建（新容器 = 新的 server-side OAuth state）后，
adapter 继续持有旧容器签发的 access token 和 dynamic client registration。请求先返回：

```text
TOKEN_REQUEST_FAILED
```

随后持续：

```text
AUTHORIZATION_FAILED
```

人工 `launchctl kickstart` adapter 后立即恢复——说明是 adapter 内存里的 stale OAuth state，
不是 DevSpace 或网络问题。

### 根因

`adapter/src/oauth-client.js` 的 `#establish()` / `invalidate()` 原来只清 `#token`，
没有同时清 `#client`（dynamic client registration）和 `#metadata`。容器换了之后
server 端的 client 注册和 token 都已失效，但 adapter 仍拿着旧 `#client`/`#metadata`
去发起 token 请求，必然失败。

### 修复

新增 `#resetOAuthState()`，`invalidate()` 和 `#establish()` 的 catch 分支都改为调用它，
一次性清 `token`/`client`/`metadata` 三者，逼迫下一次请求重新走完整流程：

```text
discovery → dynamic client registration → authorization → token exchange
```

两个必须覆盖的路径都已加测试：refresh token failure；MCP 旧 access token 被新
DevSpace 立即 401 拒绝。PR #4，merged squash，main `249915ce159bedf235a12b350d0ceecf61027aff`。

### 如何快速确认

在 adapter/tunnel 进程完全不重启的前提下（区别于"进程刚重启、还没有缓存 client"这种
会误判为 PASS 的弱测试），停掉 devspace 容器逼 recovery 重建，再发一次请求，看
`~/Library/Logs/webmcp-devspace-tunnel.err`：

```text
{"event":"token_invalidated"}
{"event":"upstream_unauthorized_retry"}
{"event":"token_issued"}
```

出现这个序列、adapter/tunnel PID 全程不变，才算真正验证了这个修复（2026-09-10 用这个方法
验证过两次：容器换 ID 后 ~220ms 内自动完成，无人工 kickstart）。

## 20. 记录新坑的规则

以后每遇到一个真实问题，建议在这里追加四项：

```text
现象
根因
修复
如何快速确认
```

如果它改变了架构决策，则另外新增或更新 ADR；如果只是运行细节，则只更新本 troubleshooting 文档。
