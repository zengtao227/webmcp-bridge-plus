import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolCallParseError,
  buildToolCallInstruction,
  parseToolCalls,
  stripToolCallBlocks,
} from '../extension/tool-loop/tool-call-format.js';

test('parses one strict WebMCP tool-call block', () => {
  const [call] = parseToolCalls(
    'Checking the repository.\n<webmcp_tool_call>{"id":"call_1","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>',
  );

  assert.equal(call.id, 'call_1');
  assert.equal(call.name, 'read');
  assert.equal(call.arguments.path, 'README.md');
  assert.equal(Object.getPrototypeOf(call.arguments), null);
});

test('parses multiple calls and requires unique ids', () => {
  const response = [
    '<webmcp_tool_call>{"id":"a","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>',
    '<webmcp_tool_call>{"id":"b","name":"git.status","arguments":{}}</webmcp_tool_call>',
  ].join('\n');

  assert.equal(parseToolCalls(response).length, 2);
  assert.throws(
    () => parseToolCalls(response.replace('"id":"b"', '"id":"a"')),
    (error) => error instanceof ToolCallParseError && error.code === 'DUPLICATE_ID',
  );
});

test('fails closed for malformed or unclosed tool markers', () => {
  assert.throws(
    () => parseToolCalls('<webmcp_tool_call>{not-json}</webmcp_tool_call>'),
    (error) => error instanceof ToolCallParseError && error.code === 'INVALID_JSON',
  );
  assert.throws(
    () => parseToolCalls('<webmcp_tool_call>{"id":"a","name":"read","arguments":{}}'),
    (error) => error instanceof ToolCallParseError && error.code === 'UNCLOSED_MARKER',
  );
});

test('rejects prototype-pollution keys in tool arguments', () => {
  const text = '<webmcp_tool_call>{"id":"a","name":"read","arguments":{"nested":{"constructor":{"prototype":{"polluted":true}}}}}</webmcp_tool_call>';
  assert.throws(
    () => parseToolCalls(text),
    (error) => error instanceof ToolCallParseError && error.code === 'ARGUMENT_KEY',
  );
});

test('rejects unsupported payload fields instead of silently accepting them', () => {
  const text = '<webmcp_tool_call>{"id":"a","name":"read","arguments":{},"url":"https://evil.example"}</webmcp_tool_call>';
  assert.throws(
    () => parseToolCalls(text),
    (error) => error instanceof ToolCallParseError && error.code === 'UNSUPPORTED_FIELD',
  );
});

test('strips tool blocks without altering surrounding answer text', () => {
  const text = 'Before\n<webmcp_tool_call>{"id":"a","name":"read","arguments":{}}</webmcp_tool_call>\nAfter';
  assert.equal(stripToolCallBlocks(text), 'Before\n\nAfter');
});

test('builds a bounded deterministic tool instruction', () => {
  const instruction = buildToolCallInstruction([
    {
      name: 'read',
      description: 'Read an approved file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ]);

  assert.match(instruction, /<webmcp_tool_call>/);
  assert.match(instruction, /"name":"read"/);
  assert.match(instruction, /Never invent tool names/);
});
