# DevSpace 使用方式

## 1. 最简单的用法

日常使用时，直接在 ChatGPT 里 `@DevSpace`，然后说明：

1. 要打开哪个项目；
2. 要做什么；
3. 有没有限制，例如只读、不改文件、不 commit、不 push。

推荐说法：直接说项目名，不用记路径。

```text
@DevSpace 去 webmcp-bridge 看一下当前修改，只读。
```

```text
@DevSpace go to the webmcp-bridge project and review the current changes.
```

项目名会自动解析到已批准的项目根：

```text
webmcp-bridge  →  /work/My code/webmcp-bridge
```

大小写、空格、连字符的写法差异视为等价：

```text
webmcp bridge
WebMCP Bridge
webmcp-bridge
```

都解析到：

```text
/work/My code/webmcp-bridge
```

精确形式（escape hatch）：项目名有歧义，或你就是想显式指定时，直接给完整路径，会被原样使用。

```text
@DevSpace 打开：

/work/My code/<project>

请帮我 <任务>。

限制：
- <是否允许修改>
- <是否允许运行测试>
- <是否允许 commit>
- <是否允许 push>
```

例如只读审查：

```text
@DevSpace 打开：

/work/My code/webmcp-bridge

请认真阅读当前实现，审查最近的未提交改动，告诉我：
- 设计是否合理
- 有没有安全风险
- 哪些改动是必要的
- 哪些属于过度修改

只读，不要修改文件，不要 commit，不要 push。
```

例如允许实现：

```text
@DevSpace 打开：

/work/My code/webmcp-bridge

请修复 <具体问题>。

要求：
- 先读相关代码和测试
- 做最小必要修改
- 不重构无关代码
- 修改后运行相关测试和 npm run check
- 先不要 commit / push
```

## 2. 同一个项目连续工作

同一个 conversation 里，如果 DevSpace workspace 已经打开，后续通常不需要每次重新给完整路径。

可以直接说：

```text
@DevSpace 继续看刚才这个项目，审查 xxx。
```

或者：

```text
@DevSpace 在当前 workspace 运行 npm run check，然后告诉我失败原因。不要改代码。
```

底层会复用当前 workspace，而不是每次重新建立一套项目环境。

如果切换到另一个项目，直接重新明确项目名即可：

```text
@DevSpace 去 another-project 看一下当前修改
```

只有项目名有歧义或需要精确控制时，再使用完整路径。

## 3. 建议的工作模式

### 模式 A：只读调查

适用于架构审查、排错、理解代码、比较方案。

建议明确写：

```text
只读。
不要修改任何文件。
不要 commit。
不要 push。
如果发现问题，先给诊断和最小修改方案。
```

### 模式 B：方案审批后再修改

适用于不完全信任自动修改质量的场景。

推荐流程：

```text
Step 1 只读确认问题
Step 2 给最小修改方案
Step 3 人工/reviewer 审批
Step 4 只实施批准范围
Step 5 跑测试并 review 最终 working tree
Step 6 交给独立 release reviewer
Step 7 reviewer 独立审完整 diff / security / tests
Step 8 如有小范围 review fix，修复后重新完整验证
Step 9 reviewer PASS 后按授权 commit 并发布；有 blocker 则停止
```

这是当前项目最推荐的高风险修改流程。

### 模式 C：直接实施小改动

只有在任务很明确、风险很低时使用，例如：

```text
只修改 README 中这一处拼写错误，其他文件不要动。
```

## 4. Commit / Push 建议

`@DevSpace` 可以执行 Git read/write 操作，包括 `git add`、`git commit` 和
`git push`。这是一项可用能力，不是自动授权：只有用户在当前任务中明确要求
commit / push 时才执行。

本仓库采用轻量 two-agent release model，详细规则见
[`release-review-policy.md`](./release-review-policy.md)。角色分离如下：

```text
Web/DevSpace development executor
  ↓
修改 + semantic review + 第一轮完整验证
  ↓
保持 reviewable working tree
或（用户明确要求时）push chatgpt/<task> review branch
  ↓
independent release reviewer（例如独立运行的 Claude / Codex）
  ↓
独立检查最终 diff + security + tests
  ↓
PASS 且用户已授权发布
  ↓
reviewer commit approved final tree + push origin/main
```

对于 **Web/DevSpace development executor**：不得直接 push `main`，不得自行 merge
自己的 review branch。若用户明确要求它 commit / push，则仍只发布
`chatgpt/<task>` review branch。

对于 **独立 release reviewer**：如果它不是本次 Web/DevSpace 开发执行者，并且用户在本次
review 中明确授权“验证通过后发布”，则在完成独立 semantic/security review、完整 validation、
确认无 unresolved issue 后，可直接 commit 并 push `origin/main`；不要求为了形式再创建一层
review branch 或 PR。已有 repository protection 不得绕过。PASS 后应把本次流程作为 terminal
release step 完成；如果 reviewer 环境客观上没有 main 发布能力，应立即报告 capability blocker，
不要再把任务无意义地踢回 DevSpace 形成 agent ping-pong。

reviewer 如果只发现小范围、直接由审查产生的问题，可以修复后重新执行完整 final review；
如果修复已经变成 substantive redesign 或明显扩大 scope，则必须停止发布并退回 development。

任何角色都不得 force-push、删除远端 ref/tag、改写历史、修改 Git credential/remote、绕过
repository protections，或提交 secrets/runtime state/unrelated files。adapter、认证、Secret
Firewall、Tunnel、Docker 隔离等安全敏感代码仍需要独立 review。

推荐的 DevSpace 开发请求：

```text
完成修改和 npm run check；检查最终 diff。不要直接 push main。
如我明确要求发布 review branch，再提交到 chatgpt/<简短任务名> 并 push。
```

推荐的独立最终审查请求：

```text
独立审查最终 change set。质量、正确性和安全优先于速度；完整 validation PASS 且无 blocker 后，
无需再次确认，直接 commit approved final tree 并 push origin/main。若 FAIL 则停止发布并报告。
```

## 5. 常用只读命令请求

查看状态：

```text
@DevSpace 在当前项目运行：
git status --short --branch
```

查看最近提交：

```text
@DevSpace 运行：
git log -5 --oneline --decorate
```

查看 diff：

```text
@DevSpace 只读检查当前未提交 diff，重点看安全和 session lifecycle，不要修改文件。
```

运行测试：

```text
@DevSpace 运行 npm run check。失败时只分析，不要自动修复。
```

## 6. 正常情况下不需要做什么

日常使用时，不需要：

- 暴露公网 URL；
- 手工启动 8787 adapter；
- 每次重新做 OAuth；
- 把 DevSpace token 给 ChatGPT；
- 在浏览器里访问本机 `/authorize`。

这些都已经由 Secure MCP Tunnel + tunnel-client + stdio adapter + 本地 OAuth 处理。

## 7. 项目名路由是怎么生效的（Skill 安装）

自然语言项目名（`webmcp-bridge` → `/work/My code/webmcp-bridge`）不是 DevSpace 的内置能力，
它由仓库里的一个 Agent Skill 提供：

```text
skills/devspace-project-router/SKILL.md
```

三点必须知道：

- 仓库里的 `SKILL.md` 是**版本控制的源副本**，是唯一权威来源；
- 仅仅把它提交进 Git **不会**让 ChatGPT 自动使用它；
- 要真正生效，必须把它**安装/上传到 ChatGPT**，或随 DevSpace Plugin 一起打包。

本仓库不尝试自动化 ChatGPT 界面里的安装动作。

未安装时 `@DevSpace` 依然可用，只是需要自己写完整路径（见第 1 节的精确形式）。

## 8. 一句话记忆

以后正常使用可以记成：

> **`@DevSpace` + 项目名 + 任务 + 修改边界。**

如果是重要修改，再加一句：

> **先分析和给方案，批准后才能改；改完先 review，再 commit；commit 再 review，最后 push。**

## 9. V2.2 project routing（single-host enforcement implemented; multi-host planned）

用户仍然只需要说项目名，不需要知道 execution host、操作系统或父目录：

```text
@DevSpace 去 webmcp-bridge 看一下当前修改
```

当前 registry 位于 `config/devspace-projects.yaml`。在线 Skill 负责帮助模型理解项目名，但**adapter 才是最终执法点**：

```text
project reference
→ adapter registry lookup
→ canonical name / alias / exact registered path
→ exact registered project.path
→ real DevSpace open_workspace
```

如果模型自己猜 `/work/webmcp-bridge`，或者用户给出未注册的绝对路径，adapter 必须在调用真实 DevSpace 前拒绝。未知项目不得通过 `open_workspace` 创建空目录。

adapter 还会改写 `tools/list` 中 `open_workspace.path` 的 schema，让 ChatGPT 看到的是当前 execution host 上已注册的 project references，而不是一个可以任意填写的 filesystem path。

当前 registry 只有一个 live execution host，因此 adapter 可以自动选它。未来 registry 一旦包含多个 host，每个 adapter runtime 必须显式配置 `DEVSPACE_HOST_ID`；未配置时启动失败关闭。真正的 per-host App/backend 自动选择仍属于后续 multi-host 阶段。

示例中的 MacBook Pro、Mac Mini 或 Windows PC 都只是 execution host 的可能实现，不是架构假设。
