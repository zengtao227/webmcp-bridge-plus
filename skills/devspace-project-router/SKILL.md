---
name: devspace-project-router
description: Resolve a human-friendly project name (or an exact registered absolute path) such as "webmcp-bridge", "WebMCP Bridge" or "/work/My code/webmcp-bridge" into the registered DevSpace host and approved path, then open it with the existing open_workspace tool. Use whenever the user invokes @DevSpace and refers to a project. Resolution is governed by a registry (config/devspace-projects.yaml is canonical; an embedded snapshot makes the Skill self-contained in ChatGPT): registered name/alias/exact path -> execute, ambiguous -> ask, unknown name / unregistered path / registry unavailable -> fail closed. open_workspace only ever receives an exact registered project.path.
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

## Evolution note (V2.1 -> V2.2)

- **V2.1 (historical):** `project name -> /work/My code/<project>` on one known host.
- **V2.2 (current routing model):** `project name -> registry entry -> host/app -> approved path -> open_workspace`.

Only projects **explicitly listed in the registry** are routable. Projects
carried forward from V2.1 and explicitly registered in V2.2 keep the same
paths (e.g. `webmcp-bridge` -> `/work/My code/webmcp-bridge`). Any project
that is **not** in the registry now fails closed until an explicit registry
entry is added. This is an intentional security tightening, not a loss of
functionality for registered projects; a project name never synthesizes a
filesystem path.

## When to activate

Activate when the user invokes `@DevSpace` and refers to a project by:

- canonical registered project name;
- registered alias; or
- exact registered absolute project path.

Do not activate for ordinary follow-up tasks inside an already-open workspace.

## Registry (source of truth)

The canonical routing data lives in:

```text
config/devspace-projects.yaml
```

This repository file is the source of truth. When this Skill is deployed into
ChatGPT via the online editor, the live Skill cannot read this repository file —
use the embedded snapshot in the next section instead.

It is data-only:

- `hosts.<id>.app` — routing/planned metadata for the DevSpace App/backend of that host. Not yet a proven callable identifier; see "Host / App selection".
- `hosts.<id>.approvedRoot` — the only directory that host may open.
- `projects.<id>.host` — exactly one registered host id.
- `projects.<id>.path` — must be inside that host's `approvedRoot`.
- `projects.<id>.aliases` — optional small list of human-friendly spellings.

No secrets, no runtime tokens, no Tunnel API keys, no `workspaceId` are stored
there.

If the registry is **not available**, routing MUST fail closed. It must NEVER
fall back to synthesizing `/work/My code/<normalized-name>`: `open_workspace`
may create a missing directory, so a guessed path is a real, silent side effect.
See the mandatory invariant below.

## Embedded registry snapshot (deployable)

`config/devspace-projects.yaml` is the **repository canonical registry**. The
block below is an **embedded snapshot** so this Skill is self-contained when copied
into the standalone ChatGPT online Skill editor, which does NOT automatically have
access to the repository file. Do NOT claim the live Skill can read the repo YAML —
it uses this embedded snapshot.

When registry entries change, **synchronize this snapshot** before the live
ChatGPT Skill is considered updated.

```text
Host:
macbook-pro
app: devspace-macbook-pro
approvedRoot: /work/My code

Projects:

webmcp-bridge
host: macbook-pro
path: /work/My code/webmcp-bridge
aliases:
- webmcp bridge
- WebMCP Bridge

brand-production-studio
host: macbook-pro
path: /work/My code/brand-production-studio
aliases:
- brand production studio
```

## Mandatory routing invariant

```text
Registry available + UNIQUE MATCH     -> execute (open_workspace with the registered path)
Registry available + AMBIGUOUS MATCH  -> ask the user
Registry available + ZERO MATCH       -> fail closed
Registry UNAVAILABLE                  -> fail closed
```

In one line:

```text
Registry + unique    -> execute
Registry + ambiguous  -> ask
Registry + zero      -> fail closed
Registry missing     -> fail closed
```

Consolidated decision table (name, alias, and exact absolute path all resolve
through the registry):

```text
registered unique name       -> execute
registered unique alias      -> execute
registered exact abs path    -> execute
ambiguous registered match   -> ask
unknown name                 -> fail closed
unregistered abs path         -> fail closed
registry unavailable          -> fail closed
```

`Registry missing -> fail closed` is hard: it must NEVER fall back to
`/work/My code/<normalized-name>`. `open_workspace` may create a missing
directory, so any synthesized path is an unacceptable side effect.

This rule applies to the current V2.2 routing model and all future multi-host
routing.

## Resolution rules

### 1. Absolute approved path already given

An absolute path is allowed ONLY if it exactly matches the `path` of one explicit
registered project entry (in the registry / embedded snapshot).

```text
/work/My code/webmcp-bridge
  -> exact registered path
  -> allowed

/work/My code/definitely-not-a-real-project
  -> not registered
  -> refused
  -> open_workspace NOT called
```

If the supplied path does not exactly match a registered project `path`, fail
closed and do NOT call `open_workspace`. Registry membership is the only authority
— do NOT use filesystem existence as a substitute for registry membership.

### 2. Project name given

Normalize the reference conservatively, then look it up in the registry
(canonical project id OR one of its aliases):

1. lowercase
2. convert spaces and underscores to hyphens
3. collapse repeated hyphens
4. trim leading/trailing hyphens and whitespace

Then resolve:

```text
webmcp-bridge
  -> registry entry (host: macbook-pro)
  -> app: devspace-macbook-pro
  -> path: /work/My code/webmcp-bridge
```

Normalization is **match-only**: it is used solely to compare against a canonical
project id or an explicit alias, and it must never itself produce a filesystem
path.

Examples:

```text
webmcp bridge            ->  webmcp-bridge  ->  /work/My code/webmcp-bridge
WebMCP Bridge            ->  webmcp-bridge  ->  /work/My code/webmcp-bridge
webmcp-bridge            ->  webmcp-bridge  ->  /work/My code/webmcp-bridge
brand production studio  ->  brand-production-studio  ->  /work/My code/brand-production-studio
```

#### Hard rules for calling open_workspace

1. `open_workspace` may only be called with a path obtained from an **explicit
   registered project entry**.
2. Normalization is used only to match a canonical project id or explicit alias.
3. Normalization must never itself generate an executable filesystem path.
4. Unknown project names must never call `open_workspace`.
5. A missing registry must never call `open_workspace`.
6. No filesystem scan may be used to compensate.
7. No speculative path may be tried.
8. No fallback host/path is allowed.

### 3. Aliases

Each project MAY carry a small, explicit alias list (e.g. `webmcp bridge`,
`WebMCP Bridge`). Aliases resolve deterministically:

- an alias maps to exactly one canonical project;
- if one alias string could match two different canonical projects, that is an
  **alias collision = ambiguous** (see rule below);
- never auto-resolve a collision.

Do not build a fuzzy-search engine. No filesystem search.

### 4. Routing outcome

**Unique** — exactly one registered project matches:

```text
webmcp-bridge -> macbook-pro -> /work/My code/webmcp-bridge
```

continue automatically (see "Open the workspace").

**Ambiguous** — more than one registered entry/alias could match, e.g.:

```text
demo@execution-host-a
demo@execution-host-b
```

stop and ask the user to choose. Do NOT prefer:

- the current host;
- the most recently used host;
- the alphabetically first host;
- the online host;
- the closest name.

**Missing** — zero registered projects match: stop and report the project as
unresolved. Do NOT:

- scan `/work`;
- search other mounts;
- run `find /`;
- search another host;
- guess a similar repository;
- create a new registry entry automatically.

### 5. Host / App selection — be honest about what is proven

For the current single-host deployment, `app` (e.g. `devspace-macbook-pro`) is
**routing/planned metadata only**. Use the **already-connected DevSpace backend**
(the `@DevSpace` the user is already talking to). Do NOT attempt to invoke or
switch to an App named `devspace-macbook-pro`.

So the live flow is:

```text
registered project  ->  registered path  ->  existing connected DevSpace  ->  open_workspace
```

NOT:

```text
registered project  ->  try to dynamically invoke devspace-macbook-pro
```

For a host other than the one currently connected, per-host App/backend selection
is not yet available live. If routing resolves to a registered execution host/backend
that is not the one currently connected:

- stop;
- report that the registered execution host/backend is not currently selectable;
- do NOT call `open_workspace` on the current backend;
- do NOT fall back to another host or path;
- do NOT ask the user to provide a different path.

Only genuine routing ambiguity (more than one registered candidate matches) should
ask the user to choose among registered candidates. Do NOT invent dynamic App
switching.

### 6. Reuse an open workspace

If the current conversation already has a usable `workspaceId` for the same
`(host/app, canonical project id)`, reuse it instead of calling `open_workspace`
again. See "Workspace isolation" for when a `workspaceId` may be reused.

### 7. Open the workspace

Call the existing `open_workspace` tool with the absolute resolved path.

## Hard limits — refuse, do not guess

Refuse and explain if the project reference:

- contains `..` or any traversal — e.g. `../../something`
- is home-relative or host-absolute — e.g. `~/.ssh`, `/etc`, `/Users/...`
- resolves anywhere outside the matched host's `approvedRoot`
- is empty, or is only a generic word with no project identity
- names a host that is not in the registry (unregistered host)
- is an unknown / unregistered project

Never search the filesystem for a "similar looking" path. Never substitute a
different project because it looks close. Never fall back to another host.

## Workspace isolation

A `workspaceId` is bound to a specific backend.

```text
(host/app identity, canonical project id)  ->  workspaceId
```

Rules:

- a `workspaceId` is only reusable for the SAME host/backend AND the SAME
  canonical project id;
- never reuse a `workspaceId` from one execution host/backend on another
  execution host/backend, even if the canonical project name is identical;
- when the resolved host differs from the host that owns the current
  `workspaceId`, treat it as a new backend and obtain a fresh `workspaceId`
  through that host's registered App — do not carry the old id across.

## Host offline behavior (future rule, fail-closed)

When routing resolves a project to a registered host that is unavailable:

```text
project -> registered host -> host unavailable -> explicit host unavailable error
```

Never:

- fall back to another host;
- search for the same project elsewhere;
- enable a Funnel / public endpoint;
- change the project's host mapping.

This phase does not implement online/offline detection runtime code. The rule is
documented now so the behavior is fixed before any second host is attached.

## Ambiguity and failure

- **Ambiguous** (more than one registered candidate matches): ask the user to
  choose among the registered candidates. Never pick on their behalf.
- **Missing** (zero registered matches): ask for a registered canonical project
  name, or report that a registry entry must first be added. Do not offer an
  absolute path as a workaround.
- A user-supplied absolute path is only acceptable under Rule 1 when it EXACTLY
  matches a registered `project.path`.
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
registry lookup (unique / ambiguous / missing)
        ↓
registered host/app + approved path
        ↓
open_workspace
```

Never:

```text
natural language  ->  filesystem search  ->  arbitrary host path
natural language  ->  guess host         ->  fallback host
```

## Routing contract examples (validation)

The routing flow MUST satisfy all of these:

```text
webmcp-bridge
  -> registered unique name
  -> execute (open_workspace with /work/My code/webmcp-bridge)

WebMCP Bridge
  -> registered unique alias
  -> execute (open_workspace with /work/My code/webmcp-bridge)

/work/My code/webmcp-bridge
  -> registered exact absolute path
  -> execute (open_workspace allowed)

definitely-not-a-real-project
  -> unknown name
  -> fail closed
  -> open_workspace must NOT be called

/work/My code/definitely-not-a-real-project
  -> unregistered absolute path
  -> fail closed (refused)
  -> open_workspace must NOT be called
  -> directory must NOT be created

../../something
  -> rejected (traversal) BEFORE registry lookup / tool call
```

`open_workspace` must only ever receive an exact `path` from a registered project
entry — never a normalized, guessed, or filesystem-probed path.

### Regression guard

Before and after handling an unknown project, verify that
`/work/My code/definitely-not-a-real-project` (or any other guessed path) is
**not** created by the routing flow. The routing layer must never create a
directory; it only opens paths that already exist as registered entries.
