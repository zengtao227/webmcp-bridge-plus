import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeepSeekStreamAccumulator,
  DeepSeekStreamError,
} from '../extension/deepseek/stream-accumulator.js';
import { DeepSeekEventController } from '../extension/deepseek/event-controller.js';

test('accumulates DeepSeek APPEND frames with carried path and operation', () => {
  const stream = new DeepSeekStreamAccumulator();
  stream.start({
    chatSessionId: 'fake-session-id',
    parentMessageId: null,
    thinkingEnabled: true,
    searchEnabled: false,
  });

  stream.push({ eventName: null, data: { p: 'response/fragments/-1/content', o: 'APPEND', v: 'Hello' } });
  stream.push({ eventName: null, data: { v: ' world' } });

  const result = stream.finish();
  assert.equal(result.text, 'Hello world');
  assert.equal(result.metadata.chatSessionId, 'fake-session-id');
  assert.equal(result.metadata.thinkingEnabled, true);
  assert.equal(result.truncated, false);
});

test('supports bounded BATCH patches and ignores non-answer paths', () => {
  const stream = new DeepSeekStreamAccumulator();
  stream.start(null);
  stream.push({
    eventName: null,
    data: {
      o: 'BATCH',
      v: [
        { p: 'response/fragments/-1/reasoning_content', o: 'APPEND', v: 'private reasoning' },
        { p: 'response/fragments/-1/content', o: 'APPEND', v: 'Visible' },
        { p: 'response/fragments/-1/content', o: 'APPEND', v: ' answer' },
      ],
    },
  });

  assert.equal(stream.finish().text, 'Visible answer');
});

test('SET replaces content for one response path without corrupting other paths', () => {
  const stream = new DeepSeekStreamAccumulator();
  stream.start(null);
  stream.push({ eventName: null, data: { p: 'response/fragments/-1/content', o: 'SET', v: 'first' } });
  stream.push({ eventName: null, data: { p: 'response/fragments/-2/content', o: 'SET', v: 'second' } });
  stream.push({ eventName: null, data: { p: 'response/fragments/-1/content', o: 'SET', v: 'updated' } });

  assert.equal(stream.finish().text, 'updatedsecond');
});

test('marks oversized assistant content as truncated and does not forward it', () => {
  const stream = new DeepSeekStreamAccumulator();
  stream.start(null);
  stream.push({
    eventName: null,
    data: {
      p: 'response/fragments/-1/content',
      o: 'APPEND',
      v: 'x'.repeat(512 * 1024 + 1),
    },
  });

  const result = stream.finish();
  assert.equal(result.truncated, true);
  assert.equal(result.text, '');
});

test('captures response message lineage from DeepSeek ready data', () => {
  const stream = new DeepSeekStreamAccumulator();
  stream.start(null);
  stream.push({
    eventName: 'ready',
    data: { v: { response: { message_id: 42 } } },
  });
  stream.push({
    eventName: null,
    data: { p: 'response/fragments/-1/content', o: 'APPEND', v: 'ok' },
  });

  const result = stream.finish();
  assert.equal(result.responseMessageId, 42);
});

test('fails closed on DeepSeek hint error events even when HTTP is 200', () => {
  const stream = new DeepSeekStreamAccumulator();
  stream.start(null);
  assert.throws(
    () => stream.push({
      eventName: 'hint',
      data: { type: 'error', finish_reason: 'rate_limit_reached' },
    }),
    (error) => error instanceof DeepSeekStreamError && error.code === 'UPSTREAM_ERROR_EVENT',
  );
});

test('fails closed when a frame arrives without an active completion', () => {
  const stream = new DeepSeekStreamAccumulator();
  assert.throws(
    () => stream.push({ eventName: null, data: { p: 'response/content', o: 'APPEND', v: 'x' } }),
    (error) => error instanceof DeepSeekStreamError && error.code === 'FRAME_WITHOUT_START',
  );
});

test('event controller detects strict tool calls at completion end', () => {
  const controller = new DeepSeekEventController();
  assert.equal(controller.handle(7, { kind: 'completion-start', payload: null }).accepted, true);
  controller.handle(7, {
    kind: 'completion-frame',
    payload: {
      eventName: null,
      data: {
        p: 'response/fragments/-1/content',
        o: 'APPEND',
        v: '<webmcp_tool_call>{"id":"call_1","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>',
      },
    },
  });

  const result = controller.handle(7, { kind: 'completion-end', payload: { status: 200 } });
  assert.equal(result.accepted, true);
  assert.equal(result.hasToolCalls, true);
  assert.equal(result.toolCalls[0].name, 'read');
});

test('event controller rejects malformed tool output and drops the stream', () => {
  const controller = new DeepSeekEventController();
  controller.handle(9, { kind: 'completion-start', payload: null });
  controller.handle(9, {
    kind: 'completion-frame',
    payload: {
      eventName: null,
      data: {
        p: 'response/fragments/-1/content',
        o: 'APPEND',
        v: '<webmcp_tool_call>{broken}</webmcp_tool_call>',
      },
    },
  });

  const result = controller.handle(9, { kind: 'completion-end', payload: null });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'INVALID_JSON');
  assert.equal(controller.handle(9, { kind: 'completion-end', payload: null }).code, 'NO_ACTIVE_STREAM');
});

test('event controller never treats page events as authorization', () => {
  const controller = new DeepSeekEventController();
  assert.deepEqual(controller.handle(3, { kind: 'execute-tool', payload: { name: 'shell' } }), {
    accepted: false,
    code: 'INVALID_EVENT',
  });
});
