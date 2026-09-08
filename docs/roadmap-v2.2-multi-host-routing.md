# V2.2 Roadmap：Multi-host DevSpace Routing

- 状态：Planned
- 计划开发时间：2026-09-09 起
- 前置版本：V2.0 private Secure MCP Tunnel；V2.1 natural-language project routing

## 目标

让 ChatGPT 的使用入口与实际执行机器彻底解耦。

用户无论在世界任何地方、使用哪台电脑登录 ChatGPT 网页版，都只需要用自然语言指定项目和任务；系统根据项目注册信息自动选择正确的 DevSpace host，再在该 host 的批准项目根中执行。

目标体验：

```text
@DevSpace 去 MyCode 看一下 payment 模块
```

自动路由到：

```text
MacBook Pro
→ DevSpace on MacBook Pro
→ approved project MyCode
```

而：

```text
@DevSpace 去 Code 修一下 build
```

自动路由到：

```text
Mac Mini
→ DevSpace on Mac Mini
→ approved project Code
```

调用 ChatGPT 的终端设备不决定执行位置；项目注册表决定执行 host。

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

Mac Mini 的加入不能要求 MacBook Pro：

- 挂载 Mac Mini 文件；
- 代理 Mac Mini shell；
- 持有 Mac Mini 本地凭据；
- 扩大 MacBook Pro 的 Docker mount。

同样，Mac Mini 不应该获得 MacBook Pro 的项目或凭据。

### 4. Fail closed

如果项目映射到 Mac Mini，但 Mac Mini 离线：

```text
Code → mac-mini → offline
```

结果必须是明确不可用，而不是：

- 自动去 MacBook Pro 找同名目录；
- 扫描其他 host；
- 改用未批准的路径；
- 建立公网 Funnel 作为 fallback。

### 5. Ambiguity 不猜

如果两个 host 都注册了同名项目，必须要求显式 disambiguation，或者 registry 使用唯一 canonical project id。

例如：

```text
code@mac-mini
code@macbook-pro
```

可以作为明确形式；自然语言别名必须最终映射到一个唯一 canonical id。

## 初步实现方向

优先评估最小实现：

1. Mac Mini 部署与 MacBook Pro 相同的 V2 private runtime；
2. 为两个 host 建立独立的 Secure MCP Tunnel/App identity；
3. 在 ChatGPT Plugin/Skill 层维护一个很小的 host/project registry；
4. routing Skill 先解析 canonical project；
5. 根据 registry 选择对应的 DevSpace backend；
6. 再调用该 backend 的现有 `open_workspace`；
7. 继续复用该 host 上已有 workspaceId。

不要优先实现一个新的“大型中央代理服务”，除非 Plugin/App 能力无法满足上述最小模型。

## 明天需要验证的问题

开发前先确认以下产品/runtime 能力，不凭假设实现：

1. 一个 DevSpace Plugin 是否可以可靠包含/选择多个 MCP Apps/backends；
2. ChatGPT Skill 是否能够基于项目 registry 选择正确的 App/backend；
3. 两个 Secure MCP Tunnel runtime 的 identity、alias 和权限如何最清晰地区分；
4. Mac Mini 的 approved root 应采用什么稳定容器路径；
5. host offline 时 ChatGPT 会收到什么错误，如何保持 fail-closed；
6. workspaceId 是否只在单一 backend/session 内有意义，切 host 时如何避免误复用；
7. registry 存放位置（已决定）：仓库 canonical registry = `config/devspace-projects.yaml`；当前 ChatGPT online Skill = 内嵌、已同步的 registry snapshot（复制进 `SKILL.md`）；在线 Skill 不直接读取本 YAML。未来若产品支持随 Skill 一起发布 registry，可消除这份重复。
8. 多 host 情况下如何让用户仍然只看到一个自然语言入口，例如 `@DevSpace`。

## 验收目标

至少完成以下真实端到端场景：

```text
@DevSpace 去 MyCode 列一下目录，只读
```

必须命中 MacBook Pro。

```text
@DevSpace 去 Code 列一下目录，只读
```

必须命中 Mac Mini。

然后分别验证：

- 关闭 Mac Mini 后，Code 请求明确失败且不 fallback；
- MacBook Pro 的 MyCode 仍正常；
- 两台 host 都不暴露 Funnel/public MCP endpoint；
- 两台 host 都只暴露各自批准的项目 root；
- 一个 host 的 credential/path 不能通过另一个 host 读取；
- natural-language routing 不扩大 write/commit/push 权限；
- 用户在第三台电脑登录 ChatGPT 网页版时也能通过同一个 ChatGPT-side routing 使用在线 host。

## 非目标

V2.2 第一阶段不做：

- host 间文件同步；
- distributed filesystem；
- 自动复制 repository；
- 自动启动离线电脑；
- 任意 LAN discovery；
- 任意 host filesystem search；
- public Funnel fallback；
- 跨 host shell proxy；
- 自动把同一任务拆给多台机器并行执行。

## 版本演进

```text
V1
Public Tailscale Funnel
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

V2.2 (planned)
V2.1
+ explicit host/project registry
+ multiple private DevSpace execution hosts
+ natural-language host routing
```

最终目标：ChatGPT 是统一控制入口；MacBook Pro、Mac Mini 或未来其他机器是相互隔离、按 registry 选择的私有执行节点。
