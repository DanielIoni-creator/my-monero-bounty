'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const {
  buildAdminWebhooksRouter,
  validateCreateBody,
  validateUpdateBody,
  ORDER_EVENT_TYPES,
} = require('../routes/admin/webhooks');
const {
  signPayload,
  computeBackoffMs,
  deliverOnce,
  deliverWithRetry,
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  EVENT_HEADER,
  DELIVERY_ID_HEADER,
} = require('../services/webhookDelivery');
const { InMemoryWebhookStore } = require('../services/inMemoryStore');
const {
  attachWebhooks,
  dispatchOrderEvent,
} = require('../webhooks');
const { getDefaultOrderEventBus } = require('../events/orderEventBus');
const { DEFAULT_RETRY_CONFIG } = require('../models/Webhook');

const SECRET = 'super-secret-shared-key-1234';

function makeApp(store) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', buildAdminWebhooksRouter({ store }));
  return app;
}

// ---------------------------------------------------------------------------
// Model: event catalog + default retry config
// ---------------------------------------------------------------------------

describe('Webhook model', () => {
  test('ORDER_EVENT_TYPES lists all 8 order lifecycle events', () => {
    expect(ORDER_EVENT_TYPES).toEqual([
      'order.created',
      'order.awaiting-payment',
      'order.payment-received',
      'order.payment-confirmed',
      'order.processing',
      'order.completed',
      'order.cancelled',
      'order.refunded',
    ]);
  });

  test('DEFAULT_RETRY_CONFIG matches the issue requirements', () => {
    expect(DEFAULT_RETRY_CONFIG).toEqual({
      maxAttempts: 5,
      initialDelay: 1000,
      maxDelay: 60000,
    });
  });
});

// ---------------------------------------------------------------------------
// HMAC signing
// ---------------------------------------------------------------------------

describe('signPayload', () => {
  test('produces sha256=<hex> header value', () => {
    const sig = signPayload(SECRET, { a: 1 });
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(sig.length).toBe('sha256='.length + 64);
  });

  test('is deterministic and verifier-stable (sorted keys)', () => {
    const a = signPayload(SECRET, { b: 2, a: 1 });
    const b = signPayload(SECRET, { a: 1, b: 2 });
    expect(a).toBe(b);
  });

  test('produces a different signature for a different secret', () => {
    const a = signPayload(SECRET, { a: 1 });
    const b = signPayload('a-different-secret-of-length-8+', { a: 1 });
    expect(a).not.toBe(b);
  });

  test('rejects empty / non-string secret', () => {
    expect(() => signPayload('', { a: 1 })).toThrow(/secret/);
    expect(() => signPayload(null, { a: 1 })).toThrow(/secret/);
  });
});

// ---------------------------------------------------------------------------
// Backoff math
// ---------------------------------------------------------------------------

describe('computeBackoffMs', () => {
  test('rejects bad input', () => {
    expect(() => computeBackoffMs(0, 100)).toThrow();
    expect(() => computeBackoffMs(1, -1)).toThrow();
    expect(() => computeBackoffMs(1, 100, -1)).toThrow();
  });

  test('attempt 1 with initialDelay=0 always returns 0', () => {
    for (let i = 0; i < 25; i++) {
      expect(computeBackoffMs(1, 0, 1000)).toBe(0);
    }
  });

  test('jitter is bounded by the computed cap (full-jitter)', () => {
    const initial = 1000;
    const max = 4000;
    for (let attempt = 1; attempt <= 6; attempt++) {
      for (let i = 0; i < 200; i++) {
        const v = computeBackoffMs(attempt, initial, max);
        const cap = Math.min(initial * 2 ** (attempt - 1), max);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(cap);
      }
    }
  });

  test('cap is reached but never exceeded when attempt grows', () => {
    const initial = 1000;
    const max = 8000;
    for (let i = 0; i < 200; i++) {
      // attempt 4 with initial=1000 would want 8000 without cap; we cap to 8000.
      const v = computeBackoffMs(4, initial, max);
      expect(v).toBeLessThanOrEqual(max);
    }
  });
});

// ---------------------------------------------------------------------------
// deliverOnce / deliverWithRetry
// ---------------------------------------------------------------------------

describe('deliverOnce', () => {
  test('returns ok on a 2xx response', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    const res = await deliverOnce({
      url: 'https://example.com/hook',
      secret: SECRET,
      payload: { hello: 'world' },
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  test('returns !ok on a 5xx response', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 503 }));
    const res = await deliverOnce({
      url: 'https://example.com/hook',
      secret: SECRET,
      payload: { hello: 'world' },
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });

  test('returns !ok on a thrown fetch error', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('econnreset');
    });
    const res = await deliverOnce({
      url: 'https://example.com/hook',
      secret: SECRET,
      payload: { hello: 'world' },
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toMatch(/econnreset/);
  });

  test('sends the HMAC signature + event + delivery headers', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    await deliverOnce({
      url: 'https://example.com/hook',
      secret: SECRET,
      payload: { hello: 'world' },
      fetchImpl,
      eventType: 'order.created',
      deliveryId: 'd-123',
    });
    const opts = fetchImpl.mock.calls[0][1];
    expect(opts.method).toBe('POST');
    expect(opts.headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(opts.headers[EVENT_HEADER]).toBe('order.created');
    expect(opts.headers[DELIVERY_ID_HEADER]).toBe('d-123');
  });
});

describe('deliverWithRetry', () => {
  test('stops after the first 2xx', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    const res = await deliverWithRetry({
      url: 'https://example.com/hook',
      secret: SECRET,
      payload: { x: 1 },
      fetchImpl,
      sleep: async () => {},
    });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('retries up to maxAttempts on persistent 5xx', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 500 }));
    const res = await deliverWithRetry({
      url: 'https://example.com/hook',
      secret: SECRET,
      payload: { x: 1 },
      fetchImpl,
      sleep: async () => {},
      retryConfig: { maxAttempts: 4, initialDelay: 0, maxDelay: 0 },
    });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('retries on thrown errors and eventually fails', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('boom');
    });
    const res = await deliverWithRetry({
      url: 'https://example.com/hook',
      secret: SECRET,
      payload: { x: 1 },
      fetchImpl,
      sleep: async () => {},
      retryConfig: { maxAttempts: 3, initialDelay: 0, maxDelay: 0 },
    });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.lastError).toMatch(/boom/);
  });
});

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

describe('InMemoryWebhookStore', () => {
  test('create / find / update / remove + secret is hidden by default', async () => {
    const store = new InMemoryWebhookStore();
    const created = await store.create({
      name: 'orders-monitor',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.created', 'order.completed'],
    });
    expect(created._id).toBeDefined();
    expect(created.secret).toBeUndefined();

    const fetched = await store.findById(created._id);
    expect(fetched.name).toBe('orders-monitor');
    expect(fetched.secret).toBeUndefined();

    const withSecret = await store.findByIdWithSecret(created._id);
    expect(withSecret.secret).toBe(SECRET);

    const updated = await store.update(created._id, { active: false });
    expect(updated.active).toBe(false);

    const removed = await store.remove(created._id);
    expect(removed).toBe(true);
    expect(await store.findById(created._id)).toBeNull();
  });

  test('findActiveForEvent filters by eventType and active flag', async () => {
    const store = new InMemoryWebhookStore();
    await store.create({
      name: 'A',
      url: 'https://a.example.com/hook',
      secret: SECRET,
      events: ['order.created'],
      active: true,
    });
    await store.create({
      name: 'B',
      url: 'https://b.example.com/hook',
      secret: SECRET,
      events: ['order.cancelled'],
      active: true,
    });
    await store.create({
      name: 'C',
      url: 'https://c.example.com/hook',
      secret: SECRET,
      events: ['order.created'],
      active: false,
    });

    const matches = await store.findActiveForEvent('order.created');
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe('A');
    expect(matches[0].secret).toBe(SECRET);
  });
});

// ---------------------------------------------------------------------------
// Admin router validation
// ---------------------------------------------------------------------------

describe('validateCreateBody / validateUpdateBody', () => {
  test('create requires name/url/secret', () => {
    expect(validateCreateBody({})).toMatch(/name/);
    expect(validateCreateBody({ name: 'x' })).toMatch(/url/);
    expect(validateCreateBody({ name: 'x', url: 'https://e.example/hook' })).toMatch(/secret/);
  });

  test('create rejects invalid url', () => {
    expect(
      validateCreateBody({ name: 'x', url: 'not a url', secret: SECRET })
    ).toMatch(/url/);
    expect(
      validateCreateBody({ name: 'x', url: 'ftp://e.example/hook', secret: SECRET })
    ).toMatch(/url/);
  });

  test('create rejects invalid events', () => {
    expect(
      validateCreateBody({
        name: 'x',
        url: 'https://e.example/hook',
        secret: SECRET,
        events: ['order.not-a-real-event'],
      })
    ).toMatch(/events/);
  });

  test('create accepts a valid event list', () => {
    expect(
      validateCreateBody({
        name: 'x',
        url: 'https://e.example/hook',
        secret: SECRET,
        events: ['order.created', 'order.completed'],
      })
    ).toBeNull();
  });

  test('update rejects non-boolean active', () => {
    expect(validateUpdateBody({ active: 'yes' })).toMatch(/active/);
  });

  test('update accepts a partial patch', () => {
    expect(validateUpdateBody({ active: false })).toBeNull();
    expect(validateUpdateBody({ name: 'new-name' })).toBeNull();
  });

  test('update rejects short secret on patch', () => {
    expect(validateUpdateBody({ secret: 'short' })).toMatch(/secret/);
  });
});

// ---------------------------------------------------------------------------
// Admin router — end-to-end over HTTP (no network)
// ---------------------------------------------------------------------------

describe('admin webhooks router (HTTP)', () => {
  test('full CRUD lifecycle: create, list, get, update, delete', async () => {
    const store = new InMemoryWebhookStore();
    const app = makeApp(store);

    const createRes = await request(app)
      .post('/api/admin/webhooks')
      .send({
        name: 'orders-monitor',
        url: 'https://example.com/hook',
        secret: SECRET,
        events: ['order.created', 'order.completed'],
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.secret).toBeUndefined();
    const id = createRes.body._id;

    const listRes = await request(app).get('/api/admin/webhooks');
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body).toHaveLength(1);

    const getRes = await request(app).get(`/api/admin/webhooks/${id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.name).toBe('orders-monitor');

    const updateRes = await request(app)
      .put(`/api/admin/webhooks/${id}`)
      .send({ active: false, events: ['order.refunded'] });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.active).toBe(false);
    expect(updateRes.body.events).toEqual(['order.refunded']);

    const delRes = await request(app).delete(`/api/admin/webhooks/${id}`);
    expect(delRes.status).toBe(204);

    const gone = await request(app).get(`/api/admin/webhooks/${id}`);
    expect(gone.status).toBe(404);
  });

  test('returns 400 on invalid create body', async () => {
    const store = new InMemoryWebhookStore();
    const app = makeApp(store);
    const res = await request(app).post('/api/admin/webhooks').send({ name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  test('returns 404 on unknown id for PUT/DELETE', async () => {
    const store = new InMemoryWebhookStore();
    const app = makeApp(store);
    const fakeId = crypto.randomBytes(12).toString('hex');
    const put = await request(app).put(`/api/admin/webhooks/${fakeId}`).send({ active: false });
    expect(put.status).toBe(404);
    const del = await request(app).delete(`/api/admin/webhooks/${fakeId}`);
    expect(del.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// attachWebhooks + dispatchOrderEvent
// ---------------------------------------------------------------------------

describe('attachWebhooks', () => {
  test('emits order.created via the bus and the dispatcher fans out to subscribers', async () => {
    const store = new InMemoryWebhookStore();
    await store.create({
      name: 'orders-monitor',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.created'],
    });

    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    const bus = getDefaultOrderEventBus();
    bus.removeAllListeners();

    const app = express();
    app.locals = {};
    const unsubscribe = attachWebhooks(app, { store, bus, fetchImpl });

    bus.emitOrderEvent('order.created', { orderId: 'o-1' });
    // Let the fire-and-forget delivery settle.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const opts = fetchImpl.mock.calls[0][1];
    expect(opts.method).toBe('POST');
    expect(opts.headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(opts.headers[EVENT_HEADER]).toBe('order.created');

    unsubscribe();
  });

  test('exposes app.locals.webhooks.dispatchOrderEvent for direct calls', async () => {
    const store = new InMemoryWebhookStore();
    await store.create({
      name: 'orders-monitor',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.completed'],
    });

    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    const app = express();
    app.locals = {};
    const bus = getDefaultOrderEventBus();
    bus.removeAllListeners();
    attachWebhooks(app, { store, bus, fetchImpl });

    const summary = await app.locals.webhooks.dispatchOrderEvent('order.completed', { orderId: 'o-2' });
    expect(summary.dispatched).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchOrderEvent', () => {
  test('skips webhooks not subscribed to the event', async () => {
    const store = new InMemoryWebhookStore();
    await store.create({
      name: 'only-completed',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.completed'],
    });
    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    const summary = await dispatchOrderEvent(store, 'order.created', { x: 1 }, { fetchImpl });
    expect(summary.dispatched).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  test('skips inactive webhooks', async () => {
    const store = new InMemoryWebhookStore();
    await store.create({
      name: 'inactive',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.created'],
      active: false,
    });
    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    const summary = await dispatchOrderEvent(store, 'order.created', { x: 1 }, { fetchImpl });
    expect(summary.dispatched).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  test('fans out in parallel and reports per-webhook success', async () => {
    const store = new InMemoryWebhookStore();
    await store.create({
      name: 'A',
      url: 'https://a.example.com/hook',
      secret: SECRET,
      events: ['order.created'],
    });
    await store.create({
      name: 'B',
      url: 'https://b.example.com/hook',
      secret: SECRET,
      events: ['order.created'],
    });

    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async () => ({ status: 200 }))
      .mockImplementationOnce(async () => ({ status: 500 }));
    // Override per-webhook retryConfig via the store so the failing webhook
    // makes exactly one attempt instead of looping up to the default 5.
    await store.update(
      (
        await store.findAll()
      ).find((r) => r.name === 'B')._id,
      { retryConfig: { maxAttempts: 1, initialDelay: 0, maxDelay: 0 } }
    );
    const summary = await dispatchOrderEvent(
      store,
      'order.created',
      { x: 1 },
      { fetchImpl, sleep: async () => {} }
    );
    expect(summary.dispatched).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
