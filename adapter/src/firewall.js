// Secret Firewall enforcement for the DevSpace adapter.
//
// CONTEXT.md 5.5 is a hard constraint: tool output must pass policy before it
// reaches the model. DevSpace has an approved project root mounted, so an
// unfiltered `read` result can still contain .env files and private keys. Nothing
// leaves this module without passing the repository's own policy, and a failure
// inside the firewall must deny rather than fall through to raw output.

import {
  authorizeToolRequest,
  sanitizeToolResult,
  ToolPolicyError,
} from '../../gateway/tool-policy/index.js';

// DevSpace tools take a path under several names; cover the ones it actually
// exposes (open_workspace/read/write/edit/bash all accept some path argument).
const PATH_ARGUMENT_KEYS = Object.freeze([
  'path',
  'filePath',
  'file_path',
  'file',
  'target',
  'workspacePath',
  'cwd',
  'root',
  'dir',
  'directory',
  'workingDirectory',
]);

const MAX_PATH_ARGUMENT_LENGTH = 4096;
const MAX_PATH_ARGUMENTS = 16;
const MAX_ARGUMENT_DEPTH = 8;
const ALLOWED_TOOL_NAMES = new Set(['open_workspace', 'read', 'write', 'edit', 'bash']);
const TOOLS_REQUIRING_PATH = new Set(['open_workspace', 'read', 'write', 'edit']);

export class FirewallError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FirewallError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function extractRequestedPaths(payload) {
  if (!payload || typeof payload !== 'object') {
    return Object.freeze([]);
  }
  if (payload.method !== 'tools/call') {
    return Object.freeze([]);
  }
  const args = payload.params?.arguments;
  if (!isPlainObject(args)) {
    throw new FirewallError('Tool arguments must be an object.', 'invalid_tool_arguments');
  }

  const paths = [];
  const visit = (value, depth = 0) => {
    if (depth > MAX_ARGUMENT_DEPTH) {
      throw new FirewallError('Tool arguments are nested too deeply.', 'arguments_too_deep');
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (PATH_ARGUMENT_KEYS.includes(key)) {
        if (
          typeof entry !== 'string' ||
          entry.length === 0 ||
          entry.length > MAX_PATH_ARGUMENT_LENGTH
        ) {
          throw new FirewallError('Path arguments must be bounded strings.', 'invalid_path_argument');
        }
        paths.push(entry);
        if (paths.length > MAX_PATH_ARGUMENTS) {
          throw new FirewallError('Too many path arguments.', 'too_many_path_arguments');
        }
      } else {
        visit(entry, depth + 1);
      }
    }
  };
  visit(args);
  return Object.freeze(paths);
}

export function extractRequestedPath(payload) {
  return extractRequestedPaths(payload)[0];
}

/**
 * Authorize a request before it is forwarded. A denied path never reaches
 * DevSpace at all, so the secret is never even read.
 */
export function authorizeRequest(payload) {
  if (payload?.method === 'tools/call') {
    if (!Object.hasOwn(payload, 'id') || !['string', 'number'].includes(typeof payload.id)) {
      return {
        allowed: false,
        reason: 'invalid_request_id',
        requestedPath: null,
        requestedPaths: Object.freeze([]),
      };
    }
    const toolName = payload?.params?.name;
    if (typeof toolName !== 'string' || !ALLOWED_TOOL_NAMES.has(toolName)) {
      return {
        allowed: false,
        reason: 'tool_not_allowed',
        requestedPath: null,
        requestedPaths: Object.freeze([]),
      };
    }
  }

  let requestedPaths;
  try {
    requestedPaths = extractRequestedPaths(payload);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof FirewallError ? error.code : 'path_policy_failure',
      requestedPath: null,
      requestedPaths: Object.freeze([]),
    };
  }

  const toolName = payload?.params?.name;
  if (TOOLS_REQUIRING_PATH.has(toolName) && requestedPaths.length === 0) {
    return {
      allowed: false,
      reason: 'missing_path_argument',
      requestedPath: null,
      requestedPaths,
    };
  }

  for (const requestedPath of requestedPaths) {
    const decision = authorizeToolRequest({ requestedPath });
    if (decision?.allowed !== true) {
      return {
        allowed: false,
        reason: decision?.reason ?? 'path_denied',
        requestedPath,
        requestedPaths,
      };
    }
  }

  return {
    allowed: true,
    reason: requestedPaths.length === 0 ? 'no_path_to_evaluate' : 'allowed',
    requestedPath: requestedPaths[0] ?? null,
    requestedPaths,
  };
}

const BLOCKED_REPLACEMENT = '[blocked by Secret Firewall]';

function sanitizeTextNode(text, requestedPath) {
  const result = sanitizeToolResult({ requestedPath, text });
  if (result.allowed !== true) {
    return { text: BLOCKED_REPLACEMENT, redactions: [], blocked: true };
  }
  return {
    text: result.text,
    redactions: result.redactions ?? [],
    blocked: false,
  };
}

function sanitizeString(text, key, requestedPath, stats) {
  const direct = sanitizeTextNode(text, requestedPath);
  if (direct.blocked) {
    stats.blocked += 1;
    return direct.text;
  }
  if (direct.redactions.length > 0) {
    stats.redacted += 1;
  }

  // Preserve a structured field name as scanner context without returning
  // that synthetic context to the caller. This catches { api_key: "..." }.
  if (typeof key === 'string') {
    const contextual = sanitizeTextNode(`${key}=${JSON.stringify(direct.text)}`, null);
    if (contextual.redactions.length > 0) {
      stats.redacted += 1;
      return '[REDACTED]';
    }
  }

  // A lone structured string still needs high-entropy literal detection.
  const quoted = sanitizeTextNode(JSON.stringify(direct.text), null);
  if (quoted.redactions.length > 0) {
    stats.redacted += 1;
    return JSON.parse(quoted.text);
  }
  return direct.text;
}

function walk(value, requestedPath, stats, key = null, textBlock = false) {
  if (Array.isArray(value)) {
    return value.map((entry) => walk(entry, requestedPath, stats));
  }
  if (typeof value === 'string') {
    return sanitizeString(value, key, textBlock ? requestedPath : null, stats);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const node = { ...value };

  for (const [childKey, child] of Object.entries(node)) {
    node[childKey] = walk(
      child,
      requestedPath,
      stats,
      childKey,
      node.type === 'text' && childKey === 'text',
    );
  }
  return node;
}

/**
 * Redact a response payload. Throws FirewallError on any policy failure, so the
 * caller is forced into the deny path instead of forwarding raw output.
 */
export function firewallResponse(payload, requestedPath = null) {
  const stats = { blocked: 0, redacted: 0 };
  try {
    const sanitized = walk(payload, requestedPath, stats);
    return { payload: sanitized, ...stats };
  } catch (error) {
    if (error instanceof ToolPolicyError) {
      throw new FirewallError(error.message, error.code ?? 'secret_firewall_failure');
    }
    throw new FirewallError('Secret Firewall failed; raw result must not be forwarded.', 'secret_firewall_failure');
  }
}

export function deniedToolResult(id, reason) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32001,
      message: `Blocked by Secret Firewall: ${reason}`,
    },
  };
}
