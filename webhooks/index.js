'use strict';
// Webhook module assembler + order-event lifecycle integration.
// Exposes:
//   attachWebhooks(app, { store, base })  — mount the admin CRUD router
//   dispatchOrderEvent(store, type, data, opts) — fan an order event out to subscribed webhooks with retry
//   createWebhookModule(mongoose, { base }) — production wrapper using a Mongoose store
const { getWebhookModel, ORDER_EVENTS } = require('../models/Webhook');
const { createMongooseStore } = require('../services/webhookStore');
const { createInMemoryStore } = require('../services/inMemoryStore');
const { createWebhookRouter } = require('../routes/admin/webhooks');
const { deliverWithRetry } = require('../services/webhookDelivery');
const { createOrderEventBus, bus, emitOrderEvent } = require('../events/orderEventBus');

const DEFAULT_BASE = '/api/admin/webhooks';

// Deliver one order event to every active webhook subscribed to it (retry backoff each).
// Non-blocking per webhook (Promise.all). Returns per-webhook delivery results.
async function dispatchOrderEvent(store, eventType, data, opts) {
  if (!ORDER_EVENTS.includes(eventType)) throw new Error('Unknown order event: ' + String(eventType));
  const hooks = await store.findByEvent(eventType);
  const event = { type: eventType, data: data == null ? {} : data };
  return Promise.all(hooks.map((w) =>
    deliverWithRetry(w, event, opts).then((r) => ({ webhook: String(w._id || w.id), url: w.url, events: w.events, delivered: r.delivered, attempts: r.attempts, lastError: r.lastError || null, signature: r.signature || null }))
  ));
}

function attachWebhooks(app, opts) {
  const store = (opts && opts.store) || createInMemoryStore();
  const base = (opts && opts.base) || DEFAULT_BASE;
  const useBus = (opts && opts.bus) || bus;
  app.use(base, createWebhookRouter({ store }));
  const dispatch = (eventType, data, options) => dispatchOrderEvent(store, eventType, data, options);
  app.locals.webhooks = { store, bus: useBus, emitOrderEvent, dispatchOrderEvent: dispatch };
  return { dispatch, store, bus: useBus };
}

// Production wrapper: build the Mongoose store from the Webhook model. The caller
// owns the actual mongoose.connect() (kept here non-blocking + env-driven so the
// existing process never hard-codes credentials twice).
function createWebhookModule(mongoose, opts = {}) {
  const Model = getWebhookModel(mongoose);
  const store = createMongooseStore(Model);
  function attach(app) { return attachWebhooks(app, { store, base: opts.base }); }
  function dispatch(eventType, data, options) { return dispatchOrderEvent(store, eventType, data, options); }
  async function connect(mongoUri) {
    const uri = mongoUri || process.env.WEBHOOK_MONGO_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/myzubster';
    await mongoose.connect(uri);
    return uri;
  }
  return { Model, store, attach, dispatch, connect, bus, emitOrderEvent, ORDER_EVENTS };
}

module.exports = { attachWebhooks, dispatchOrderEvent, createWebhookModule, createInMemoryStore, createMongooseStore, createWebhookRouter, emitOrderEvent, bus, ORDER_EVENTS, DEFAULT_BASE };
