# V2.2 Roadmap：Multi-host DevSpace Routing

- 状态：Deferred / moved to future `webmcp-bridge-plus`
- 计划开发时间：TBD，仅在真实 multi-host / 外部用户需求出现后启动
- 前置版本：稳定版 `webmcp-bridge`（single execution host）

> 2026-09-10 决策：当前 `webmcp-bridge` 不继续产品化 multi-host。本文保留为未来独立项目 `webmcp-bridge-plus` 的历史设计输入；其中 DevSpace routing/runtime 方案已被 Native production 架构取代，未来若重启 Plus 设计必须以 Native WebMCP 为基线，而不是恢复本文的 DevSpace execution path。

## 目标

让 ChatGPT 的使用入口与实际执行机器彻底解耦。

这里统一使用 **execution host / DevSpace host** 作为架构术语。`Mac Mini` 只是一种示例，不是架构假设；第二台或未来的执行机器也可能是另一台 MacBook Pro、Windows PC，或其他受支持的 host。

用户无论在世界任何地方、使用哪台电脑登录 ChatGPT 网页版，都只需要用自然语言指定项目和任务；系统根据项目注册信息自动选择正确的 execution host，再在该 host 的批准项目根中执行。用户不应需要知道 host 的操作系统、机器名或父目录。

目标体验：

```text
@DevSpace 去 webmcp-bridge 看一下当前修改
```

自动路由到唯一注册该项目的 execution host，例如：

```text
execution host A (example: MacBook Pro)
→ DevSpace backend on that host
→ approved project webmcp-bridge
```

而：

```text
@DevSpace 去 trading-engine 检查 funding rate logic
```

可以自动路由到另一台 execution host，例如另一台 MacBook Pro、Mac Mini 或 Windows PC，只要该 host/backend 和项目路径已显式注册并满足安全边界。

调用 ChatGPT 的终端设备不决定执行位置；项目注册表决定 execution host。

## 路由不变量（V2.2 明确规则）

用户永远只说项目名，**不说 host、不说文件夹名**（如 `MyCode` / `Code`）。

解析结果只有三种：

- **Unique → execute**：恰好一个已注册项目匹配，自动执行。
- **Ambiguous → ask**：多个已注册项目/别名都可能匹配，停下来列出候选并请用户选择；绝不猜测，不偏向当前 host / 最近使用 / 字母序 / 在线状态 / 名字相近。
- **Missing → fail closed**：零匹配，停止并报告项目未找到；绝不扫描任意文件系统、绝不替换相似项目、绝不 fallback 到另一台 host。

注册表位置（仓库侧，数据-only）：

```yaml
config/devspace-projects.yaml
```

它包含 `hosts` 与 `projects`；每个 project 映射到唯一 host，path 必须在该 host 的 `approvedRoot` 之内。不含密钥、不含运行时 token、不含 `workspaceId`。

## 回归：未知项目不得创建目录（V2.2 Phase 1 修复）

真实 E2E 发现缺陷：未知项目名 `definitely-not-a-real-project` 被归一化后合成
`/work/My code/definitely-not-a-real-project`，并调用 `open_workspace`，导致 DevSpace
在该路径创建了一个空目录。`Missing → fail closed` 因此失效。

修复（V2.2 路由基础）：

- 注册表可用 + 唯一匹配 → 执行；
- 注册表可用 + 歧义匹配 → 询问用户；
- 注册表可用 + 零匹配 → 失败关闭；
- **注册表不可用 → 失败关闭**，绝不回退到 `/work/My code/<归一化名>`。

`open_workspace` 只接受来自显式已注册项目条目的路径；归一化仅用于匹配 canonical id / 别名，绝不生成可执行路径。处理未知项目前后，必须确认
`/work/My code/definitely-not-a-real-project` 未被路由流程创建。

## 概念模型

```text
                    ChatGPT
                       │
                 DevSpace Plugin
                       │
              Host + Project Router
                /             \
               /               \
        MacBook Pro           Mac Mini
        Tunnel / MCP          Tunnel / MCP
             │                    │
          DevSpace             DevSpace
             │                    │
          MyCode                Code
```

每台执行机器拥有自己独立的：

- DevSpace runtime；
- Docker isolation；
- private stdio adapter；
- tunnel-client；
- Secure MCP Tunnel/runtime identity；
- approved project roots；
- Secret Firewall/security boundary。

一台机器不代理另一台机器的本地文件。

## 关键原则

### 1. Host routing 与 project routing 分离

V2.1 只解决：

```text
human project name
→ project path on one known DevSpace host
```

V2.2 增加：

```text
human project name
→ registered host
→ registered project root/path
```

### 2. 使用显式 registry，不扫描任意机器或文件系统

推荐数据模型：

```yaml
projects:
  webmcp-bridge:
    host: macbook-pro
    path: /work/My code/webmcp-bridge

  mycode:
    host: macbook-pro
    path: /work/My code/MyCode

  code:
    host: mac-mini
    path: /work/Code
```

自然语言只用于匹配已注册项目；不能因此获得任意 filesystem discovery 权限。

禁止设计：

```text
project name
→ 在所有 host 上 find /
→ 猜哪个目录是目标
```

### 3. 每个 host 保持独立安全边界

增加任意第二个 execution host 时，都不能要求第一个 host：

- 挂载另一台 host 的文件；
- 代理另一台 host 的 shell；
- 持有另一台 host 的本地凭据；
- 扩大本机 Docker/container mount。

各 execution host 之间都不应该互相获得项目文件或凭据。MacBook Pro、Mac Mini、Windows PC 只是在不同部署中的可能实现。

### 4. Fail closed

如果项目映射到另一个 execution host，但该 host 离线：

```text
Code → execution-host-b → offline
```

结果必须是明确不可用，而不是：

- 自动去当前或其他 execution host 找同名目录；
- 扫描其他 host；
- 改用未批准的路径；
- 建立公网 DevSpace endpoint 作为 fallback。

### 5. Ambiguity 不猜

如果两个 host 都注册了同名项目，必须要求显式 disambiguation，或者 registry 使用唯一 canonical project id。

例如：

```text
code@execution-host-a
code@execution-host-b
```

可以作为明确形式；自然语言别名必须最终映射到一个唯一 canonical id。

## 当前实现方向

V2.2 Phase 1.2 已明确采用两层模型：

1. `config/devspace-projects.yaml` 是 canonical registry；
2. 在线 Skill 只做 UX guidance，不作为 security/correctness boundary；
3. 每个 private adapter 启动时加载 registry，registry 不可用/非法则启动失败；
4. adapter 改写 `tools/list` 中 `open_workspace.path`，只向模型广告本 execution host 的 registered references；
5. adapter 拦截 `tools/call open_workspace`，解析 canonical name / alias / exact registered path；
6. 只有当前 backend 上唯一匹配的项目才改写为 exact registered `project.path` 并继续；
7. unknown、unregistered path、ambiguous、wrong backend 一律 fail closed；
8. 继续复用该 host 上已有 workspaceId。

这样正常项目打开仍然只有一次 `open_workspace` round trip，同时即使 Skill 没有触发，也不能把 guessed path 送到 DevSpace。

未来 multi-host 仍优先采用多个彼此独立的 private runtime / Secure MCP Tunnel identity，而不是新增一个拥有所有 host 文件权限的大型中央代理。

## 下一阶段需要验证的问题

进入真正 multi-host 前确认以下产品/runtime 能力，不凭假设实现：

1. 一个 DevSpace Plugin 是否可以可靠包含/选择多个 MCP Apps/backends；
2. ChatGPT 是否能够基于项目 registry 选择正确的 App/backend；Skill 本身不再被视为强制安全边界；
3. 多个 Secure MCP Tunnel runtime 的 identity、alias 和权限如何最清晰地区分；
4. 每个新增 execution host 的 approved root 应采用什么稳定容器路径；
5. host offline 时 ChatGPT 会收到什么错误，如何保持 fail-closed；
6. workspaceId 是否只在单一 backend/session 内有意义，切 host 时如何避免误复用；
7. registry 存放位置（已决定）：仓库 canonical registry = `config/devspace-projects.yaml`；adapter 直接加载 canonical registry；ChatGPT online Skill 只保留内嵌 UX snapshot。未来若产品支持随 Skill/Plugin 发布 registry，可消除 snapshot 重复；
8. 多 host 情况下如何让用户仍然只看到一个自然语言入口，例如 `@DevSpace`。

## 验收目标

至少完成以下真实端到端场景：

```text
@DevSpace 去 ProjectA 列一下目录，只读
```

必须命中注册 `ProjectA` 的 execution host A。

```text
@DevSpace 去 ProjectB 列一下目录，只读
```

必须命中注册 `ProjectB` 的 execution host B。

然后分别验证：

- 关闭 execution host B 后，ProjectB 请求明确失败且不 fallback；
- execution host A 的 ProjectA 仍正常；
- 两台 host 都不暴露 public MCP endpoint；
- 两台 host 都只暴露各自批准的项目 root；
- 一个 host 的 credential/path 不能通过另一个 host 读取；
- natural-language routing 不扩大 write/commit/push 权限；
- 用户在第三台电脑登录 ChatGPT 网页版时也能通过同一个 ChatGPT-side routing 使用在线 host；
- `workspaceId` 绝不跨不同 backend/execution-host identity 复用——切换到另一台 host 时必须建立新的 workspaceId，不得沿用前一台 host 的会话身份。

## 非目标

V2.2 第一阶段不做：

- host 间文件同步；
- distributed filesystem；
- 自动复制 repository；
- 自动启动离线电脑；
- 任意 LAN discovery；
- 任意 host filesystem search；
- public DevSpace endpoint fallback；
- 跨 host shell proxy；
- 自动把同一任务拆给多台机器并行执行。

## 版本演进

```text
V1
Public DevSpace endpoint
→ abandoned

V2.0
Secure MCP Tunnel
+ stdio adapter
+ local OAuth
+ Secret Firewall
+ Docker isolation

V2.1
V2.0
+ natural-language project routing on one host

V2.2
V2.1
+ explicit host/project registry
+ adapter-enforced open_workspace routing
+ Skill as UX guidance, not security boundary
+ multiple private DevSpace execution hosts (next phase)
+ natural-language host routing (next phase)
```

最终目标：ChatGPT 是统一控制入口；不同 macOS、Windows 或未来其他 execution host 都是相互隔离、按 registry 选择的私有执行节点。
