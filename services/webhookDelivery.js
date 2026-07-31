'use strict';
// Webhook payload delivery: HMAC-SHA256 signing + exponential backoff retry.
const crypto = require('crypto');

function signPayload(secret, bodyString) {
  return crypto.createHmac('sha256', String(secret || '')).update(String(bodyString)).digest('hex');
}

// Full-jitter exponential backoff capped at maxDelay. attempt is 0-based
// (delay applied before retry attempt N+1).
function computeBackoffMs(attempt, initialDelay, maxDelay, rng) {
  const init = initialDelay > 0 ? initialDelay : 1000;
  const cap = maxDelay > 0 ? maxDelay : 60000;
  const base = Math.min(init * Math.pow(2, attempt), cap);
  const r = typeof rng === 'function' ? rng() : Math.random();
  return Math.floor(r * (base + 1));
}

function buildPayload(webhook, event) {
  return {
    id: 'wh_' + String(webhook._id || webhook.id || 'unknown'),
    event: event.type,
    deliveredAt: new Date().toISOString(),
    data: (event && event.data) == null ? {} : event.data,
  };
}

async function deliverOnce(webhook, event, opts) {
  const fetchImpl = (opts && opts.fetchImpl) || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new Error('No fetch implementation available for webhook delivery');
  const payload = JSON.stringify(buildPayload(webhook, event));
  const signature = signPayload(webhook.secret, payload);
  const res = await fetchImpl(webhook.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MyZubster-Signature': 'sha256=' + signature,
      'X-MyZubster-Event': String(event.type),
    },
    body: payload,
  });
  const ok = res.ok === undefined ? (res.status >= 200 && res.status < 300) : !!res.ok;
  return { ok, status: res.status, signature, payload };
}

async function deliverWithRetry(webhook, event, opts) {
  const sleepImpl = (opts && opts.sleepImpl) || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rng = opts && opts.rng;
  const log = [];
  const rc = (webhook && webhook.retryConfig) || {};
  const maxAttempts = rc.maxAttempts > 0 ? rc.maxAttempts : 5;
  const initialDelay = rc.initialDelay > 0 ? rc.initialDelay : 1000;
  const maxDelay = rc.maxDelay > 0 ? rc.maxDelay : 60000;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const ms = computeBackoffMs(attempt - 1, initialDelay, maxDelay, rng);
      log.push({ type: 'wait', attempt, delayMs: ms });
      await sleepImpl(ms);
    }
    try {
      const r = await deliverOnce(webhook, event, opts);
      log.push({ type: 'deliver', attempt, status: r.status, ok: r.ok });
      if (r.ok) return { delivered: true, attempts: attempt + 1, signature: r.signature, log };
      lastError = 'HTTP ' + r.status;
    } catch (e) {
      lastError = String((e && e.message) || e);
      log.push({ type: 'deliver', attempt, error: lastError });
    }
  }
  return { delivered: false, attempts: maxAttempts, lastError: String(lastError || ''), log };
}

module.exports = { signPayload, computeBackoffMs, buildPayload, deliverOnce, deliverWithRetry };
