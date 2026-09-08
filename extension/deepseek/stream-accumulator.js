const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_BATCH_ITEMS = 256;
const CONTENT_PATH = /^response(?:\/fragments\/-?\d+)?\/content$/;
const UTF8 = new TextEncoder();

export class DeepSeekStreamError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DeepSeekStreamError';
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

function normalizeMetadata(metadata) {
  if (metadata === null) {
    return Object.freeze({
      chatSessionId: null,
      parentMessageId: null,
      thinkingEnabled: false,
      searchEnabled: false,
    });
  }

  if (!isPlainObject(metadata)) {
    throw new DeepSeekStreamError('Completion metadata must be an object or null.', 'INVALID_METADATA');
  }

  return Object.freeze({
    chatSessionId: typeof metadata.chatSessionId === 'string'
      ? metadata.chatSessionId.slice(0, 256)
      : null,
    parentMessageId: typeof metadata.parentMessageId === 'string'
      ? metadata.parentMessageId.slice(0, 256)
      : null,
    thinkingEnabled: metadata.thinkingEnabled === true,
    searchEnabled: metadata.searchEnabled === true,
  });
}

export class DeepSeekStreamAccumulator {
  #active = false;
  #metadata = null;
  #lastPath = null;
  #lastOperation = null;
  #contentByPath = new Map();
  #contentBytes = 0;
  #truncated = false;
  #responseMessageId = null;

  start(metadata) {
    this.#active = true;
    this.#metadata = normalizeMetadata(metadata);
    this.#lastPath = null;
    this.#lastOperation = null;
    this.#contentByPath = new Map();
    this.#contentBytes = 0;
    this.#truncated = false;
    this.#responseMessageId = null;
  }

  push(envelope) {
    if (!this.#active) {
      throw new DeepSeekStreamError('Completion frame received before completion start.', 'FRAME_WITHOUT_START');
    }
    if (!isPlainObject(envelope) || !isPlainObject(envelope.data)) {
      throw new DeepSeekStreamError('Invalid DeepSeek SSE envelope.', 'INVALID_FRAME');
    }

    const eventName = typeof envelope.eventName === 'string'
      ? envelope.eventName.slice(0, 64).toLowerCase()
      : null;

    if (
      (eventName === 'hint' || eventName === 'toast') &&
      (envelope.data.type === 'error' || envelope.data.finish_reason)
    ) {
      throw new DeepSeekStreamError('DeepSeek returned an upstream error event.', 'UPSTREAM_ERROR_EVENT');
    }

    this.#captureResponseMessageId(envelope.data);
    this.#applyFrame(envelope.data, 0);
  }

  #captureResponseMessageId(frame) {
    if (this.#responseMessageId !== null) {
      return;
    }

    const candidates = [
      frame.response_message_id,
      frame.message_id,
      frame.v?.response_message_id,
      frame.v?.message_id,
      frame.v?.response?.message_id,
    ];

    for (const candidate of candidates) {
      if (Number.isSafeInteger(candidate) && candidate >= 0) {
        this.#responseMessageId = candidate;
        return;
      }
      if (typeof candidate === 'string' && /^\d{1,20}$/.test(candidate)) {
        const numeric = Number(candidate);
        if (Number.isSafeInteger(numeric)) {
          this.#responseMessageId = numeric;
          return;
        }
      }
    }
  }

  #applyFrame(frame, depth) {
    if (depth > 8 || !isPlainObject(frame)) {
      throw new DeepSeekStreamError('Invalid DeepSeek SSE patch frame.', 'INVALID_FRAME');
    }

    const explicitPath = typeof frame.p === 'string' && frame.p.length <= 512
      ? frame.p
      : null;
    const explicitOperation = typeof frame.o === 'string' && frame.o.length <= 32
      ? frame.o.toUpperCase()
      : null;

    const path = explicitPath ?? this.#lastPath;
    const operation = explicitOperation ?? this.#lastOperation;

    if (explicitOperation === 'BATCH') {
      if (!Array.isArray(frame.v) || frame.v.length > MAX_BATCH_ITEMS) {
        throw new DeepSeekStreamError('Invalid DeepSeek BATCH frame.', 'INVALID_BATCH');
      }
      for (const entry of frame.v) {
        this.#applyFrame(entry, depth + 1);
      }
      return;
    }

    if (explicitPath !== null) {
      this.#lastPath = explicitPath;
    }
    if (explicitOperation !== null) {
      this.#lastOperation = explicitOperation;
    }

    if (!path || !operation || !CONTENT_PATH.test(path) || typeof frame.v !== 'string') {
      return;
    }

    if (operation !== 'APPEND' && operation !== 'SET') {
      return;
    }

    const previous = this.#contentByPath.get(path) ?? '';
    const next = operation === 'SET' ? frame.v : previous + frame.v;
    const previousBytes = UTF8.encode(previous).byteLength;
    const nextBytes = UTF8.encode(next).byteLength;
    const prospectiveTotal = this.#contentBytes - previousBytes + nextBytes;

    if (prospectiveTotal > MAX_CONTENT_BYTES) {
      this.#truncated = true;
      return;
    }

    this.#contentByPath.set(path, next);
    this.#contentBytes = prospectiveTotal;
  }

  finish() {
    if (!this.#active) {
      throw new DeepSeekStreamError('Completion ended before it started.', 'END_WITHOUT_START');
    }

    const result = Object.freeze({
      metadata: this.#metadata,
      responseMessageId: this.#responseMessageId,
      text: [...this.#contentByPath.values()].join(''),
      truncated: this.#truncated,
    });

    this.#active = false;
    return result;
  }

  abort() {
    this.#active = false;
    this.#metadata = null;
    this.#contentByPath.clear();
    this.#contentBytes = 0;
    this.#truncated = false;
    this.#responseMessageId = null;
  }
}
