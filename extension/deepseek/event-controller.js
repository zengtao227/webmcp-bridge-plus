import { DeepSeekStreamAccumulator, DeepSeekStreamError } from './stream-accumulator.js';
import { ToolCallParseError, parseToolCalls } from '../tool-loop/tool-call-format.js';

const ACCEPTED_KINDS = new Set([
  'completion-start',
  'completion-frame',
  'completion-done',
  'completion-end',
  'adapter-error',
]);

export class DeepSeekEventController {
  #streams = new Map();

  handle(tabId, event) {
    if (!Number.isInteger(tabId) || tabId < 0) {
      return Object.freeze({ accepted: false, code: 'INVALID_TAB' });
    }
    if (!event || typeof event !== 'object' || !ACCEPTED_KINDS.has(event.kind)) {
      return Object.freeze({ accepted: false, code: 'INVALID_EVENT' });
    }

    if (event.kind === 'completion-start') {
      const stream = new DeepSeekStreamAccumulator();
      try {
        stream.start(event.payload ?? null);
      } catch (error) {
        return Object.freeze({
          accepted: false,
          code: error instanceof DeepSeekStreamError ? error.code : 'START_FAILED',
        });
      }
      this.#streams.set(tabId, stream);
      return Object.freeze({ accepted: true, kind: 'started' });
    }

    const stream = this.#streams.get(tabId);
    if (!stream) {
      return Object.freeze({ accepted: false, code: 'NO_ACTIVE_STREAM' });
    }

    if (event.kind === 'completion-frame') {
      try {
        stream.push(event.payload);
        return Object.freeze({ accepted: true, kind: 'frame' });
      } catch (error) {
        this.#streams.delete(tabId);
        return Object.freeze({
          accepted: false,
          code: error instanceof DeepSeekStreamError ? error.code : 'FRAME_FAILED',
        });
      }
    }

    if (event.kind === 'completion-done') {
      return Object.freeze({ accepted: true, kind: 'done-marker' });
    }

    if (event.kind === 'adapter-error') {
      stream.abort();
      this.#streams.delete(tabId);
      return Object.freeze({ accepted: false, code: 'PAGE_ADAPTER_ERROR' });
    }

    try {
      const completion = stream.finish();
      this.#streams.delete(tabId);

      if (completion.truncated) {
        return Object.freeze({
          accepted: false,
          code: 'RESPONSE_TOO_LARGE',
          metadata: completion.metadata,
        });
      }

      const toolCalls = parseToolCalls(completion.text);
      return Object.freeze({
        accepted: true,
        kind: 'completed',
        metadata: completion.metadata,
        responseMessageId: completion.responseMessageId,
        toolCalls,
        hasToolCalls: toolCalls.length > 0,
      });
    } catch (error) {
      this.#streams.delete(tabId);
      if (error instanceof ToolCallParseError || error instanceof DeepSeekStreamError) {
        return Object.freeze({ accepted: false, code: error.code });
      }
      return Object.freeze({ accepted: false, code: 'COMPLETION_FAILED' });
    }
  }

  abort(tabId) {
    const stream = this.#streams.get(tabId);
    if (stream) {
      stream.abort();
      this.#streams.delete(tabId);
    }
  }
}
