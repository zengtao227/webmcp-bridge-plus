---
name: devspace-project-router
description: Resolve a human-friendly project name such as "webmcp-bridge", "WebMCP Bridge" or "brand production studio" into the approved DevSpace path under /work/My code and open it with the existing open_workspace tool. Use whenever the user invokes @DevSpace and refers to a project by name rather than by an absolute /work/... path.
---

# DevSpace project router

## Purpose

Let the user say:

```text
@DevSpace 去 webmcp-bridge 看一下当前修改，只读。
```

instead of pasting:

```text
/work/My code/webmcp-bridge
```

This skill resolves **location only**. It never changes what the user asked
DevSpace to do, and it never grants permission the user did not give.

## When to activate

Activate when the user invokes `@DevSpace` and refers to a project by a
human-friendly name instead of an absolute approved path.

Do not activate for ordinary follow-up tasks inside an already-open workspace.

## Approved root

```text
/work/My code
```

Every resolved path must begin with exactly `/work/My code/`.

## Resolution rules

### 1. Absolute approved path already given

Use it unchanged.

```text
/work/My code/webmcp-bridge  →  /work/My code/webmcp-bridge
```

### 2. Project name given

Normalize the name conservatively, then resolve it under the approved root:

1. lowercase
2. convert spaces and underscores to hyphens
3. collapse repeated hyphens
4. trim leading/trailing hyphens and whitespace

Then:

```text
/work/My code/<normalized-name>
```

Examples:

```text
webmcp bridge            →  /work/My code/webmcp-bridge
WebMCP Bridge            →  /work/My code/webmcp-bridge
webmcp-bridge            →  /work/My code/webmcp-bridge
brand production studio  →  /work/My code/brand-production-studio
brand-production-studio  →  /work/My code/brand-production-studio
```

### 3. No alias database

Do not build or consult a hard-coded list of project aliases. Normalize only
spacing, case and hyphens.

### 4. Reuse an open workspace

If the current conversation already has a usable `workspaceId` for the same
resolved path, reuse it instead of calling `open_workspace` again.

### 5. Open the workspace

Call the existing `open_workspace` tool with the absolute resolved path.

## Hard limits — refuse, do not guess

Refuse and explain if the project reference:

- contains `..` or any traversal — e.g. `../../something`
- is home-relative or host-absolute — e.g. `~/.ssh`, `/etc`, `/Users/...`
- resolves anywhere outside `/work/My code`
- is empty, or is only a generic word with no project identity

Never search the filesystem for a "similar looking" path. Never substitute a
different project because it looks close.

## Ambiguity and failure

- If two or more real projects could match, **ask the user to choose**.
- If the project cannot be resolved confidently, **say so** and ask for the
  exact project name or the full path.
- If `open_workspace` rejects the path, report the rejection. Do not retry with
  speculative variants.

## Permission is never expanded

Routing answers *where* to work. It never answers *what is allowed*.

Carry the user's task and constraints through unchanged:

| User says | Means |
| --- | --- |
| 只读，不要修改 | read-only; no writes |
| 修改但不要 commit | may edit; must not commit |
| 先分析再给方案 | analysis only; no edits |
| 不要 push | must not push |

If the user did not ask for an action, do not perform it.

## Security note

The only permitted flow is:

```text
natural-language project reference
        ↓
conservative name normalization
        ↓
/work/My code/<resolved-project>
        ↓
open_workspace
```

Never:

```text
natural language  →  filesystem search  →  arbitrary host path
```
