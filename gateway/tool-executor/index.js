import {
  authorizeToolRequest,
  sanitizeToolResult,
} from '../tool-policy/index.js';

const PATH_KEYS = new Set([
  'path',
  'file',
  'filePath',
  'filepath',
  'filename',
  'workingDirectory',
]);
const MAX_PATH_CANDIDATES = 16;

export class ToolExecutionError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ToolExecutionError';
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

export function collectPathCandidates(argumentsObject) {
  if (!isPlainObject(argumentsObject)) {
    throw new ToolExecutionError('Tool arguments must be an object.', 'INVALID_ARGUMENTS');
  }

  const candidates = [];
  const visit = (value, depth = 0) => {
    if (depth > 8 || candidates.length > MAX_PATH_CANDIDATES) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 128)) {
        visit(entry, depth + 1);
      }
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }

    for (const [key, entry] of Object.entries(value).slice(0, 256)) {
      if (PATH_KEYS.has(key) && typeof entry === 'string') {
        candidates.push(entry);
        if (candidates.length > MAX_PATH_CANDIDATES) {
          throw new ToolExecutionError('Tool request contains too many path candidates.', 'TOO_MANY_PATHS');
        }
      } else {
        visit(entry, depth + 1);
      }
    }
  };

  visit(argumentsObject);
  return Object.freeze(candidates);
}

export function authorizeToolCall(toolCall) {
  if (
    !toolCall ||
    typeof toolCall !== 'object' ||
    typeof toolCall.id !== 'string' ||
    typeof toolCall.name !== 'string' ||
    !isPlainObject(toolCall.arguments)
  ) {
    throw new ToolExecutionError('Invalid tool-call envelope.', 'INVALID_TOOL_CALL');
  }

  const paths = collectPathCandidates(toolCall.arguments);
  const decisions = paths.map((requestedPath) => authorizeToolRequest({ requestedPath }));
  const denied = decisions.find((decision) => !decision.allowed);

  if (denied) {
    return Object.freeze({
      allowed: false,
      reason: denied.reason,
      normalizedPath: denied.normalizedPath,
      pathsChecked: decisions.length,
    });
  }

  return Object.freeze({
    allowed: true,
    reason: paths.length === 0 ? 'no_path_to_evaluate' : 'paths_allowed',
    normalizedPath: null,
    pathsChecked: decisions.length,
  });
}

export class SafeToolExecutor {
  #client;
  #customPatterns;

  constructor({ client, customPatterns = [] } = {}) {
    if (!client || typeof client.callToolRaw !== 'function') {
      throw new ToolExecutionError('SafeToolExecutor requires an MCP client.', 'INVALID_CLIENT');
    }
    if (!Array.isArray(customPatterns)) {
      throw new ToolExecutionError('Custom secret patterns must be an array.', 'INVALID_PATTERNS');
    }
    this.#client = client;
    this.#customPatterns = Object.freeze([...customPatterns]);
  }

  async execute(toolCall) {
    const authorization = authorizeToolCall(toolCall);
    if (!authorization.allowed) {
      return Object.freeze({
        ok: false,
        callId: toolCall.id,
        toolName: toolCall.name,
        code: 'PATH_BLOCKED',
        reason: authorization.reason,
        content: null,
        redacted: false,
        redactions: Object.freeze([]),
      });
    }

    let rawResult;
    try {
      rawResult = await this.#client.callToolRaw(toolCall.name, toolCall.arguments);
    } catch (error) {
      throw new ToolExecutionError('MCP tool execution failed before a safe result was produced.', 'MCP_CALL_FAILED', {
        cause: error,
      });
    }

    let sanitized;
    try {
      sanitized = sanitizeToolResult({
        text: rawResult.text,
        customPatterns: this.#customPatterns,
      });
    } catch (error) {
      throw new ToolExecutionError('Secret Firewall rejected the MCP tool result.', 'FIREWALL_FAILED', {
        cause: error,
      });
    }

    if (!sanitized.allowed || typeof sanitized.text !== 'string') {
      throw new ToolExecutionError('Secret Firewall did not produce an allowed text result.', 'FIREWALL_DENIED');
    }

    return Object.freeze({
      ok: rawResult.isError !== true,
      callId: toolCall.id,
      toolName: toolCall.name,
      code: rawResult.isError === true ? 'MCP_TOOL_ERROR' : 'OK',
      reason: sanitized.reason,
      content: sanitized.text,
      redacted: sanitized.redacted,
      redactions: Object.freeze(
        sanitized.redactions.map((entry) => Object.freeze({ reason: entry.reason, count: entry.count })),
      ),
    });
  }
}
