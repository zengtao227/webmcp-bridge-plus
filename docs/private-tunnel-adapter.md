# 私有 MCP 适配器（DevSpace over OpenAI Secure MCP Tunnel）

## 要解决的问题

当前设计不发布普通公网 DevSpace 入口。DevSpace 保持 loopback-only，由 Mac 主动建立
OpenAI Secure MCP Tunnel outbound connection；失败时系统应降级为不可用，而不是公网可达。

旧公网方案、事故背景和退役决策集中记录在
[`adr/0001-devspace-private-tunnel.md`](./adr/0001-devspace-private-tunnel.md)，现行运行文档不再重复维护旧方案细节。

## 链路

```
ChatGPT
  → OpenAI 托管隧道（控制面 api.openai.com）
  → Mac 主动外连 HTTPS（无入站端口）
  → tunnel-client 通过 stdio 启动本机私有适配器（无监听地址）
  → DevSpace 容器 127.0.0.1:7676（仅 loopback，容器网络内）
```

没有任何 DevSpace 公网入站端口；当前运行路径只有 loopback-only DevSpace 和主动外连的 Secure MCP Tunnel。

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

DevSpace 的 `publicBaseUrl` 可能残留为旧公网域名（例如
`https://legacy-devspace.example`），走当前私有链路时根本连不上。
适配器拿到元数据后，把所有端点**改写回配置里的 upstream**，只保留广告出来的路径：
注册、授权、换 token 全部打在 `127.0.0.1:7676`。这正是 `#toUpstream()` 干的事，
也有对应的回归测试。

## 信任边界

| 控制 | 说明 |
| --- | --- |
| stdio 默认传输 | 适配器由 tunnel-client 作为子进程启动，没有端口或 socket 可被其他本机进程访问 |
| 不信任任何请求头 | 不读 `Host` / `X-Forwarded-For` / `X-Real-IP` / 自报的设备标识 |
| 不发布 OAuth 元数据 | 隧道侧不会触发浏览器授权，也不暴露端点 |
| 工具 allowlist | 只转发当前已审查的 `open_workspace/read/write/edit/bash`；DevSpace 新增工具默认拒绝 |
| project registry enforcement | `open_workspace` 必须先通过 `config/devspace-projects.yaml` 解析；unknown / unregistered path / wrong backend 在到达 DevSpace 前拒绝，`tools/list` 只广告当前 execution host 的 registered references |
| 凭据只有引用 | `env:` / `file:` / `keychain:`，配置里永远没有明文 |
| 日志脱敏 | bearer、JWT、命名字段、已注册的原文（≥8 字符）全部替换 |
| 失败即关闭 | owner 密码错、JSON 畸形、body 超限、元数据异常一律拒绝，不降级放行 |

设备绑定这件事不用 MAC 地址：MAC 不过公网路由，而且 `X-MAC-Address` 是调用方自己填的，
可以伪造。stdio 把可调用者收窄为持有 tunnel runtime 凭据并启动该子进程的
tunnel-client，同时完全移除了可供其他本机进程连接的适配器地址。

## 怎么用

### 1. 装常驻（一次）

```bash
~/Doc/My\ code/webmcp-bridge/adapter/deploy/install-launchd.sh
```

脚本先用 tunnel-client 自带的 `runtimes connect` 生成并预检配置，再把
`tunnel-client run` 安装成真正的 per-user LaunchAgent；tunnel-client 随登录启动，
并通过 stdio 启动适配器。不会把一个没有调用方的 stdio 进程单独交给 launchd。
首次运行会要求粘贴 Tunnel Runtime API key，并以 `0600` 权限保存到本机
tunnel-client secrets 目录。卸载只移除本机 runtime，不会删除远端 tunnel：
`./install-launchd.sh --uninstall`。安装器使用 host-only snapshot 的稳定 `current`
入口启动适配器，不直接执行仓库路径：
`~/Doc/devspace-container/runtime/webmcp-adapter/current/adapter/bin/start.js`。

### 2. 起 DevSpace（也是一次，之后就一直开着）

```bash
~/Doc/devspace-container/dsup.sh
```

`dsup.sh` 不再建立任何公网入口，也不再传 `DEVSPACE_PUBLIC_BASE_URL`
——不传时 DevSpace 用 `http://127.0.0.1:7676` 当自己的 base URL，
正好和适配器连它的地址一致，OAuth 的 resource 校验才能过。
容器默认只挂载已批准的 `~/Doc/My code` 到 `/work/My code`；
`~/Doc/Backups` 和 `~/Doc/devspace-container` 不可见。可用
`DEVSPACE_PROJECT_ROOT=/更窄的/项目根` 进一步收窄。

`bash` 的 `command` 是 shell 文本，不可能靠路径字段解析穷尽所有写法。
因此它的核心边界是 Docker 只挂载批准代码根、凭据文件覆盖，
以及所有返回字符串再经 Secret Firewall；不声称 shell 内嵌路径一定能在读取前被拦截。

### 可选：DevSpace container Auto-Recovery（Phase B repository-side）

仓库提供一个独立的 macOS LaunchAgent installer：

```bash
bash ./adapter/deploy/install-devspace-recovery-launchd.sh
```

它生成的 LaunchAgent 不执行 Node、仓库代码或 DevSpace mount，只直接调用 host-only：

```text
~/Doc/devspace-container/dsup.sh
--ensure
```

job 使用 `RunAtLoad` + 周期性 `StartInterval`，不使用持续保活语义。Docker 暂时不可用时，
本轮 `--ensure` 应以非零 transient failure 结束并等待下一周期；如果已有容器的安全配置异常，
`dsup.sh --ensure` 必须 fail closed，不能自动删除或替换。Docker context、loopback、mount、
image、credential masking 和 `publicBaseUrl` 等安全策略仍全部归 host-side `dsup.sh` 所有，
installer 不复制这些策略。

当前仓库只完成 repository-side installer；本轮没有读取或修改真实 host-side `dsup.sh`，
也没有安装真实 LaunchAgent。host-side `--ensure` contract 和 live activation 需要独立执行与审查。

> 如果你手动给 DevSpace 设了 `DEVSPACE_PUBLIC_BASE_URL`，就要同时给适配器设
> `DEVSPACE_OAUTH_RESOURCE=<那个 URL>/mcp`。默认不设才是对的。

### 坑：publicBaseUrl 是持久化在卷里的

光删掉环境变量不够。DevSpace 读 `publicBaseUrl` 的优先级是
`环境变量 → devspace-config 卷里的 config.json → 本机地址兜底`。
如果历史配置仍指向公网域名，OAuth 的 resource 校验会要求访问那个域名，
而当前私有链路不会提供该公网入口，最终会断在 `AUTHORIZATION_NO_CODE`。

所以 `dsup.sh` 现在每次起容器前都会把卷里的 `publicBaseUrl` 固定成
`http://127.0.0.1:7676`（改之前先备份成 `config.json.bak-<时间戳>`）。
如果哪天手工改过，看这里就知道为什么连不上：

```bash
docker run --rm -v devspace-config:/root/.devspace alpine cat /root/.devspace/config.json
curl -s http://127.0.0.1:7676/.well-known/oauth-protected-resource/mcp
# 应该是 {"resource":"http://127.0.0.1:7676/mcp", ...}
```

### 3. 隧道配置

`adapter/deploy/tunnel-profile.devspace.yaml` 使用 tunnel-client 0.0.14 的
`mcp.commands` 数组格式。日常安装优先运行上面的脚本，让 `runtimes connect` 生成
与当前 tunnel-client 版本一致的 profile。Runtime API key 使用 `file:` 引用，明文
不进入仓库、profile 或 launchd 参数。

## 验证

```bash
npm run check
tunnel-client doctor --profile devspace --explain
~/Doc/My\ code/webmcp-bridge/adapter/deploy/install-launchd.sh --status
# LaunchAgent 使用动态 loopback 健康端口，URL 记录在：
# ~/Library/Application Support/tunnel-client/health/devspace.url

lsof -nP -iTCP:8787 -sTCP:LISTEN   # 必须没有输出（stdio 无监听）
docker ps --filter name=devspace --format '{{.Ports}}'
# → 127.0.0.1:7676->7676/tcp
~/Doc/devspace-container/verify-isolation.sh
```

### 验收要求（必须对着真实 DevSpace 和 tunnel runtime）

- `initialize` 走适配器返回 200，并透传 `mcp-session-id`
- 接着 `tools/list` 拿到 5 个真实工具：`open_workspace, read, write, edit, bash`
- stdio 目标不执行 HTTP OAuth 发现，也不发布任何适配器 OAuth 端点
- owner 密码故意填错 → 502 `upstream_auth_unavailable`，日志只有
  `{"event":"auth_failed","code":"INVALID_OWNER_TOKEN"}`，没有密码、没有栈
- `install-launchd.sh --status` 返回 `ready=true`，动态 `readyz` 为 200
- ChatGPT 能列出工具并完成一次无副作用的只读调用
- 8787 不再监听，DevSpace 仍只发布在 `127.0.0.1:7676`
