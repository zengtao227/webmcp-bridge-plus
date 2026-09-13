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

function setField(target, field, value, lineNumber) {
  if (!FIELD_PATTERN.test(field) || !Object.hasOwn(target, field) || field === 'id') {
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

function buildRegistry({ version, hosts, currentHostId }) {
  if (version !== 1) {
    fail('Registry version must be exactly 1.', 'UNSUPPORTED_REGISTRY_VERSION');
  }
  if (hosts.size === 0) {
    fail('Registry must contain at least one host.', 'EMPTY_REGISTRY');
  }

  for (const host of hosts.values()) {
    if (!host.app || host.app.length > 256) {
      fail(`Host '${host.id}' requires a bounded app value.`, 'INVALID_HOST');
    }
    if (!isCanonicalAbsolutePath(host.approvedRoot)) {
      fail(`Host '${host.id}' has an invalid approvedRoot.`, 'INVALID_APPROVED_ROOT');
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

  const currentHost = hosts.get(effectiveHostId);
  const registry = {
    version,
    currentHostId: effectiveHostId,
    hosts,
    approvedRoot: currentHost.approvedRoot,
    resolve(reference) {
      if (typeof reference !== 'string') {
        return { status: 'invalid' };
      }
      if (reference.length === 0 || reference.length > MAX_REFERENCE_LENGTH) {
        return { status: 'invalid' };
      }
      if (reference !== currentHost.approvedRoot) {
        return { status: 'missing' };
      }
      return { status: 'unique', workspace: currentHost };
    },
    advertisedReferences() {
      return Object.freeze([currentHost.approvedRoot]);
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
  const hosts = new Map();
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
      const versionMatch = /^version:\s*(\d+)$/.exec(trimmed);
      if (versionMatch) {
        if (version !== null) {
          fail(`Duplicate version on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
        }
        version = Number(versionMatch[1]);
        continue;
      }
      if (trimmed === 'hosts:') {
        section = 'hosts';
        continue;
      }
      fail(`Unsupported top-level registry entry on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
    }

    if (indent === 2) {
      const idMatch = /^([a-z0-9][a-z0-9-]{0,127}):$/.exec(trimmed);
      if (section !== 'hosts' || !idMatch) {
        fail(`Invalid registry entry on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
      }
      const id = idMatch[1];
      if (hosts.has(id)) {
        fail(`Duplicate registry id '${id}'.`, 'DUPLICATE_REGISTRY_ID');
      }
      current = newHost(id);
      hosts.set(id, current);
      continue;
    }

    if (indent === 4) {
      if (!current) {
        fail(`Registry field without an entry on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
      }
      const fieldMatch = /^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(trimmed);
      if (!fieldMatch) {
        fail(`Invalid registry field on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
      }
      setField(current, fieldMatch[1], parseScalar(fieldMatch[2], lineNumber), lineNumber);
      continue;
    }

    fail(`Unsupported registry structure on line ${lineNumber}.`, 'INVALID_REGISTRY_SYNTAX');
  }

  if (version === null) {
    fail('Registry version is required.', 'INVALID_REGISTRY_SYNTAX');
  }
  return buildRegistry({ version, hosts, currentHostId });
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
    return { allowed: true, payload, workspaceRoot: null };
  }
  if (!registry) {
    return { allowed: false, reason: 'project_registry_unavailable' };
  }
  const reference = payload?.params?.arguments?.path;
  const result = registry.resolve(reference);
  if (result.status !== 'unique') {
    const reason = {
      invalid: 'workspace_reference_invalid',
      missing: 'workspace_root_not_allowed',
    }[result.status] ?? 'workspace_routing_failed';
    return { allowed: false, reason };
  }

  return {
    allowed: true,
    workspaceRoot: registry.approvedRoot,
    payload: {
      ...payload,
      params: {
        ...payload.params,
        arguments: {
          ...payload.params.arguments,
          path: registry.approvedRoot,
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
      description: 'Open the single approved workspace root on this DevSpace execution host. Project directories are accessed beneath that workspace; arbitrary filesystem paths are not allowed.',
      inputSchema: {
        ...schema,
        properties: {
          ...properties,
          path: {
            ...pathSchema,
            type: 'string',
            enum: references,
            description: 'Approved workspace root only. Use the single enumerated root; access projects beneath it after the workspace is open.',
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
