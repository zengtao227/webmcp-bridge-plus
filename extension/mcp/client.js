import {
  MCP_REVISION_CURRENT,
  MCP_REVISION_LEGACY,
  McpTransportError,
  StreamableHttpTransport,
} from './streamable-http.js';

const MAX_TOOLS = 256;
const MAX_TOOL_NAME = 128;
const MAX_DESCRIPTION = 8 * 1024;
const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_RESULT_TEXT_BYTES = 1024 * 1024;
const UTF8 = new TextEncoder();
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class McpClientError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'McpClientError';
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

function cloneBoundedJson(value, state, depth = 0) {
  if (depth > 16) {
    throw new McpClientError('MCP JSON value exceeds the nesting limit.', 'JSON_DEPTH');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') {
      state.bytes += UTF8.encode(value).byteLength;
    }
    if (state.bytes > state.maxBytes) {
      throw new McpClientError('MCP JSON value exceeds the size limit.', 'JSON_SIZE');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new McpClientError('MCP JSON value contains a non-finite number.', 'JSON_NUMBER');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 2048) {
      throw new McpClientError('MCP JSON array is too large.', 'JSON_ARRAY');
    }
    return value.map((entry) => cloneBoundedJson(entry, state, depth + 1));
  }
  if (!isPlainObject(value)) {
    throw new McpClientError('MCP value contains a non-JSON object.', 'JSON_OBJECT');
  }

  const output = Object.create(null);
  const entries = Object.entries(value);
  if (entries.length > 2048) {
    throw new McpClientError('MCP JSON object has too many keys.', 'JSON_KEYS');
  }
  for (const [key, entry] of entries) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new McpClientError('MCP JSON object contains a forbidden key.', 'JSON_KEY');
    }
    state.bytes += UTF8.encode(key).byteLength;
    if (state.bytes > state.maxBytes) {
      throw new McpClientError('MCP JSON value exceeds the size limit.', 'JSON_SIZE');
    }
    output[key] = cloneBoundedJson(entry, state, depth + 1);
  }
  return output;
}

function normalizeTool(tool) {
  if (!isPlainObject(tool)) {
    throw new McpClientError('MCP tools/list returned a non-object tool.', 'INVALID_TOOL');
  }
  if (
    typeof tool.name !== 'string' ||
    tool.name.length === 0 ||
    tool.name.length > MAX_TOOL_NAME ||
    /[\r\n\0]/.test(tool.name)
  ) {
    throw new McpClientError('MCP tool has an invalid name.', 'INVALID_TOOL_NAME');
  }
  if (!isPlainObject(tool.inputSchema)) {
    throw new McpClientError('MCP tool inputSchema must be an object.', 'INVALID_TOOL_SCHEMA');
  }

  const schema = cloneBoundedJson(tool.inputSchema, { bytes: 0, maxBytes: MAX_SCHEMA_BYTES });
  return Object.freeze({
    name: tool.name,
    description: typeof tool.description === 'string'
      ? tool.description.slice(0, MAX_DESCRIPTION)
      : '',
    inputSchema: schema,
  });
}

function normalizeToolList(result) {
  if (!isPlainObject(result) || !Array.isArray(result.tools)) {
    throw new McpClientError('MCP tools/list returned an invalid result.', 'INVALID_TOOL_LIST');
  }
  if (result.tools.length > MAX_TOOLS) {
    throw new McpClientError('MCP server exposed too many tools.', 'TOO_MANY_TOOLS');
  }

  const names = new Set();
  const tools = result.tools.map((tool) => {
    const normalized = normalizeTool(tool);
    if (names.has(normalized.name)) {
      throw new McpClientError('MCP tools/list contains duplicate tool names.', 'DUPLICATE_TOOL');
    }
    names.add(normalized.name);
    return normalized;
  });

  return Object.freeze({
    tools: Object.freeze(tools),
    nextCursor: typeof result.nextCursor === 'string' && result.nextCursor.length <= 4096
      ? result.nextCursor
      : null,
  });
}

function appendBoundedText(parts, text, state) {
  const bytes = UTF8.encode(text).byteLength;
  if (state.bytes + bytes > MAX_RESULT_TEXT_BYTES) {
    throw new McpClientError('MCP tool result text exceeds the size limit.', 'TOOL_RESULT_TOO_LARGE');
  }
  state.bytes += bytes;
  parts.push(text);
}

export function toolResultToText(result) {
  if (!isPlainObject(result)) {
    throw new McpClientError('MCP tools/call returned an invalid result.', 'INVALID_TOOL_RESULT');
  }

  const parts = [];
  const state = { bytes: 0 };

  if (Array.isArray(result.content)) {
    if (result.content.length > 1024) {
      throw new McpClientError('MCP tool result contains too many content items.', 'TOO_MANY_CONTENT_ITEMS');
    }
    for (const item of result.content) {
      if (!isPlainObject(item)) {
        throw new McpClientError('MCP tool result contains an invalid content item.', 'INVALID_CONTENT_ITEM');
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        appendBoundedText(parts, item.text, state);
      }
    }
  }

  if (parts.length === 0 && 'structuredContent' in result) {
    const safe = cloneBoundedJson(result.structuredContent, {
      bytes: 0,
      maxBytes: MAX_RESULT_TEXT_BYTES,
    });
    appendBoundedText(parts, JSON.stringify(safe), state);
  }

  if (parts.length === 0) {
    throw new McpClientError(
      'MCP tool result has no text or structured content supported by the MVP.',
      'UNSUPPORTED_TOOL_RESULT',
    );
  }

  return parts.join('\n');
}

export class McpClient {
  #transport;
  #connected = false;

  constructor(options = {}) {
    this.#transport = options.transport ?? new StreamableHttpTransport(options);
    if (
      !this.#transport ||
      typeof this.#transport.connect !== 'function' ||
      typeof this.#transport.request !== 'function'
    ) {
      throw new McpClientError('MCP client requires a valid transport.', 'INVALID_TRANSPORT');
    }
  }

  get revision() {
    return this.#transport.revision;
  }

  get endpoint() {
    return this.#transport.endpoint;
  }

  async connect() {
    try {
      const connection = await this.#transport.connect();
      this.#connected = true;
      return connection;
    } catch (error) {
      this.#connected = false;
      throw error;
    }
  }

  async listTools({ cursor = null } = {}) {
    this.#requireConnected();
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 4096)) {
      throw new McpClientError('Invalid tools/list cursor.', 'INVALID_CURSOR');
    }

    const params = cursor === null ? {} : { cursor };
    const result = await this.#transport.request('tools/list', params);
    return normalizeToolList(result);
  }

  async callToolRaw(name, args = {}) {
    this.#requireConnected();
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME || /[\r\n\0]/.test(name)) {
      throw new McpClientError('Invalid MCP tool name.', 'INVALID_TOOL_NAME');
    }
    if (!isPlainObject(args)) {
      throw new McpClientError('MCP tool arguments must be an object.', 'INVALID_TOOL_ARGUMENTS');
    }

    const safeArguments = cloneBoundedJson(args, { bytes: 0, maxBytes: 256 * 1024 });
    const result = await this.#transport.request('tools/call', {
      name,
      arguments: safeArguments,
    });

    return Object.freeze({
      raw: result,
      text: toolResultToText(result),
      isError: result?.isError === true,
    });
  }

  #requireConnected() {
    if (!this.#connected) {
      throw new McpClientError('MCP client is not connected.', 'NOT_CONNECTED');
    }
  }
}

export {
  MCP_REVISION_CURRENT,
  MCP_REVISION_LEGACY,
  McpTransportError,
};
