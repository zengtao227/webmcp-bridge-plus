// Secret Firewall enforcement for the DevSpace adapter.
//
// CONTEXT.md 5.5 is a hard constraint: tool output must pass policy before it
// reaches the model. DevSpace has the whole ~/Doc tree mounted, so an unfiltered
// `read` result can absolutely contain .env files and private keys. Nothing
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
]);

const MAX_PATH_ARGUMENT_LENGTH = 4096;

export class FirewallError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FirewallError';
    this.code = code;
  }
}

export function extractRequestedPath(payload) {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  if (payload.method !== 'tools/call') {
    return undefined;
  }
  const args = payload.params?.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_ARGUMENT_LENGTH) {
      return value;
    }
  }
  return undefined;
}

/**
 * Authorize a request before it is forwarded. A denied path never reaches
 * DevSpace at all, so the secret is never even read.
 */
export function authorizeRequest(payload) {
  const requestedPath = extractRequestedPath(payload);
  if (requestedPath === undefined) {
    return { allowed: true, reason: 'no_path_to_evaluate', requestedPath: null };
  }

  const decision = authorizeToolRequest({ requestedPath });
  if (decision?.allowed !== true) {
    return {
      allowed: false,
      reason: decision?.reason ?? 'path_denied',
      requestedPath,
    };
  }
  return { allowed: true, reason: decision.reason ?? 'allowed', requestedPath };
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

function walk(value, requestedPath, stats) {
  if (Array.isArray(value)) {
    return value.map((entry) => walk(entry, requestedPath, stats));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const node = { ...value };

  // MCP tool results carry text in content blocks shaped { type: 'text', text }.
  if (node.type === 'text' && typeof node.text === 'string') {
    const sanitized = sanitizeTextNode(node.text, requestedPath);
    node.text = sanitized.text;
    if (sanitized.blocked) {
      stats.blocked += 1;
    }
    if (sanitized.redactions.length > 0) {
      stats.redacted += 1;
    }
    return node;
  }

  for (const [key, child] of Object.entries(node)) {
    node[key] = walk(child, requestedPath, stats);
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
