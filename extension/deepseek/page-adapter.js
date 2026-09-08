(() => {
  'use strict';

  const SOURCE = 'webmcp-bridge:deepseek-page';
  const VERSION = 1;
  const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
  const COMPLETION_PATH = '/api/v0/chat/completion';
  const MAX_SSE_BUFFER = 1024 * 1024;
  const MAX_STRING = 64 * 1024;
  const MAX_ARRAY = 128;
  const MAX_OBJECT_KEYS = 128;
  const MAX_JSON_DEPTH = 8;

  if (location.origin !== DEEPSEEK_ORIGIN || typeof window.fetch !== 'function') {
    return;
  }

  const originalFetch = window.fetch;

  function post(kind, payload = null) {
    window.postMessage({
      source: SOURCE,
      version: VERSION,
      kind,
      payload,
    }, DEEPSEEK_ORIGIN);
  }

  function isCompletionRequest(input) {
    try {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, location.href);
      return url.origin === DEEPSEEK_ORIGIN && url.pathname === COMPLETION_PATH;
    } catch {
      return false;
    }
  }

  async function readRequestBody(input, init) {
    if (typeof init?.body === 'string') {
      return init.body;
    }

    if (input instanceof Request && !input.bodyUsed) {
      try {
        return await input.clone().text();
      } catch {
        return null;
      }
    }

    return null;
  }

  async function extractRequestMetadata(input, init) {
    const body = await readRequestBody(input, init);
    if (typeof body !== 'string' || body.length > MAX_STRING) {
      return null;
    }

    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }

      return {
        chatSessionId: typeof parsed.chat_session_id === 'string'
          ? parsed.chat_session_id.slice(0, 256)
          : null,
        parentMessageId: typeof parsed.parent_message_id === 'string'
          ? parsed.parent_message_id.slice(0, 256)
          : null,
        thinkingEnabled: parsed.thinking_enabled === true,
        searchEnabled: parsed.search_enabled === true,
      };
    } catch {
      return null;
    }
  }

  function sanitizeJsonValue(value, depth = 0) {
    if (depth > MAX_JSON_DEPTH) {
      return null;
    }

    if (value === null || typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string') {
      return value.slice(0, MAX_STRING);
    }

    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY).map((entry) => sanitizeJsonValue(entry, depth + 1));
    }

    if (typeof value === 'object') {
      const output = Object.create(null);
      for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
          continue;
        }
        output[key] = sanitizeJsonValue(entry, depth + 1);
      }
      return output;
    }

    return null;
  }

  function emitSseEvent(eventBlock) {
    let eventName = null;
    const dataLines = [];

    for (const line of eventBlock.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim().slice(0, 64) || null;
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      post('completion-done');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }

    post('completion-frame', {
      eventName,
      data: sanitizeJsonValue(parsed),
    });
  }

  async function observeResponse(response) {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      post('adapter-error', { code: 'UNEXPECTED_CONTENT_TYPE' });
      return;
    }

    if (!response.body) {
      post('adapter-error', { code: 'MISSING_RESPONSE_BODY' });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER) {
          post('adapter-error', { code: 'SSE_BUFFER_LIMIT' });
          await reader.cancel();
          return;
        }

        let separator;
        while ((separator = buffer.indexOf('\n\n')) !== -1) {
          const eventBlock = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          emitSseEvent(eventBlock);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        emitSseEvent(buffer);
      }

      post('completion-end', { status: response.status, streamed: true });
    } catch {
      post('adapter-error', { code: 'SSE_READ_FAILED' });
    }
  }

  window.fetch = function webMcpObservedFetch(input, init) {
    if (!isCompletionRequest(input)) {
      return Reflect.apply(originalFetch, this, arguments);
    }

    const metadataPromise = extractRequestMetadata(input, init);
    const responsePromise = Reflect.apply(originalFetch, this, arguments);

    return responsePromise.then((response) => {
      Promise.resolve(metadataPromise)
        .then((metadata) => post('completion-start', metadata))
        .then(() => observeResponse(response.clone()))
        .catch(() => post('adapter-error', { code: 'OBSERVE_FAILED' }));

      return response;
    });
  };
})();
