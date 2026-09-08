import { evaluatePath } from '../path-policy/index.js';
import { redactSecrets } from '../secret-scanner/index.js';

export class ToolPolicyError extends Error {
  constructor(message, code, cause) {
    super(message, { cause });
    this.name = 'ToolPolicyError';
    this.code = code;
  }
}

export function authorizeToolRequest({ requestedPath } = {}) {
  if (requestedPath === undefined || requestedPath === null) {
    return { allowed: true, reason: 'no_path_to_evaluate', normalizedPath: null };
  }

  return evaluatePath(requestedPath);
}

export function sanitizeToolResult({
  requestedPath,
  text,
  customPatterns = [],
} = {}) {
  const requestDecision = authorizeToolRequest({ requestedPath });

  if (!requestDecision.allowed) {
    return {
      allowed: false,
      reason: requestDecision.reason,
      normalizedPath: requestDecision.normalizedPath,
      text: null,
      redacted: false,
      redactions: [],
    };
  }

  if (typeof text !== 'string') {
    throw new ToolPolicyError(
      'Tool result must be converted to text before policy enforcement',
      'unsupported_result_type',
    );
  }

  try {
    const sanitized = redactSecrets(text, { customPatterns });
    return {
      allowed: true,
      reason: sanitized.redacted ? 'allowed_with_redaction' : 'allowed',
      normalizedPath: requestDecision.normalizedPath,
      ...sanitized,
    };
  } catch (error) {
    throw new ToolPolicyError(
      'Secret Firewall failed; raw tool result must not be forwarded',
      'secret_firewall_failure',
      error,
    );
  }
}
