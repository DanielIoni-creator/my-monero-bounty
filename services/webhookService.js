const crypto = require("node:crypto");
const Webhook = require("../models/Webhook");

/**
 * Calculates exponential backoff delay in milliseconds.
 * @param {number} attempt - Attempt count (1-indexed)
 * @param {number} initialDelay - Initial delay in ms
 * @param {number} maxDelay - Maximum delay cap in ms
 * @returns {number} Delay in milliseconds
 */
function calculateBackoffDelay(attempt, initialDelay = 1000, maxDelay = 60000) {
  if (attempt <= 1) return initialDelay;
  const expDelay = initialDelay * Math.pow(2, attempt - 1);
  return Math.min(expDelay, maxDelay);
}

/**
 * Generates an HMAC SHA-256 hex signature string for a webhook payload.
 * @param {object|string} payload - Webhook payload object or string
 * @param {string} secret - Secret key for HMAC signature
 * @returns {string} 64-character lowercase hex signature string
 */
function generateSignature(payload, secret) {
  if (!secret) {
    throw new Error("HMAC secret key is required");
  }
  const payloadString =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  return crypto
    .createHmac("sha256", secret)
    .update(payloadString, "utf8")
    .digest("hex");
}

/**
 * Pause execution helper.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends HTTP POST request to a webhook target URL.
 * @param {string} url
 * @param {object} headers
 * @param {string} body
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
async function executeHttpRequest(url, headers, body, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    let responseBody = "";
    try {
      responseBody = await response.text();
    } catch (_) {}

    return {
      ok: response.ok,
      statusCode: response.status,
      statusText: response.statusText,
      body: responseBody,
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Delivers an event payload to a single Webhook target with retry logic.
 * @param {object} webhook - Webhook document
 * @param {string} event - Event name
 * @param {object} payload - Event payload
 * @returns {Promise<object>} Delivery result summary
 */
async function deliverToWebhook(webhook, event, payload) {
  const jsonBody =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = generateSignature(jsonBody, webhook.secret);

  const headers = {
    "Content-Type": "application/json",
    "X-Webhook-Event": event,
    "X-Webhook-Signature": signature,
    "User-Agent": "MyZubsterGateway-Webhook/1.0",
  };

  const maxAttempts = webhook.retryConfig?.maxAttempts ?? 5;
  const initialDelay = webhook.retryConfig?.initialDelay ?? 1000;
  const maxDelay = webhook.retryConfig?.maxDelay ?? 60000;

  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const res = await executeHttpRequest(webhook.url, headers, jsonBody);
      if (res.ok) {
        return {
          webhookId: webhook._id,
          url: webhook.url,
          success: true,
          attempts: attempt,
          statusCode: res.statusCode,
        };
      }
      lastError = new Error(
        `HTTP ${res.statusCode}: ${res.statusText || "Delivery failure"}`,
      );
    } catch (err) {
      lastError = err;
    }

    if (attempt < maxAttempts) {
      const delay = calculateBackoffDelay(attempt, initialDelay, maxDelay);
      await sleep(delay);
    }
  }

  return {
    webhookId: webhook._id,
    url: webhook.url,
    success: false,
    attempts: attempt,
    error: lastError ? lastError.message : "Webhook delivery failed",
  };
}

/**
 * Dispatches an order event to all matching active webhooks.
 * @param {string} event - Event name
 * @param {object} payload - Event payload
 * @returns {Promise<object>} Dispatch summary
 */
async function dispatchWebhook(event, payload) {
  if (!event) {
    throw new Error("Event name is required for webhook dispatch");
  }

  const activeWebhooks = await Webhook.find({
    active: true,
    events: event,
  });

  if (!activeWebhooks || activeWebhooks.length === 0) {
    return {
      event,
      dispatchedCount: 0,
      results: [],
    };
  }

  const deliveryPromises = activeWebhooks.map((wh) =>
    deliverToWebhook(wh, event, payload),
  );

  const outcomes = await Promise.allSettled(deliveryPromises);
  const results = outcomes.map((o) =>
    o.status === "fulfilled"
      ? o.value
      : { success: false, error: o.reason?.message },
  );

  return {
    event,
    dispatchedCount: activeWebhooks.length,
    results,
  };
}

module.exports = {
  generateSignature,
  calculateBackoffDelay,
  deliverToWebhook,
  dispatchWebhook,
  deliverWebhooks: dispatchWebhook,
};
