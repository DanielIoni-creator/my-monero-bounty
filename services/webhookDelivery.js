'use strict';

/**
 * Webhook delivery service.
 *
 * Responsibilities:
 *   - signPayload(secret, body)  -> HMAC-SHA256 hex signature
 *   - deliverOnce({ url, secret, payload, fetchImpl, timeoutMs, headers })
 *       -> { ok, status, error? }  single attempt, no retry
 *   - deliverWithRetry(opts)
 *       -> { ok, attempts, results, lastError? }
 *       exponential backoff with full jitter, capped at maxDelay
 *   - computeBackoffMs(attempt, initialDelay, maxDelay)
 *       -> delay in milliseconds before attempt #N
 *
 * No external HTTP client is required. A `fetchImpl` is injected so the
 * retry loop stays deterministic in tests; in production `globalThis.fetch`
 * (Node 22) is used.
 *
 * The HMAC signature is sent in the `X-MyZubster-Signature` header as
 * `sha256=<hex>` so the receiver can verify it with the shared `secret`
 * stored on the webhook row.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BACKOFF = 60_000;
const SIGNATURE_HEADER = 'x-myzubster-signature';
const SIGNATURE_PREFIX = 'sha256=';
const DELIVERY_ID_HEADER = 'x-myzubster-delivery-id';
const EVENT_HEADER = 'x-myzubster-event';
const USER_AGENT = 'MyZubsterGateway-Webhooks/1.0';

function createHmac(secret) {
  // Use Node's built-in crypto to avoid pulling another dep. We require
  // lazily so the module is importable in environments where crypto is mocked.
  const { createHmac: nodeCreateHmac } = require('crypto');
  return nodeCreateHmac('sha256', secret);
}

function signPayload(secret, payload) {
  if (typeof secret !== 'string' || !secret) {
    throw new TypeError('signPayload: secret must be a non-empty string');
  }
  const body = serializeForSignature(payload);
  return `${SIGNATURE_PREFIX}${createHmac(secret).update(body).digest('hex')}`;
}

function serializeForSignature(payload) {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    // Use a stable property order so the receiver can recompute the digest
    // without us depending on JS object iteration order.
    return JSON.stringify(payload, stableReplacer);
  }
  return String(payload);
}

function stableReplacer(_key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted = {};
    for (const k of Object.keys(value).sort()) sorted[k] = value[k];
    return sorted;
  }
  return value;
}

function defaultFetchImpl() {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  throw new Error('No fetch implementation available; pass fetchImpl explicitly');
}

function makeAbortSignal(timeoutMs) {
  if (typeof AbortController !== 'function') return undefined;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  // Ensure the timeout does not keep the event loop alive.
  if (typeof t.unref === 'function') t.unref();
  return { signal: controller.signal, cancel: () => clearTimeout(t) };
}

async function deliverOnce({
  url,
  secret,
  payload,
  eventType,
  deliveryId,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extraHeaders,
  now,
} = {}) {
  if (typeof url !== 'string' || !url) {
    return { ok: false, status: 0, error: 'invalid url' };
  }
  if (typeof secret !== 'string' || !secret) {
    return { ok: false, status: 0, error: 'invalid secret' };
  }
  const body = serializeForSignature(payload);
  const signature = signPayload(secret, payload);
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : defaultFetchImpl();

  const headers = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    [SIGNATURE_HEADER]: signature,
  };
  if (eventType) headers[EVENT_HEADER] = eventType;
  if (deliveryId) headers[DELIVERY_ID_HEADER] = deliveryId;
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k.toLowerCase()] = v;
  }

  const abort = makeAbortSignal(timeoutMs);
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: abort && abort.signal,
    });
    const status = Number(response && response.status) || 0;
    const ok = status >= 200 && status < 300;
    return { ok, status };
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || String(err) };
  } finally {
    if (abort && typeof abort.cancel === 'function') abort.cancel();
  }
}

function computeBackoffMs(attempt, initialDelay, maxDelay = DEFAULT_MAX_BACKOFF) {
  if (typeof attempt !== 'number' || attempt < 1) {
    throw new TypeError('computeBackoffMs: attempt must be a positive integer');
  }
  if (typeof initialDelay !== 'number' || initialDelay < 0) {
    throw new TypeError('computeBackoffMs: initialDelay must be >= 0');
  }
  if (typeof maxDelay !== 'number' || maxDelay < 0) {
    throw new TypeError('computeBackoffMs: maxDelay must be >= 0');
  }
  // Exponential: initialDelay * 2^(attempt-1), capped at maxDelay,
  // then full-jitter: random in [0, capped].
  const exp = initialDelay * 2 ** (attempt - 1);
  const capped = Math.min(exp, maxDelay);
  // Use Math.random for jitter. Tests inject a deterministic `rand`
  // through the deliverWithRetry call path if they need determinism.
  return Math.floor(Math.random() * capped);
}

async function deliverWithRetry({
  url,
  secret,
  payload,
  eventType,
  deliveryId,
  retryConfig,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep,
} = {}) {
  const maxAttempts = Math.max(1, (retryConfig && retryConfig.maxAttempts) || 5);
  const initialDelay = Math.max(0, (retryConfig && retryConfig.initialDelay) || 1000);
  const maxDelay = Math.max(0, (retryConfig && retryConfig.maxDelay) || 60_000);
  const doSleep = typeof sleep === 'function' ? sleep : defaultSleep;

  const results = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await deliverOnce({
      url,
      secret,
      payload,
      eventType,
      deliveryId,
      fetchImpl,
      timeoutMs,
    });
    results.push(result);
    if (result.ok) {
      return { ok: true, attempts: attempt, results, lastError: null };
    }
    if (attempt < maxAttempts) {
      const delay = computeBackoffMs(attempt, initialDelay, maxDelay);
      if (delay > 0) await doSleep(delay);
    }
  }
  return {
    ok: false,
    attempts: maxAttempts,
    results,
    lastError: (results[results.length - 1] && results[results.length - 1].error) || 'unknown',
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BACKOFF,
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  DELIVERY_ID_HEADER,
  EVENT_HEADER,
  signPayload,
  serializeForSignature,
  deliverOnce,
  deliverWithRetry,
  computeBackoffMs,
};
