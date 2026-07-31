'use strict';
// In-memory webhook store implementing the same interface as the Mongoose store.
// Used by the runnable integration path in tests (no real DB required).
const { ORDER_EVENTS, DEFAULTS } = require('../models/Webhook');

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function createInMemoryStore(seed) {
  const docs = new Map();
  let counter = 0;

  function normalize(data) {
    const out = Object.assign({}, data || {});
    if (out.id == null && out._id == null) out._id = String(++counter);
    if (out._id != null && out.id == null) out.id = out._id;
    if (out.active == null) out.active = DEFAULTS.active;
    out.retryConfig = Object.assign({}, DEFAULTS.retryConfig, out.retryConfig || {});
    out.events = Array.isArray(out.events) ? out.events.filter((e) => ORDER_EVENTS.includes(e)) : [];
    const now = new Date().toISOString();
    if (!out.createdAt) out.createdAt = now;
    out.updatedAt = now;
    return out;
  }

  if (Array.isArray(seed)) seed.forEach((d) => { const n = normalize(d); docs.set(String(n._id), n); });

  return {
    async create(data) { const n = normalize(data); docs.set(String(n._id), n); return clone(n); },
    async list() { return Array.from(docs.values()).map(clone); },
    async update(id, data) { const k = String(id); if (!docs.has(k)) return null; const cur = docs.get(k); const merged = Object.assign({}, cur, data || {}); merged.updatedAt = new Date().toISOString(); if (data && Array.isArray(data.events)) merged.events = data.events.filter((e) => ORDER_EVENTS.includes(e)); if (data && data.retryConfig) merged.retryConfig = Object.assign({}, cur.retryConfig || {}, data.retryConfig); docs.set(k, merged); return clone(merged); },
    async remove(id) { const k = String(id); if (!docs.has(k)) return null; const d = docs.get(k); docs.delete(k); return clone(d); },
    async findById(id) { const k = String(id); return docs.has(k) ? clone(docs.get(k)) : null; },
    async findByEvent(event) { return Array.from(docs.values()).filter((d) => d.active !== false && Array.isArray(d.events) && d.events.includes(event)).map(clone); },
    _size() { return docs.size; },
  };
}

module.exports = { createInMemoryStore };
