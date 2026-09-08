# 私有 MCP 适配器（DevSpace over OpenAI Secure MCP Tunnel）

## 要解决的问题

之前让 ChatGPT 用 DevSpace 需要开 Tailscale Funnel，把容器的 MCP 端点挂在公网上。
2026-09-07 那次事故里，Funnel 开了大约一天没关，DevSpace 日志显示 1,732 个 HTTP 请求，
其中 33 个是扫凭据/配置文件路径的扫描器请求；暴露后 65 秒内就来了第一批扫描流量。

失败模式是人的问题，不是技术的问题：**靠"记得关"来保证安全，一定会有一天忘记。**
所以目标不是"记得关"，而是**根本不存在需要关的东西**，并且忘记任何一步时，
系统的降级方向是"不可用"，永远不是"公网可见"。

## 链路

```
ChatGPT
  → OpenAI 托管隧道（控制面 api.openai.com）
  → Mac 主动外连 HTTPS（无入站端口）
  → 本机私有适配器 127.0.0.1:8787
  → DevSpace 容器 127.0.0.1:7676（仅 loopback，容器网络内）
```

没有任何入站端口，没有任何公网监听，Tailscale Funnel 不再是路径的一部分。

## 为什么需要适配器

DevSpace 1.0.8 在 `/mcp` 上无条件挂了 `requireBearerAuth`，没有配置项能关掉
（读过容器内的 `dist/server.js` 确认）。也就是说它一定要走 OAuth。

但**OAuth 整套流程完全可以在 loopback 上跑完**：

- `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` 默认就包含 `localhost` 和 `127.0.0.1`；
- `/authorize` 是一个普通表单 POST，接受 `owner_token`，适配器可以自己提交；
- MCP SDK 的 `resourceUrlFromServerUrl` 只去掉 fragment，不要求 HTTPS，
  所以 `http://127.0.0.1:7676` 是合法的 resource。

适配器就是替 ChatGPT 完成这次本地 OAuth，然后拿着 token 转发 MCP 请求。
对外它**不发布任何 OAuth 元数据**（所有 `/.well-known/*`、`/authorize`、`/token`
全部 404），这样 tunnel-client 停在 unauthenticated-target 模式，永远不会弹浏览器授权流程。

### 关键点：元数据里的主机不可达也照样能用

DevSpace 的 `publicBaseUrl` 可能是个公网域名（比如 Funnel 关掉后残留的
`https://taos-macbook-pro.tail47500.ts.net`），走隧道时根本连不上。
适配器拿到元数据后，把所有端点**改写回配置里的 upstream**，只保留广告出来的路径：
注册、授权、换 token 全部打在 `127.0.0.1:7676`。这正是 `#toUpstream()` 干的事，
也有对应的回归测试。

## 信任边界

| 控制 | 说明 |
| --- | --- |
| 只绑 loopback | `ADAPTER_LISTEN_HOST` 不是 `127.0.0.1` / `localhost` / `::1` 就拒绝启动 |
| 不信任任何请求头 | 不读 `Host` / `X-Forwarded-For` / `X-Real-IP` / 自报的设备标识 |
| 不发布 OAuth 元数据 | 隧道侧不会触发浏览器授权，也不暴露端点 |
| 凭据只有引用 | `env:` / `file:` / `keychain:`，配置里永远没有明文 |
| 日志脱敏 | bearer、JWT、命名字段、已注册的原文（≥8 字符）全部替换 |
| 失败即关闭 | owner 密码错、JSON 畸形、body 超限、元数据异常一律拒绝，不降级放行 |

设备绑定这件事不用 MAC 地址：MAC 不过公网路由，而且 `X-MAC-Address` 是调用方自己填的，
可以伪造，达不到 fail-closed。需要设备绑定就上 mTLS（见下）。

## 怎么用

### 1. 装常驻（一次）

```bash
~/Doc/My\ code/webmcp-bridge/adapter/deploy/install-launchd.sh
```

会写 `~/Library/LaunchAgents/com.webmcp.devspace-adapter.plist` 并拉起：
`RunAtLoad` + `KeepAlive`，登录即起、崩了自拉、容器或网络恢复后自动重连。
卸载：`./install-launchd.sh --uninstall`。

> 必须在 Terminal.app 里跑。launchd 只能从真正的 GUI 会话装载，
> 从被沙箱或非 Aqua 会话的进程里调 `launchctl bootstrap` 会报
> `Bootstrap failed: 5: Input/output error`（脚本会识别并提示，plist 仍然是写好的）。

### 2. 起 DevSpace（也是一次，之后就一直开着）

```bash
~/Doc/devspace-container/start-devspace.sh
```

`dsup.sh` 里开 Funnel 的代码已永久删除，也不再传 `DEVSPACE_PUBLIC_BASE_URL`
——不传时 DevSpace 用 `http://127.0.0.1:7676` 当自己的 base URL，
正好和适配器连它的地址一致，OAuth 的 resource 校验才能过。

> 如果你手动给 DevSpace 设了 `DEVSPACE_PUBLIC_BASE_URL`，就要同时给适配器设
> `DEVSPACE_OAUTH_RESOURCE=<那个 URL>/mcp`。默认不设才是对的。

### 坑：publicBaseUrl 是持久化在卷里的

光删掉环境变量不够。DevSpace 读 `publicBaseUrl` 的优先级是
`环境变量 → devspace-config 卷里的 config.json → 本机地址兜底`，
而 Funnel 时代的 `https://taos-macbook-pro.tail47500.ts.net` 已经被写进了卷里。
只要它还指向公网域名，OAuth 的 resource 校验就要求访问那个域名，
不开 Funnel 时根本不可达，链路会断在 `AUTHORIZATION_NO_CODE`。

所以 `dsup.sh` 现在每次起容器前都会把卷里的 `publicBaseUrl` 固定成
`http://127.0.0.1:7676`（改之前先备份成 `config.json.bak-<时间戳>`）。
如果哪天手工改过，看这里就知道为什么连不上：

```bash
docker run --rm -v devspace-config:/root/.devspace alpine cat /root/.devspace/config.json
curl -s http://127.0.0.1:7676/.well-known/oauth-protected-resource/mcp
# 应该是 {"resource":"http://127.0.0.1:7676/mcp", ...}
```

### 3. 隧道配置

`adapter/deploy/tunnel-profile.devspace.yaml` 装到
`~/.config/tunnel-client/devspace.yaml`。唯一要留意的是
`mcp.server_urls` 指向 **8787（适配器）**，不是 7676（DevSpace 本体）。
`api_key` 保持 `env:CONTROL_PLANE_API_KEY`，运行时再给。

## 验证

```bash
npm run check                      # lint + 110 个测试 + build

curl -s http://127.0.0.1:8787/healthz
# → {"status":"ok","authenticated":true}

# 所有 OAuth 元数据路径必须是 404
for p in /.well-known/oauth-protected-resource/mcp \
         /.well-known/oauth-authorization-server /authorize /token; do
  curl -s -o /dev/null -w "$p %{http_code}\n" http://127.0.0.1:8787$p
done

tailscale funnel status            # 必须是 No serve config
lsof -nP -iTCP:8787 -sTCP:LISTEN   # 必须只看到 127.0.0.1
docker ps --filter name=devspace --format '{{.Ports}}'
# → 127.0.0.1:7676->7676/tcp
~/Doc/devspace-container/verify-isolation.sh
```

### 已实测（2026-09-08，对着真实 DevSpace 容器）

- `initialize` 走适配器返回 200，并透传 `mcp-session-id`
- 接着 `tools/list` 拿到 5 个真实工具：`open_workspace, read, write, edit, bash`
- 8 个 OAuth 元数据路径全部 404
- owner 密码故意填错 → 502 `upstream_auth_unavailable`，日志只有
  `{"event":"auth_failed","code":"INVALID_OWNER_TOKEN"}`，没有密码、没有栈
- 当时容器仍带着已经不可达的 `DEVSPACE_PUBLIC_BASE_URL`，链路照样通

## 还没做（下一步）

- **mTLS**：适配器现在是明文 HTTP 的 loopback 端点。同一台 Mac 上的任何其他进程
  都能连 8787。需要按设备绑定身份时，让适配器提供 HTTPS 并启用
  `tunnel-client` 的 `--mcp.server-url="channel=main,url=https://.../mcp,client-cert=...,client-key=..."`。
  注意：非 HTTP 的绑定上加 mTLS 会被 tunnel-client 拒绝，所以必须先上 HTTPS。
- **ChatGPT 端真机验证**：需要 `CONTROL_PLANE_API_KEY`，跑
  `tunnel-client doctor --profile devspace --explain`，再在 ChatGPT 里做一次
  只读工具调用。
