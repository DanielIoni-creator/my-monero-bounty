'use strict';

/**
 * Order state machine.
 *
 * Issue #21 requires that the eight `order.*` events fire from somewhere
 * real. `OrderState` is a minimal in-process state holder that gives
 * integration code a single, well-typed entry point:
 *
 *   const orderState = new OrderState({ bus });
 *   orderState.create({ id: 'o-1', amount: '0.5' });                 // -> order.created
 *   orderState.transition('o-1', 'awaiting-payment', { address: '...' }); // -> order.awaiting-payment
 *   orderState.transition('o-1', 'payment-received', { txId: 'abc' });    // -> order.payment-received
 *   ...
 *
 * The bus is supplied by the caller so this module stays decoupled from
 * the global singleton. Invalid transitions are rejected without
 * emitting; valid transitions return the new state so callers can log
 * the result without re-querying.
 */

const { ORDER_EVENT_TYPES } = require('../models/Webhook');

const ALLOWED_TRANSITIONS = Object.freeze({
  'order.created': new Set(['order.awaiting-payment', 'order.cancelled']),
  'order.awaiting-payment': new Set([
    'order.payment-received',
    'order.payment-confirmed',
    'order.cancelled',
  ]),
  'order.payment-received': new Set([
    'order.payment-confirmed',
    'order.processing',
    'order.cancelled',
  ]),
  'order.payment-confirmed': new Set(['order.processing', 'order.cancelled']),
  'order.processing': new Set(['order.completed', 'order.cancelled', 'order.refunded']),
  'order.completed': new Set(['order.refunded']),
  'order.cancelled': new Set([]),
  'order.refunded': new Set([]),
});

const EVENT_TO_STATE = Object.freeze({
  'order.created': 'created',
  'order.awaiting-payment': 'awaiting-payment',
  'order.payment-received': 'payment-received',
  'order.payment-confirmed': 'payment-confirmed',
  'order.processing': 'processing',
  'order.completed': 'completed',
  'order.cancelled': 'cancelled',
  'order.refunded': 'refunded',
});

const TERMINAL_STATES = new Set(['refunded']);

class OrderState {
  constructor({ bus } = {}) {
    if (!bus || typeof bus.emitOrderEvent !== 'function') {
      throw new TypeError('OrderState: a bus with emitOrderEvent is required');
    }
    this._bus = bus;
    this._orders = new Map(); // id -> { id, state, data }
  }

  create(initial = {}) {
    if (!initial || !initial.id) {
      throw new TypeError('OrderState.create: id is required');
    }
    if (this._orders.has(initial.id)) {
      throw new Error(`OrderState.create: order ${initial.id} already exists`);
    }
    const data = { ...initial };
    const state = 'created';
    this._orders.set(initial.id, { id: initial.id, state, data });
    this._emit('order.created', { id: initial.id, state, data });
    return this._publicView(initial.id);
  }

  transition(id, nextState, extra = {}) {
    const order = this._orders.get(id);
    if (!order) {
      throw new Error(`OrderState.transition: order ${id} not found`);
    }
    const currentEvent = stateToEvent(order.state);
    const nextEvent = stateToEvent(nextState);
    if (!nextEvent) {
      throw new Error(`OrderState.transition: unknown state "${nextState}"`);
    }
    const allowed = ALLOWED_TRANSITIONS[currentEvent] || new Set();
    if (!allowed.has(nextEvent)) {
      const err = new Error(
        `OrderState.transition: ${currentEvent} -> ${nextEvent} is not allowed`
      );
      err.code = 'invalid_transition';
      throw err;
    }
    if (TERMINAL_STATES.has(order.state)) {
      throw new Error(`OrderState.transition: order ${id} is already terminal`);
    }
    order.state = nextState;
    if (extra && typeof extra === 'object') {
      order.data = { ...order.data, ...extra };
    }
    this._emit(nextEvent, { id, state: order.state, data: order.data });
    return this._publicView(id);
  }

  get(id) {
    return this._publicView(id);
  }

  size() {
    return this._orders.size;
  }

  _publicView(id) {
    const order = this._orders.get(id);
    if (!order) return null;
    return { id: order.id, state: order.state, data: { ...order.data } };
  }

  _emit(eventType, payload) {
    if (!ORDER_EVENT_TYPES.includes(eventType)) {
      throw new Error(`OrderState: refusing to emit unknown event "${eventType}"`);
    }
    this._bus.emitOrderEvent(eventType, payload);
  }
}

function stateToEvent(state) {
  for (const evt of ORDER_EVENT_TYPES) {
    if (EVENT_TO_STATE[evt] === state) return evt;
  }
  return null;
}

module.exports = {
  OrderState,
  ALLOWED_TRANSITIONS,
  EVENT_TO_STATE,
  TERMINAL_STATES,
  stateToEvent,
};
