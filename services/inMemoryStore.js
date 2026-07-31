'use strict';

/**
 * Pure in-memory Webhook store.
 *
 * Used by tests and by local development where no Mongo connection is
 * available. It implements the same interface as the Mongoose-backed
 * `webhookStore` so callers can swap them.
 *
 * The store intentionally never persists `secret` to its public `find*`
 * results; callers that need to sign deliveries must request the secret
 * explicitly through `findByIdWithSecret` / `findAllWithSecrets`.
 */

const crypto = require('crypto');

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

class InMemoryWebhookStore {
  constructor({ initial = [] } = {}) {
    this._items = new Map();
    for (const item of initial) {
      const row = sanitizeInbound(item);
      this._items.set(row._id, row);
    }
  }

  async create(input) {
    const id = newId();
    const now = new Date();
    const row = {
      _id: id,
      name: input.name,
      url: input.url,
      secret: input.secret,
      events: Array.isArray(input.events) ? [...input.events] : [],
      active: input.active !== false,
      retryConfig: { ...DEFAULT_RETRY_CONFIG, ...(input.retryConfig || {}) },
      createdAt: now,
      updatedAt: now,
    };
    this._items.set(id, row);
    return publicView(row);
  }

  async findById(id) {
    const row = this._items.get(id);
    return row ? publicView(row) : null;
  }

  async findByIdWithSecret(id) {
    const row = this._items.get(id);
    return row ? { ...row } : null;
  }

  async findAll() {
    return Array.from(this._items.values()).map(publicView);
  }

  async findAllWithSecrets() {
    return Array.from(this._items.values()).map((r) => ({ ...r }));
  }

  async findActiveForEvent(eventType) {
    return Array.from(this._items.values())
      .filter((r) => r.active && Array.isArray(r.events) && r.events.includes(eventType))
      .map((r) => ({ ...r }));
  }

  async update(id, patch) {
    const row = this._items.get(id);
    if (!row) return null;
    if (patch && typeof patch === 'object') {
      if (typeof patch.name === 'string') row.name = patch.name;
      if (typeof patch.url === 'string') row.url = patch.url;
      if (typeof patch.secret === 'string' && patch.secret.length > 0) row.secret = patch.secret;
      if (Array.isArray(patch.events)) row.events = [...patch.events];
      if (typeof patch.active === 'boolean') row.active = patch.active;
      if (patch.retryConfig && typeof patch.retryConfig === 'object') {
        row.retryConfig = { ...row.retryConfig, ...patch.retryConfig };
      }
    }
    row.updatedAt = new Date();
    this._items.set(id, row);
    return publicView(row);
  }

  async remove(id) {
    return this._items.delete(id);
  }

  size() {
    return this._items.size;
  }
}

const DEFAULT_RETRY_CONFIG = Object.freeze({
  maxAttempts: 5,
  initialDelay: 1000,
  maxDelay: 60_000,
});

function publicView(row) {
  // `secret` is intentionally not copied.
  return {
    _id: row._id,
    name: row.name,
    url: row.url,
    events: Array.isArray(row.events) ? [...row.events] : [],
    active: row.active !== false,
    retryConfig: { ...row.retryConfig },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sanitizeInbound(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Webhook record must be an object');
  }
  return {
    _id: input._id || newId(),
    name: input.name,
    url: input.url,
    secret: input.secret,
    events: Array.isArray(input.events) ? [...input.events] : [],
    active: input.active !== false,
    retryConfig: { ...DEFAULT_RETRY_CONFIG, ...(input.retryConfig || {}) },
    createdAt: input.createdAt || new Date(),
    updatedAt: input.updatedAt || new Date(),
  };
}

module.exports = {
  InMemoryWebhookStore,
  DEFAULT_RETRY_CONFIG,
};
