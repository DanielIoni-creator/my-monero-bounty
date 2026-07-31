'use strict';

/**
 * Per-webhook delivery log.
 *
 * Issue #21 requires that operators can see what was delivered to which
 * webhook and what happened (success, status codes, retry count, last
 * error) so they can debug downstream integrations. The log records one
 * entry per `dispatchOrderEvent` run (one fan-out), with one
 * per-webhook sub-record describing the attempt that was actually made.
 *
 * The default in-memory implementation is intended for tests and the
 * single-process deployment. `attachDeliveryLog` wires the recorder into
 * the dispatcher by replacing the optional `logDelivery` callback. The
 * store deliberately keeps the last N entries per webhook (ring buffer)
 * so memory growth is bounded.
 *
 * Persistent implementations can mirror the same `record` + `list` shape.
 */

const crypto = require('crypto');

const DEFAULT_MAX_ENTRIES_PER_WEBHOOK = 200;

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

class InMemoryDeliveryLog {
  constructor({ maxEntriesPerWebhook = DEFAULT_MAX_ENTRIES_PER_WEBHOOK } = {}) {
    this._max = maxEntriesPerWebhook;
    this._groups = new Map(); // webhookId -> DeliveryEntry[]
    this._order = []; // ordered list of DeliveryEntry ids (oldest first)
  }

  async record(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('record: entry must be an object');
    }
    if (!entry.webhookId) {
      throw new TypeError('record: entry.webhookId is required');
    }
    if (!entry.eventType) {
      throw new TypeError('record: entry.eventType is required');
    }
    const id = entry.deliveryId || newId();
    const stored = {
      deliveryId: id,
      webhookId: String(entry.webhookId),
      eventType: String(entry.eventType),
      ok: Boolean(entry.ok),
      attempts: Number.isInteger(entry.attempts) ? entry.attempts : 0,
      lastStatus: Number.isInteger(entry.lastStatus) ? entry.lastStatus : 0,
      lastError: entry.lastError || null,
      url: entry.url || null,
      name: entry.name || null,
      deliveryPayloadPreview: entry.deliveryPayloadPreview || null,
      createdAt: entry.createdAt || new Date(),
    };
    const list = this._groups.get(stored.webhookId) || [];
    list.push(stored);
    while (list.length > this._max) list.shift();
    this._groups.set(stored.webhookId, list);
    this._order.push(stored.deliveryId);
    if (this._order.length > 5000) this._order.shift(); // bound the global order
    return stored;
  }

  async listForWebhook(webhookId, { limit = 50, after } = {}) {
    if (typeof webhookId !== 'string' || !webhookId) {
      throw new TypeError('listForWebhook: webhookId must be a non-empty string');
    }
    const list = this._groups.get(webhookId) || [];
    let filtered = list;
    if (typeof after === 'string') {
      const idx = list.findIndex((e) => e.deliveryId === after);
      filtered = idx >= 0 ? list.slice(idx + 1) : list.slice();
    } else {
      filtered = list.slice();
    }
    // newest first
    filtered.reverse();
    const out = filtered.slice(0, Math.max(0, Number(limit) || 50));
    return out;
  }

  async listAll({ limit = 100 } = {}) {
    const all = [];
    for (const list of this._groups.values()) {
      for (const entry of list) all.push(entry);
    }
    all.sort((a, b) => (b.createdAt && a.createdAt ? b.createdAt - a.createdAt : 0));
    return all.slice(0, Math.max(0, Number(limit) || 100));
  }

  size() {
    let n = 0;
    for (const list of this._groups.values()) n += list.length;
    return n;
  }
}

function attachDeliveryLog(store, log, { deliverySummary, cap = 2048 } = {}) {
  if (!store || typeof store.findActiveForEvent !== 'function') {
    throw new TypeError('attachDeliveryLog: store with findActiveForEvent is required');
  }
  if (!log || typeof log.record !== 'function') {
    throw new TypeError('attachDeliveryLog: log with .record is required');
  }
  const preview = (payload) => {
    try {
      const s = JSON.stringify(payload);
      if (s.length <= cap) return s;
      return s.slice(0, cap) + `…(+${s.length - cap} bytes)`;
    } catch (_e) {
      return null;
    }
  };
  return {
    store,
    log,
    /**
     * dispatchOrderEvent(opts) — same signature as the unwrapped version,
     * but every per-webhook result is mirrored into the delivery log.
     */
    async dispatchOrderEvent(eventType, payload, opts = {}) {
      const webhooks = await store.findActiveForEvent(eventType);
      if (!webhooks || webhooks.length === 0) {
        return { ok: true, dispatched: 0, eventType, results: [] };
      }
      const { dispatchOrderEvent: rawDispatch } = require('../webhooks');
      const summary = await rawDispatch(store, eventType, payload, opts);
      const { results } = summary;
      const persistedPayloadPreview = deliverySummary
        ? null
        : preview(payload);
      for (const r of results || []) {
        try {
          await log.record({
            webhookId: r.webhookId,
            eventType,
            ok: r.ok,
            attempts: r.attempts,
            lastStatus: r.lastStatus,
            lastError: r.lastError,
            url: r.url,
            name: r.name,
            deliveryPayloadPreview: persistedPayloadPreview,
          });
        } catch (_e) {
          // logging failure must not break delivery
        }
      }
      return summary;
    },
  };
}

module.exports = {
  InMemoryDeliveryLog,
  attachDeliveryLog,
  DEFAULT_MAX_ENTRIES_PER_WEBHOOK,
};
