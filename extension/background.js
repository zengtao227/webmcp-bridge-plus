import { DeepSeekEventController } from './deepseek/event-controller.js';

const MESSAGE_TYPE = 'webmcp.deepseek.event';
const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
const controller = new DeepSeekEventController();

function isDeepSeekSender(sender) {
  if (!sender?.tab || !Number.isInteger(sender.tab.id) || typeof sender.url !== 'string') {
    return false;
  }

  try {
    return new URL(sender.url).origin === DEEPSEEK_ORIGIN;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (
    !message ||
    typeof message !== 'object' ||
    message.type !== MESSAGE_TYPE ||
    message.version !== 1 ||
    !isDeepSeekSender(sender)
  ) {
    return undefined;
  }

  return Promise.resolve(controller.handle(sender.tab.id, message.event));
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  controller.abort(tabId);
});
