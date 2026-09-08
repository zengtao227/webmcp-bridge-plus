(() => {
  'use strict';

  const PAGE_SOURCE = 'webmcp-bridge:deepseek-page';
  const MESSAGE_TYPE = 'webmcp.deepseek.event';
  const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
  const ACCEPTED_KINDS = new Set([
    'completion-start',
    'completion-frame',
    'completion-done',
    'completion-end',
    'adapter-error',
  ]);

  if (location.origin !== DEEPSEEK_ORIGIN) {
    return;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== DEEPSEEK_ORIGIN) {
      return;
    }

    const data = event.data;
    if (
      !data ||
      typeof data !== 'object' ||
      data.source !== PAGE_SOURCE ||
      data.version !== 1 ||
      !ACCEPTED_KINDS.has(data.kind)
    ) {
      return;
    }

    chrome.runtime.sendMessage({
      type: MESSAGE_TYPE,
      version: 1,
      event: {
        kind: data.kind,
        payload: data.payload ?? null,
      },
    }).catch(() => {
      // The page adapter must never fall back to logging message payloads.
    });
  });
})();
