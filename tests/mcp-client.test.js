import test from 'node:test';
import assert from 'node:assert/strict';
import {
  McpClient,
  McpClientError,
  toolResultToText,
} from '../extension/mcp/client.js';

function fakeTransport(responses) {
  const calls = [];
  return {
    revision: '2026-07-28',
    endpoint: 'https://mcp.example.test/mcp',
    calls,
    async connect() {
      return { revision: this.revision, sessionId: null };
    },
    async request(method, params) {
      calls.push({ method, params });
      if (!(method in responses)) {
        throw new Error(`Unexpected method: ${method}`);
      }
      const value = responses[method];
      return typeof value === 'function' ? value(params) : value;
    },
  };
}

test('MCP client requires connect before operational requests', async () => {
  const client = new McpClient({ transport: fakeTransport({ 'tools/list': { tools: [] } }) });
  await assert.rejects(
    client.listTools(),
    (error) => error instanceof McpClientError && error.code === 'NOT_CONNECTED',
  );
});

test('normalizes a bounded tools/list catalog', async () => {
  const transport = fakeTransport({
    'tools/list': {
      tools: [
        {
          name: 'read',
          description: 'Read one approved file.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
      nextCursor: 'next-page',
    },
  });
  const client = new McpClient({ transport });
  await client.connect();

  const catalog = await client.listTools();
  assert.equal(catalog.tools.length, 1);
  assert.equal(catalog.tools[0].name, 'read');
  assert.equal(Object.getPrototypeOf(catalog.tools[0].inputSchema), null);
  assert.equal(catalog.nextCursor, 'next-page');
});

test('rejects duplicate tool names from an untrusted MCP server', async () => {
  const tool = { name: 'read', inputSchema: { type: 'object' } };
  const client = new McpClient({
    transport: fakeTransport({ 'tools/list': { tools: [tool, tool] } }),
  });
  await client.connect();

  await assert.rejects(
    client.listTools(),
    (error) => error instanceof McpClientError && error.code === 'DUPLICATE_TOOL',
  );
});

test('callToolRaw clones bounded arguments and converts only supported result content to text', async () => {
  const transport = fakeTransport({
    'tools/call': (params) => ({
      content: [
        { type: 'text', text: `read:${params.arguments.path}` },
        { type: 'image', data: 'ignored-fake-image-data', mimeType: 'image/png' },
      ],
      isError: false,
    }),
  });
  const client = new McpClient({ transport });
  await client.connect();

  const result = await client.callToolRaw('read', { path: 'README.md' });
  assert.equal(result.text, 'read:README.md');
  assert.equal(result.isError, false);
  assert.equal(transport.calls[0].method, 'tools/call');
  assert.equal(Object.getPrototypeOf(transport.calls[0].params.arguments), null);
});

test('toolResultToText uses bounded structuredContent when text content is absent', () => {
  assert.equal(
    toolResultToText({ structuredContent: { ok: true, count: 2 } }),
    '{"ok":true,"count":2}',
  );
});

test('toolResultToText rejects unsupported binary-only results', () => {
  assert.throws(
    () => toolResultToText({ content: [{ type: 'image', data: 'fake', mimeType: 'image/png' }] }),
    (error) => error instanceof McpClientError && error.code === 'UNSUPPORTED_TOOL_RESULT',
  );
});

test('MCP arguments reject prototype-pollution keys', async () => {
  const client = new McpClient({
    transport: fakeTransport({
      'tools/call': { content: [{ type: 'text', text: 'never' }] },
    }),
  });
  await client.connect();

  const args = JSON.parse('{"path":"README.md","constructor":{"prototype":{"polluted":true}}}');
  await assert.rejects(
    client.callToolRaw('read', args),
    (error) => error instanceof McpClientError && error.code === 'JSON_KEY',
  );
});
