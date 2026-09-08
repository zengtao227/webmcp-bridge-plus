# DevSpace / Secure MCP Tunnel 排障与踩坑记录

这份文档记录已经踩过的坑、已知限制和建议排查顺序。目标是以后出现类似问题时，先从已知故障模式排查，避免重复走弯路。

## 1. 先确认正常基线

正常状态应该同时满足：

```text
LaunchAgent / tunnel     ready=true
Tailscale Funnel         No serve config
adapter :8787            无监听
DevSpace :7676           127.0.0.1 only
DevSpace publicBaseUrl   http://127.0.0.1:7676
adapter transport        stdio
```

常用检查：

```bash
./adapter/deploy/install-launchd.sh --status
tailscale funnel status
lsof -nP -iTCP:8787 -sTCP:LISTEN
docker ps --filter name=devspace --format '{{.Ports}}'
```

如果这些基线不成立，先修运行环境，不要先改协议代码。

## 2. 坑：Tailscale Funnel 忘记关闭

### 现象

旧 V1 方案依赖 Funnel 把 DevSpace 暴露到公网，并要求使用结束后手工关闭。

2026-09-07 的实际事故中，Funnel 大约一天没有关闭：

- DevSpace 收到 1,732 个 HTTP 请求；
- 其中 33 个请求在扫描凭据或配置路径；
- 公开后约 65 秒出现第一批扫描流量。

### 根因

安全依赖人工“记得关”，属于 fail-open 操作模型。

### 现在的处理

Funnel 已从正常架构移除。正常使用 Secure MCP Tunnel 时：

```text
Tailscale Funnel = No serve config
```

不要把 Funnel 当成自动 fallback。

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

已经删除 `DEVSPACE_PUBLIC_BASE_URL` 环境变量，但 OAuth 仍然指向旧的 Funnel 域名，导致不开 Funnel 时授权失败，例如出现：

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

所以 Funnel 时代的公网 URL 可能继续留在 volume 里。

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

自动恢复尚未实现。

原因是目前还没有对真实 DevSpace 做足够 probe，确认“invalid/stale MCP session”的精确错误 signal 是 HTTP 400、404、某个 JSON-RPC error code，还是其他形式。

不要凭猜测把所有 400 都当成 stale session，否则可能把真正的 malformed request 错判成 session failure。

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

某些运行参数解析可能错误拆分路径。

安装流程会创建无空格 launcher 路径：

```text
~/.local/bin/webmcp-devspace-adapter
```

如果 launch/runtime 报找不到 adapter，检查最终 command 是否引用这个 launcher，而不是未经正确转义的仓库路径。

## 17. 坑：Docker mount 太宽

旧环境曾经把 `~/Doc` 整体暴露给 DevSpace。

当前默认收窄为：

```text
~/Doc/My code
```

并让 Backups、DevSpace 管理目录等不可见。

因为 `bash.command` 是任意 shell text，不能依靠结构化 path policy 完全理解里面所有文件访问，所以 mount boundary 是核心防线之一。

遇到“AI 是否可能看到某个本机文件”的问题时，第一步不是只看 Secret Firewall，而是先看那个文件有没有被 Docker mount 进去。

## 18. 建议排查顺序

如果 `@DevSpace` 突然不可用，按下面顺序查，避免无目的改代码：

### A. Tunnel 是否在线

```bash
./adapter/deploy/install-launchd.sh --status
```

预期：

```text
ready=true
```

### B. 有没有错误恢复到公网架构

```bash
tailscale funnel status
```

预期：

```text
No serve config
```

### C. adapter 是否错误监听 8787

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

预期：无输出。

### D. DevSpace 是否只在 loopback

```bash
docker ps --filter name=devspace --format '{{.Ports}}'
```

预期包含：

```text
127.0.0.1:7676->7676/tcp
```

### E. publicBaseUrl 是否又变成旧公网 URL

检查 `devspace-config` volume。

### F. 运行本地验证

```bash
npm run check
tunnel-client doctor --profile devspace --explain
```

### G. 最后才考虑协议代码

如果 network/runtime/OAuth 都健康，再检查：

- `server/discover` compatibility；
- initialize/session；
- SSE；
- auth challenge sanitization；
- Secret Firewall。

不要一看到连接失败就先改 production code。

## 19. 记录新坑的规则

以后每遇到一个真实问题，建议在这里追加四项：

```text
现象
根因
修复
如何快速确认
```

如果它改变了架构决策，则另外新增或更新 ADR；如果只是运行细节，则只更新本 troubleshooting 文档。
