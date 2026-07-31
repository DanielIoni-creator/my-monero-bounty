'use strict';
// In-process order-event bus. Order lifecycle code emits order.* events here;
// the webhook dispatcher (webhooks/index.js) listens and fans out to webhooks.
const { EventEmitter } = require('events');
const { ORDER_EVENTS } = require('../models/Webhook');

function createOrderEventBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  function emitOrderEvent(eventType, data) {
    if (!ORDER_EVENTS.includes(eventType)) throw new Error('Unknown order event: ' + String(eventType));
    const envelope = { type: eventType, data: data == null ? {} : data, at: new Date().toISOString() };
    bus.emit('order', envelope);
    bus.emit(eventType, envelope.data);
    return envelope;
  }
  return { bus, emitOrderEvent };
}

const singleton = createOrderEventBus();
module.exports = { createOrderEventBus, bus: singleton.bus, emitOrderEvent: singleton.emitOrderEvent, ORDER_EVENTS };
