'use strict';

/**
 * Small in-process EventEmitter-backed bus for order.* events.
 *
 * The bus exists so that any module in the gateway (the order service, a
 * cron job, an admin action) can fan an event out to subscribers without
 * coupling to the webhook delivery service. Webhook subscribers register
 * via `subscribeOrderEvent(type, handler)` and the bus calls them all
 * when `emitOrderEvent(type, payload)` runs.
 *
 * The bus is intentionally tiny: we are not reimplementing the EventEmitter
 * contract, we are wrapping it so a single diagnostic surface (`listSubscribers`)
 * makes the system's state inspectable from a test or admin endpoint.
 */

const { EventEmitter } = require('events');

const DEFAULT_MAX_LISTENERS = 100;

class OrderEventBus {
  constructor({ maxListeners = DEFAULT_MAX_LISTENERS } = {}) {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(maxListeners);
    this._subscribers = new Map();
  }

  /**
   * Register a handler for an order.* event. Returns an unsubscribe fn.
   */
  subscribeOrderEvent(type, handler) {
    if (typeof type !== 'string' || !type) {
      throw new TypeError('subscribeOrderEvent: type must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('subscribeOrderEvent: handler must be a function');
    }
    this._emitter.on(type, handler);
    const key = `${type}::${this._subscribersFor(type).length}`;
    this._subscribers.set(key, { type, handler });
    return () => {
      this._emitter.off(type, handler);
      this._subscribers.delete(key);
    };
  }

  /**
   * Emit an order.* event. Listeners run synchronously on the emitter; they
   * should not throw — webhook delivery wraps the real HTTP work in a
   * promise but `emit` is fire-and-forget.
   */
  emitOrderEvent(type, payload) {
    if (typeof type !== 'string' || !type) {
      throw new TypeError('emitOrderEvent: type must be a non-empty string');
    }
    this._emitter.emit(type, payload);
  }

  _subscribersFor(type) {
    const out = [];
    for (const entry of this._subscribers.values()) {
      if (entry.type === type) out.push(entry);
    }
    return out;
  }

  listSubscribers() {
    const out = [];
    for (const entry of this._subscribers.values()) {
      out.push({ type: entry.type });
    }
    return out;
  }

  removeAllListeners() {
    this._emitter.removeAllListeners();
    this._subscribers.clear();
  }
}

let defaultBus = null;

function getDefaultOrderEventBus() {
  if (!defaultBus) defaultBus = new OrderEventBus();
  return defaultBus;
}

module.exports = {
  OrderEventBus,
  getDefaultOrderEventBus,
};
