import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_REFERENCE_LENGTH = 512;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const GIT_CAPABLE_SHELL_DESCRIPTION = 'Run a shell command inside an open workspace. Use it for inspection, tests, builds, package scripts, and other shell-side tooling. Git read and write operations are supported, including git status, git diff, git add, git commit, git branch, git fetch, git pull, and git push. Follow the user-requested scope and applicable repository instructions. Do not use shell redirection or generated scripts to modify project source files; use the dedicated edit/write tools for source changes.';
const GIT_CAPABLE_COMMAND_DESCRIPTION = 'Shell command to execute. Git read and write commands, including git add, git commit, and git push, are supported subject to the user request and repository instructions.';

export class ProjectRegistryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProjectRegistryError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ProjectRegistryError(message, code);
}

function parseScalar(raw, lineNumber) {
  const value = raw.trim();
  if (value.length === 0) {
    fail(`Missing scalar value on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') {
        fail(`Expected a string on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
      }
      return parsed;
    } catch (error) {
      if (error instanceof ProjectRegistryError) {
        throw error;
      }
      fail(`Invalid quoted string on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
    }
  }
  if (/['"{}\[\]&*!>|%@`]/.test(value) || value.includes(' #')) {
    fail(`Unsupported YAML syntax on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
  }
  return value;
}

function newHost(id) {
  return { id, app: null, approvedRoot: null };
}

function newProject(id) {
  return { id, host: null, path: null, aliases: [] };
}

function setField(target, field, value, lineNumber) {
  if (!FIELD_PATTERN.test(field) || !Object.hasOwn(target, field) || field === 'id' || field === 'aliases') {
    fail(`Unsupported registry field '${field}' on line ${lineNumber}.`, 'INVALID_REGISTRY_FIELD');
  }
  if (target[field] !== null) {
    fail(`Duplicate registry field '${field}' on line ${lineNumber}.`, 'DUPLICATE_REGISTRY_FIELD');
  }
  target[field] = value;
}

function isCanonicalAbsolutePath(value) {
  return typeof value === 'string'
    && value.startsWith('/')
    && value.length <= 4096
    && path.posix.normalize(value) === value
    && !value.includes('\0');
}

function isInsideRoot(root, target) {
  const relative = path.posix.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

export function normalizeProjectReference(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REFERENCE_LENGTH) {
    return null;
  }
  return trimmed
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildRegistry({ version, hosts, projects, currentHostId }) {
  if (version !== 1) {
    fail('Registry version must be exactly 1.', 'UNSUPPORTED_REGISTRY_VERSION');
  }
  if (hosts.size === 0 || projects.size === 0) {
    fail('Registry must contain at least one host and one project.', 'EMPTY_REGISTRY');
  }

  for (const host of hosts.values()) {
    if (!host.app || host.app.length > 256) {
      fail(`Host '${host.id}' requires a bounded app value.`, 'INVALID_HOST');
    }
    if (!isCanonicalAbsolutePath(host.approvedRoot)) {
      fail(`Host '${host.id}' has an invalid approvedRoot.`, 'INVALID_APPROVED_ROOT');
    }
  }

  const pathIndex = new Map();
  const nameIndex = new Map();
  const addName = (name, project) => {
    const normalized = normalizeProjectReference(name);
    if (!normalized) {
      fail(`Project '${project.id}' has an invalid name or alias.`, 'INVALID_PROJECT_ALIAS');
    }
    const existing = nameIndex.get(normalized) ?? [];
    if (!existing.includes(project)) {
      existing.push(project);
    }
    nameIndex.set(normalized, existing);
  };

  for (const project of projects.values()) {
    const host = hosts.get(project.host);
    if (!host) {
      fail(`Project '${project.id}' references an unknown host.`, 'UNKNOWN_PROJECT_HOST');
    }
    if (!isCanonicalAbsolutePath(project.path) || !isInsideRoot(host.approvedRoot, project.path)) {
      fail(`Project '${project.id}' has a path outside its approvedRoot.`, 'INVALID_PROJECT_PATH');
    }
    if (pathIndex.has(project.path)) {
      fail(`Project path '${project.path}' is registered more than once.`, 'DUPLICATE_PROJECT_PATH');
    }
    pathIndex.set(project.path, project);
    addName(project.id, project);
    for (const alias of project.aliases) {
      addName(alias, project);
    }
  }

  let effectiveHostId = currentHostId?.trim() || null;
  if (effectiveHostId) {
    if (!hosts.has(effectiveHostId)) {
      fail(`Current host '${effectiveHostId}' is not registered.`, 'UNKNOWN_CURRENT_HOST');
    }
  } else if (hosts.size === 1) {
    [effectiveHostId] = hosts.keys();
  } else {
    fail('DEVSPACE_HOST_ID is required when the registry contains multiple hosts.', 'CURRENT_HOST_REQUIRED');
  }

  const currentProjects = [...projects.values()].filter((project) => project.host === effectiveHostId);
  if (currentProjects.length === 0) {
    fail(`Current host '${effectiveHostId}' has no registered projects.`, 'CURRENT_HOST_HAS_NO_PROJECTS');
  }

  const registry = {
    version,
    currentHostId: effectiveHostId,
    hosts,
    projects,
    currentProjects: Object.freeze(currentProjects),
    resolve(reference) {
      if (typeof reference !== 'string') {
        return { status: 'invalid' };
      }
      const trimmed = reference.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_REFERENCE_LENGTH) {
        return { status: 'invalid' };
      }

      let matches;
      if (trimmed.startsWith('/')) {
        const project = pathIndex.get(trimmed);
        matches = project ? [project] : [];
      } else {
        const normalized = normalizeProjectReference(trimmed);
        matches = normalized ? (nameIndex.get(normalized) ?? []) : [];
      }

      if (matches.length === 0) {
        return { status: 'missing' };
      }
      if (matches.length > 1) {
        return {
          status: 'ambiguous',
          candidates: Object.freeze(matches.map((project) => ({ id: project.id, host: project.host }))),
        };
      }

      const [project] = matches;
      if (project.host !== effectiveHostId) {
        return { status: 'backend_unavailable', project };
      }
      return { status: 'unique', project };
    },
    advertisedReferences() {
      const values = [];
      for (const project of currentProjects) {
        values.push(project.id, ...project.aliases, project.path);
      }
      return Object.freeze([...new Set(values)]);
    },
  };

  return Object.freeze(registry);
}

export function parseProjectRegistry(text, { currentHostId = null } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_BYTES) {
    fail('Project registry must be bounded UTF-8 text.', 'REGISTRY_TOO_LARGE');
  }

  let version = null;
  let section = null;
  let current = null;
  let aliasesProject = null;
  const hosts = new Map();
  const projects = new Map();
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index];
    if (raw.includes('\t')) {
      fail(`Tabs are not allowed on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
    }
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) {
      fail(`Indentation must use two-space levels on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
    }

    if (indent === 0) {
      current = null;
      aliasesProject = null;
      const versionMatch = /^version:\s*(\d+)$/.exec(trimmed);
      if (versionMatch) {
        if (version !== null) {
          fail(`Duplicate version on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
        }
        version = Number(versionMatch[1]);
        continue;
      }
      if (trimmed === 'hosts:' || trimmed === 'projects:') {
        section = trimmed.slice(0, -1);
        continue;
      }
      fail(`Unsupported top-level registry entry on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
    }

    if (indent === 2) {
      aliasesProject = null;
      const idMatch = /^([a-z0-9][a-z0-9-]{0,127}):$/.exec(trimmed);
      if (!section || !idMatch) {
        fail(`Invalid registry entry on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
      }
      const id = idMatch[1];
      const targetMap = section === 'hosts' ? hosts : projects;
      if (targetMap.has(id)) {
        fail(`Duplicate registry id '${id}'.`, 'DUPLICATE_REGISTRY_ID');
      }
      current = section === 'hosts' ? newHost(id) : newProject(id);
      targetMap.set(id, current);
      continue;
    }

    if (indent === 4) {
      if (!current) {
        fail(`Registry field without an entry on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
      }
      if (section === 'projects' && trimmed === 'aliases:') {
        aliasesProject = current;
        continue;
      }
      aliasesProject = null;
      const fieldMatch = /^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(trimmed);
      if (!fieldMatch) {
        fail(`Invalid registry field on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
      }
      setField(current, fieldMatch[1], parseScalar(fieldMatch[2], lineNumber), lineNumber);
      continue;
    }

    if (indent === 6 && section === 'projects' && aliasesProject) {
      const aliasMatch = /^-\s+(.+)$/.exec(trimmed);
      if (!aliasMatch) {
        fail(`Invalid alias on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
      }
      const alias = parseScalar(aliasMatch[1], lineNumber);
      if (alias.length === 0 || alias.length > MAX_REFERENCE_LENGTH) {
        fail(`Alias on line ${lineNumber} is invalid.`, 'INVALID_PROJECT_ALIAS');
      }
      aliasesProject.aliases.push(alias);
      continue;
    }

    fail(`Unsupported registry structure on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
  }

  if (version === null) {
    fail('Registry version is required.', 'INVALID_REGISTRY_SYNTAX');
  }
  return buildRegistry({ version, hosts, projects, currentHostId });
}

export async function loadProjectRegistry(filePath, options = {}) {
  let info;
  let text;
  try {
    info = await stat(filePath);
    if (!info.isFile()) {
      fail('Project registry must be a regular file.', 'REGISTRY_UNAVAILABLE');
    }
    if (info.size > MAX_REGISTRY_BYTES) {
      fail('Project registry exceeds the maximum size.', 'REGISTRY_TOO_LARGE');
    }
    text = await readFile(filePath, { encoding: 'utf8' });
  } catch (error) {
    if (error instanceof ProjectRegistryError) {
      throw error;
    }
    fail('Project registry is unavailable.', 'REGISTRY_UNAVAILABLE');
  }
  return parseProjectRegistry(text, options);
}

export function routeOpenWorkspaceCall(payload, registry) {
  if (payload?.method !== 'tools/call' || payload?.params?.name !== 'open_workspace') {
    return { allowed: true, payload, projectId: null };
  }
  if (!registry) {
    return { allowed: false, reason: 'project_registry_unavailable' };
  }
  const reference = payload?.params?.arguments?.path;
  const result = registry.resolve(reference);
  if (result.status !== 'unique') {
    const reason = {
      invalid: 'project_reference_invalid',
      missing: 'project_unregistered',
      ambiguous: 'project_ambiguous',
      backend_unavailable: 'project_backend_not_selectable',
    }[result.status] ?? 'project_routing_failed';
    return { allowed: false, reason };
  }

  return {
    allowed: true,
    projectId: result.project.id,
    payload: {
      ...payload,
      params: {
        ...payload.params,
        arguments: {
          ...payload.params.arguments,
          path: result.project.path,
        },
      },
    },
  };
}

export function rewriteToolsListPayload(payload, registry) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) {
    return payload;
  }
  const references = registry?.advertisedReferences() ?? null;
  let changed = false;
  const rewrittenTools = tools.map((tool) => {
    if (tool?.name === 'bash') {
      const schema = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema
        : { type: 'object' };
      const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
        ? schema.properties
        : {};
      const commandSchema = properties.command && typeof properties.command === 'object' && !Array.isArray(properties.command)
        ? properties.command
        : { type: 'string' };
      changed = true;
      return {
        ...tool,
        description: GIT_CAPABLE_SHELL_DESCRIPTION,
        inputSchema: {
          ...schema,
          properties: {
            ...properties,
            command: {
              ...commandSchema,
              type: 'string',
              description: GIT_CAPABLE_COMMAND_DESCRIPTION,
            },
          },
        },
      };
    }
    if (tool?.name !== 'open_workspace' || !references) {
      return tool;
    }
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema
      : { type: 'object' };
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties
      : {};
    const pathSchema = properties.path && typeof properties.path === 'object' && !Array.isArray(properties.path)
      ? properties.path
      : { type: 'string' };
    changed = true;
    return {
      ...tool,
      description: 'Open one registered project on this DevSpace execution host. Pass a canonical project name, registered alias, or exact registered project path. Never construct or guess a filesystem path.',
      inputSchema: {
        ...schema,
        properties: {
          ...properties,
          path: {
            ...pathSchema,
            type: 'string',
            enum: references,
            description: 'Registered project reference only. Use one of the enumerated canonical names, aliases, or exact registered paths; do not synthesize /work paths.',
          },
        },
      },
    };
  });
  if (!changed) {
    return payload;
  }
  return {
    ...payload,
    result: {
      ...payload.result,
      tools: rewrittenTools,
    },
  };
}
