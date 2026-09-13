# WebMCP 使用方式

## 1. 日常入口

在 ChatGPT 里使用 `@WebMCP`，直接说明：

1. 要处理哪个项目，或者用自然语言描述项目；
2. 要做什么；
3. 是否只读、是否允许修改、是否允许 commit/push。

例如：

```text
@WebMCP 去 webmcp-bridge 看一下当前修改，只读，不要修改，不要 commit/push。
```

或者：

```text
@WebMCP 在我的项目里找到负责 payment API 的 repo，
先读项目 instructions，再帮我修这个 bug，跑相关测试，但不要 commit。
```

当前 production workflow 是：

```text
open_workspace("/workspace")
→ 在 /workspace 内定位项目
→ 读取项目 AGENTS.md / CLAUDE.md
→ read / write / edit / bash
→ 按用户要求验证
```

## 2. `/workspace` 是什么

`/workspace` 是 Native WebMCP container 内部固定的 MCP root，不是要求用户在 macOS 上创建的目录。

机器 owner 选择一个真实 host 目录，例如：

```text
~/Projects
~/Code
~/Doc/My code
```

Native WebMCP 将它映射成：

```text
host ~/Projects
      ↓
container /workspace
```

如果 host 中有：

```text
~/Projects/project-a
~/Projects/project-b
~/Projects/my-api
```

WebMCP 看到的是：

```text
/workspace/project-a
/workspace/project-b
/workspace/my-api
```

这些目录不要求全部是 Git repository。普通目录也可以使用。

## 3. Project discovery

Native WebMCP 不维护 per-project registry 或 alias table。

只要新项目位于 owner-selected root 下，就会自然出现在 `/workspace` 下，不需要单独注册或刷新。

如果用户只给出项目用途，例如：

```text
@WebMCP 找一下负责 payment API 的项目
```

executor 应先打开 `/workspace`，再用已有的 `read`/`bash` 做小范围目录和 metadata 检查。Natural-language discovery 是工作流行为，不是新的 routing subsystem。

进入具体项目后，应先读取该项目自己的 `AGENTS.md` / `CLAUDE.md` 等 instructions，再执行修改。

## 4. Workspace identity

同一个 Native MCP process 中，重复打开 `/workspace` 会复用同一个 opaque `workspaceId`。

Native process restart 后会生成新的 workspace ID；旧 ID fail closed。

用户正常情况下不需要看到、保存或管理 workspace ID。重新调用：

```text
open_workspace("/workspace")
```

即可继续。

## 5. 推荐工作模式

### 只读调查

适用于架构审查、排错、理解代码、比较方案。

```text
只读。
不要修改任何文件。
不要 commit。
不要 push。
如果发现问题，先给诊断和最小修改方案。
```

### 先分析，再实施

适用于安全敏感、架构或较大改动。

```text
Step 1 只读确认问题
Step 2 给最小修改方案
Step 3 审批
Step 4 只实施批准范围
Step 5 跑测试并 review final diff/status
```

### 直接实施小改动

只适合范围清楚、风险低的任务，例如：

```text
只修改 README 中这一处错误，其他文件不要动。
```

## 6. Git / publication

Native `bash` 可以执行项目内 Git 命令，但 capability 不等于自动授权。

只有用户明确要求时才 commit/push。

对于本仓库，开发执行和最终发布的权限边界由根目录 `AGENTS.md` 与 [`release-review-policy.md`](./release-review-policy.md) 定义。

Native Git publication 是单独的 opt-in capability。默认运行不应为了“以后可能 push”而挂载 host Git credential。

## 7. Workspace root 应该选多大

选择的 host root 就是 WebMCP 的主要 filesystem blast radius。

推荐普通开发范围：

```text
~/Projects
```

或：

```text
~/Code
```

如果只希望授权一个项目，可以选择单个项目目录。

不建议把整个 home directory 作为普通默认值：

```text
/Users/alice
```

因为 writable workspace + arbitrary `bash` 意味着模型可以修改 owner 之后可能执行或依赖的 host files。WebMCP 会保护自己的 control-plane paths，但不会声称枚举所有 macOS persistence 或敏感文件位置。

macOS literal `/` 当前会被配置层拒绝。

## 8. 正常情况下用户不需要管理什么

首次 macOS 安装、状态检查、workspace root 重配和卸载统一使用 [`installation.md`](./installation.md) 里的 Base installer。Secure MCP Tunnel 的 owner account/UI 授权以及 ChatGPT WebMCP App connection 仍由 owner 显式完成；runtime secret 只在本机 Terminal/受保护文件中处理，不应粘贴到 ChatGPT。

日常使用不需要操作：

- Docker container name/image ID；
- image/source pin；
- container policy digest；
- tunnel-client profile internals；
- runtime API key；
- LaunchAgent plist；
- workspace ID；
- host-to-container mount syntax；
- control-plane masks。

这些都属于 implementation detail。

正常一天应该接近：

```text
打开 Mac
→ Native production tunnel 自动恢复
→ immutable host boundary 验证/确保 container
→ Native MCP ready
→ 打开 ChatGPT
→ @WebMCP
→ open /workspace
→ 找项目
→ read/edit/bash/test
```

## 9. 当前 production state

Native WebMCP 是当前 production architecture。

Native-only production tunnel 已完成迁移与 identity cleanup；DevSpace operational state、迁移 `-v2` artifacts 和 rollback profile 已移除。当前 tunnel health/ready 状态正常，Native container 正常运行。

旧 DevSpace adapter、OAuth、session restore、`/work/My code` routing 和 recovery 机制属于历史迁移内容，不是当前 `@WebMCP` 日常运行依赖。

历史资料保留用于解释设计演进，不应作为当前操作说明。

## 10. 一句话记忆

正常使用：

> **`@WebMCP` + 项目名/项目描述 + 任务 + 修改边界。**

Native MCP 入口永远是：

> **`/workspace`。**
