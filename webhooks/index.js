'use strict';

const crypto = require('crypto');
const { buildAdminWebhooksRouter } = require('../routes/admin/webhooks');
const { deliverWithRetry } = require('../services/webhookDelivery');
const { InMemoryWebhookStore } = require('../services/inMemoryStore');
const { makeMongooseStore } = require('../services/webhookStore');
const { getDefaultOrderEventBus } = require('../events/orderEventBus');

/**
 * dispatchOrderEvent — fire a webhook delivery for every active, subscribed
 * webhook row in `store`. Returns a summary object suitable for logging.
 *
 * The function is intentionally a small adapter: it pulls the list of
 * subscribed webhooks from the store, then fires the deliveries in
 * parallel via `Promise.all`. Each delivery uses the webhook's own
 * retryConfig, so different subscribers can have different retry budgets.
 */

async function dispatchOrderEvent(store, eventType, payload, opts = {}) {
  if (!store) throw new TypeError('dispatchOrderEvent: store is required');
  if (typeof eventType !== 'string' || !eventType) {
    throw new TypeError('dispatchOrderEvent: eventType must be a non-empty string');
  }
  const webhooks = await store.findActiveForEvent(eventType);
  if (!webhooks || webhooks.length === 0) {
    return { ok: true, dispatched: 0, eventType, results: [] };
  }

  const deliveryId = (opts && opts.deliveryId) || crypto.randomUUID();
  const fetchImpl = opts && opts.fetchImpl;
  const sleep = opts && opts.sleep;

  const tasks = webhooks.map(async (w) => {
    const res = await deliverWithRetry({
      url: w.url,
      secret: w.secret,
      payload,
      eventType,
      deliveryId,
      retryConfig: w.retryConfig,
      fetchImpl,
      sleep,
    });
    return {
      webhookId: w._id,
      name: w.name,
      url: w.url,
      ok: res.ok,
      attempts: res.attempts,
      lastStatus:
        res.results && res.results.length > 0
          ? res.results[res.results.length - 1].status
          : 0,
      lastError: res.lastError || null,
    };
  });

  const results = await Promise.all(tasks);
  return {
    ok: results.every((r) => r.ok),
    dispatched: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    eventType,
    deliveryId,
    results,
  };
}

/**
 * attachWebhooks(app, { store, base }) — wires the webhook module into an
 * existing express app. It:
 *   - mounts the admin router at `base + '/api/admin'` (default `/api/admin`)
 *   - subscribes the webhook dispatcher to every order.* event on the
 *     default bus so a bus `emitOrderEvent('order.created', ...)` triggers
 *     a delivery
 *   - exposes `app.locals.webhooks.dispatchOrderEvent` for code that wants
 *     to bypass the bus and fire directly
 *
 * Returns the unsubscribe function.
 */

function attachWebhooks(app, options = {}) {
  if (!app || typeof app.use !== 'function') {
    throw new TypeError('attachWebhooks: app must be an express app');
  }
  const store = options.store;
  if (!store) throw new TypeError('attachWebhooks: store is required');
  const base = (options.base || '').replace(/\/+$/, '');
  const bus = options.bus || getDefaultOrderEventBus();

  const router = buildAdminWebhooksRouter({ store });
  app.use(`${base}/api/admin`, router);

  const unsubscribers = [];
  for (const eventType of [
    'order.created',
    'order.awaiting-payment',
    'order.payment-received',
    'order.payment-confirmed',
    'order.processing',
    'order.completed',
    'order.cancelled',
    'order.refunded',
  ]) {
    const unsubscribe = bus.subscribeOrderEvent(eventType, (payload) => {
      // Fire-and-forget; logging is the caller's responsibility.
      dispatchOrderEvent(store, eventType, payload, { fetchImpl: options.fetchImpl })
        .then((summary) => {
          if (options.onDelivery) {
            try { options.onDelivery(eventType, summary); } catch (_e) { /* ignore */ }
          }
        })
        .catch((err) => {
          if (options.onDeliveryError) {
            try { options.onDeliveryError(eventType, err); } catch (_e) { /* ignore */ }
          }
        });
    });
    unsubscribers.push(unsubscribe);
  }

  if (!app.locals.webhooks) app.locals.webhooks = {};
  app.locals.webhooks.dispatchOrderEvent = (eventType, payload) =>
    dispatchOrderEvent(store, eventType, payload, { fetchImpl: options.fetchImpl });
  app.locals.webhooks.store = store;
  app.locals.webhooks.bus = bus;
  app.locals.webhooks.unsubscribeAll = () => {
    for (const u of unsubscribers) {
      try { u(); } catch (_e) { /* ignore */ }
    }
  };

  return app.locals.webhooks.unsubscribeAll;
}

/**
 * createWebhookModule(mongoose) — production wrapper: connect to Mongo
 * using WEBHOOK_MONGO_URI or MONGO_URI, build a Mongoose store, and return
 * { attach, mongoose, store }. Connection failure is non-fatal: the caller
 * can still attach the module with the in-memory store.
 */

async function createWebhookModule(mongooseLib, { uri, store } = {}) {
  const mongoose = mongooseLib;
  let activeStore = store || null;
  let connection = null;

  if (!activeStore) {
    const targetUri = uri || process.env.WEBHOOK_MONGO_URI || process.env.MONGO_URI;
    if (mongoose && targetUri) {
      try {
        connection = mongoose.connection;
        if (connection.readyState === 0) {
          await mongoose.connect(targetUri, { serverSelectionTimeoutMS: 4000 });
        }
        activeStore = makeMongooseStore(mongoose);
      } catch (err) {
        // Fall back to in-memory if the real connection is not available.
        activeStore = new InMemoryWebhookStore();
      }
    } else {
      activeStore = new InMemoryWebhookStore();
    }
  }

  return {
    mongoose,
    connection,
    store: activeStore,
    attach: (app, options = {}) => attachWebhooks(app, { ...options, store: activeStore }),
  };
}

module.exports = {
  attachWebhooks,
  dispatchOrderEvent,
  createWebhookModule,
  // re-exports so downstream code only needs to import from one place
  buildAdminWebhooksRouter,
  InMemoryWebhookStore,
  makeMongooseStore,
  getDefaultOrderEventBus,
  deliverWithRetry,
};
