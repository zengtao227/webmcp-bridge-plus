const TOOL_CALL_OPEN = '<webmcp_tool_call>';
const TOOL_CALL_CLOSE = '</webmcp_tool_call>';
const MAX_TOOL_CALLS = 8;
const MAX_BLOCK_LENGTH = 32 * 1024;
const MAX_ARGUMENT_DEPTH = 12;
const MAX_ARGUMENT_KEYS = 512;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOOL_CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class ToolCallParseError extends Error {
  constructor(message, code = 'INVALID_TOOL_CALL') {
    super(message);
    this.name = 'ToolCallParseError';
    this.code = code;
  }
}

function cloneJsonValue(value, state, depth = 0) {
  if (depth > MAX_ARGUMENT_DEPTH) {
    throw new ToolCallParseError('Tool arguments exceed the maximum nesting depth.', 'ARGUMENT_DEPTH');
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ToolCallParseError('Tool arguments contain a non-finite number.', 'ARGUMENT_NUMBER');
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry, state, depth + 1));
  }

  if (typeof value !== 'object') {
    throw new ToolCallParseError('Tool arguments must contain only JSON values.', 'ARGUMENT_TYPE');
  }

  const output = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    state.keys += 1;
    if (state.keys > MAX_ARGUMENT_KEYS) {
      throw new ToolCallParseError('Tool arguments contain too many object keys.', 'ARGUMENT_KEYS');
    }
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ToolCallParseError(`Forbidden tool argument key: ${key}`, 'ARGUMENT_KEY');
    }
    output[key] = cloneJsonValue(entry, state, depth + 1);
  }
  return output;
}

function parseOneBlock(block) {
  if (block.length > MAX_BLOCK_LENGTH) {
    throw new ToolCallParseError('Tool-call block is too large.', 'BLOCK_TOO_LARGE');
  }

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch {
    throw new ToolCallParseError('Tool-call block is not valid JSON.', 'INVALID_JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolCallParseError('Tool-call payload must be a JSON object.', 'INVALID_PAYLOAD');
  }

  const keys = Object.keys(parsed);
  if (keys.some((key) => !['id', 'name', 'arguments'].includes(key))) {
    throw new ToolCallParseError('Tool-call payload contains unsupported fields.', 'UNSUPPORTED_FIELD');
  }

  if (typeof parsed.id !== 'string' || !TOOL_CALL_ID.test(parsed.id)) {
    throw new ToolCallParseError('Tool-call id is missing or invalid.', 'INVALID_ID');
  }
  if (typeof parsed.name !== 'string' || !TOOL_NAME.test(parsed.name)) {
    throw new ToolCallParseError('Tool-call name is missing or invalid.', 'INVALID_NAME');
  }
  if (!parsed.arguments || typeof parsed.arguments !== 'object' || Array.isArray(parsed.arguments)) {
    throw new ToolCallParseError('Tool-call arguments must be a JSON object.', 'INVALID_ARGUMENTS');
  }

  return Object.freeze({
    id: parsed.id,
    name: parsed.name,
    arguments: cloneJsonValue(parsed.arguments, { keys: 0 }),
  });
}

export function parseToolCalls(text) {
  if (typeof text !== 'string') {
    throw new ToolCallParseError('Assistant response must be text.', 'INVALID_RESPONSE');
  }

  const calls = [];
  const ids = new Set();
  let cursor = 0;

  while (true) {
    const open = text.indexOf(TOOL_CALL_OPEN, cursor);
    if (open === -1) {
      break;
    }

    const blockStart = open + TOOL_CALL_OPEN.length;
    const close = text.indexOf(TOOL_CALL_CLOSE, blockStart);
    if (close === -1) {
      throw new ToolCallParseError('Tool-call marker is not closed.', 'UNCLOSED_MARKER');
    }

    if (calls.length >= MAX_TOOL_CALLS) {
      throw new ToolCallParseError('Assistant requested too many tools in one response.', 'TOO_MANY_CALLS');
    }

    const call = parseOneBlock(text.slice(blockStart, close).trim());
    if (ids.has(call.id)) {
      throw new ToolCallParseError(`Duplicate tool-call id: ${call.id}`, 'DUPLICATE_ID');
    }
    ids.add(call.id);
    calls.push(call);
    cursor = close + TOOL_CALL_CLOSE.length;
  }

  return Object.freeze(calls);
}

export function stripToolCallBlocks(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Assistant response must be text.');
  }

  let output = '';
  let cursor = 0;
  while (true) {
    const open = text.indexOf(TOOL_CALL_OPEN, cursor);
    if (open === -1) {
      output += text.slice(cursor);
      break;
    }

    const blockStart = open + TOOL_CALL_OPEN.length;
    const close = text.indexOf(TOOL_CALL_CLOSE, blockStart);
    if (close === -1) {
      throw new ToolCallParseError('Tool-call marker is not closed.', 'UNCLOSED_MARKER');
    }

    output += text.slice(cursor, open);
    cursor = close + TOOL_CALL_CLOSE.length;
  }

  return output.trim();
}

export function buildToolCallInstruction(toolDefinitions) {
  if (!Array.isArray(toolDefinitions)) {
    throw new TypeError('Tool definitions must be an array.');
  }

  const compact = toolDefinitions.map((tool) => {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) {
      throw new TypeError('Each tool definition requires a valid name.');
    }

    return {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description.slice(0, 2000) : '',
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {},
    };
  });

  return [
    'WebMCP Bridge tools are available for this task.',
    'When a tool is required, emit only one or more exact blocks in this format:',
    '<webmcp_tool_call>{"id":"call_1","name":"tool_name","arguments":{}}</webmcp_tool_call>',
    'Never invent tool names. Tool arguments must be valid JSON objects.',
    'Available tools:',
    JSON.stringify(compact),
  ].join('\n');
}
