import { DevSpaceOAuthError } from './errors.js';

/**
 * Read a response body with a hard byte ceiling.
 *
 * response.text() is not bounded on its own: without a Content-Length header a
 * peer can stream forever and we would buffer all of it. Stream and count
 * instead, and abort as soon as the ceiling is crossed.
 */
async function readBeforeDeadline(reader, deadline) {
  if (deadline === null) {
    return reader.read();
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void reader.cancel().catch(() => {});
    throw new DevSpaceOAuthError('Response body timed out.', 'RESPONSE_TIMEOUT');
  }

  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new DevSpaceOAuthError('Response body timed out.', 'RESPONSE_TIMEOUT'));
          void reader.cancel().catch(() => {});
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function readBoundedText(response, limit, timeoutMs = null) {
  if (!response.body) {
    return '';
  }
  const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : null;
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await readBeforeDeadline(reader, deadline);
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        throw new DevSpaceOAuthError('Response body exceeds the size limit.', 'RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readBoundedJson(response, limit, timeoutMs = null) {
  const text = await readBoundedText(response, limit, timeoutMs);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DevSpaceOAuthError('Response body is not valid JSON.', 'INVALID_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DevSpaceOAuthError('Response body must be a JSON object.', 'INVALID_JSON');
  }
  return parsed;
}

/**
 * Fetch with a timeout. Every OAuth round trip is bounded: a peer that never
 * answers must not hold the adapter open indefinitely.
 */
export async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new DevSpaceOAuthError('Request timed out.', 'REQUEST_TIMEOUT', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
