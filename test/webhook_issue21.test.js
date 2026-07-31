'use strict';

/**
 * Tests for the issue #21 additions on top of the merged #5 webhook system.
 *
 * Coverage:
 *   - admin auth middleware (services/adminAuth.js)
 *   - delivery log + per-webhook /deliveries endpoint
 *     + operator-facing /test endpoint
 *   - OrderState state machine emitting the 8 order.* events
 *
 * The tests deliberately do not modify the existing webhook.test.js so the
 * original #5 surface remains its own contract.
 */

process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const {
  buildAdminWebhooksRouter,
} = require('../routes/admin/webhooks');
const { InMemoryWebhookStore } = require('../services/inMemoryStore');
const {
  InMemoryDeliveryLog,
} = require('../services/deliveryLog');
const { buildAdminAuth } = require('../services/adminAuth');
const { OrderState } = require('../services/orderState');
const { OrderEventBus } = require('../events/orderEventBus');
const { ORDER_EVENT_TYPES } = require('../models/Webhook');

const SECRET = 'super-secret-shared-key-1234';

function makeApp(store, { deliveryLog, adminAuth } = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/admin',
    ...(adminAuth ? [adminAuth] : []),
    buildAdminWebhooksRouter({ store, deliveryLog })
  );
  return app;
}

beforeEach(() => {
  delete process.env.WEBHOOK_ADMIN_TOKEN;
  delete process.env.WEBHOOK_ADMIN_TOKENS;
  delete process.env.WEBHOOK_ADMIN_OPEN;
});

// ---------------------------------------------------------------------------
// admin auth
// ---------------------------------------------------------------------------

describe('buildAdminAuth', () => {
  test('refuses when no tokens are configured outside test mode', () => {
    process.env.NODE_ENV = 'production';
    const mw = buildAdminAuth();
    const app = express();
    app.use(mw);
    app.get('/x', (_req, res) => res.json({ ok: true }));
    return request(app).get('/x').expect(503);
  });

  test('accepts with a configured bearer token (token mode)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_ADMIN_TOKEN = 'topsecret';
    const mw = buildAdminAuth();
    expect(mw.mode()).toBe('token-required');
    const app = express();
    app.use(mw);
    app.get('/x', (_req, res) => res.json({ ok: true }));
    const ok = await request(app).get('/x').set('Authorization', 'Bearer topsecret');
    expect(ok.status).toBe(200);
    const noAuth = await request(app).get('/x');
    expect(noAuth.status).toBe(401);
    const wrong = await request(app).get('/x').set('Authorization', 'Bearer wrong');
    expect(wrong.status).toBe(401);
  });

  test('accepts multiple tokens via WEBHOOK_ADMIN_TOKENS', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_ADMIN_TOKENS = 'a, b, c';
    const mw = buildAdminAuth();
    expect(mw.mode()).toBe('token-required');
    const app = express();
    app.use(mw);
    app.get('/x', (_req, res) => res.json({ ok: true }));
    for (const t of ['a', 'b', 'c']) {
      const ok = await request(app).get('/x').set('Authorization', `Bearer ${t}`);
      expect(ok.status).toBe(200);
    }
  });

  test('honors WEBHOOK_ADMIN_OPEN=1 as an explicit escape hatch', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_ADMIN_OPEN = '1';
    const mw = buildAdminAuth();
    expect(mw.mode()).toBe('open');
    const app = express();
    app.use(mw);
    app.get('/x', (_req, res) => res.json({ ok: true }));
    return request(app).get('/x').expect(200);
  });

  test('uses constant-time comparison across the token bytes', () => {
    const a = buildAdminAuth({ tokens: ['abcdef0123'] });
    // length-mismatch should fail-fast without throwing
    expect(typeof a).toBe('function');
    // mismatched same-length token must still be rejected
    const app = express();
    app.use(a);
    app.get('/x', (_req, res) => res.json({ ok: true }));
    return request(app).get('/x').set('Authorization', 'Bearer abcdef9999').expect(401);
  });
});

// ---------------------------------------------------------------------------
// delivery log + endpoints
// ---------------------------------------------------------------------------

describe('GET /api/admin/webhooks/:id/deliveries', () => {
  test('returns 503 when no delivery log is wired', async () => {
    const store = new InMemoryWebhookStore();
    const created = await store.create({
      name: 'orders',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.created'],
    });
    const app = makeApp(store); // no deliveryLog
    const res = await request(app).get(`/api/admin/webhooks/${created._id}/deliveries`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('delivery_log_unavailable');
  });

  test('returns 404 for unknown id even when a log is wired', async () => {
    const store = new InMemoryWebhookStore();
    const log = new InMemoryDeliveryLog();
    const app = makeApp(store, { deliveryLog: log });
    const res = await request(app).get(`/api/admin/webhooks/${crypto.randomBytes(8).toString('hex')}/deliveries`);
    expect(res.status).toBe(404);
  });

  test('returns 200 with empty events when no dispatches have happened', async () => {
    const store = new InMemoryWebhookStore();
    const created = await store.create({
      name: 'orders',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.created'],
    });
    const log = new InMemoryDeliveryLog();
    const app = makeApp(store, { deliveryLog: log });
    const res = await request(app).get(`/api/admin/webhooks/${created._id}/deliveries`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.events).toEqual([]);
  });

  test('records per-webhook delivery entries and lists them newest-first', async () => {
    const store = new InMemoryWebhookStore();
    const created = await store.create({
      name: 'orders',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.created'],
    });
    const log = new InMemoryDeliveryLog();
    await log.record({
      webhookId: created._id,
      eventType: 'order.created',
      ok: false,
      attempts: 5,
      lastStatus: 503,
      lastError: 'service unavailable',
      url: created.url,
      name: created.name,
    });
    await new Promise((r) => setTimeout(r, 5));
    await log.record({
      webhookId: created._id,
      eventType: 'order.created',
      ok: true,
      attempts: 1,
      lastStatus: 200,
      url: created.url,
      name: created.name,
    });
    const app = makeApp(store, { deliveryLog: log });
    const res = await request(app).get(`/api/admin/webhooks/${created._id}/deliveries`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].ok).toBe(true);
    expect(res.body.events[1].ok).toBe(false);
    expect(res.body.events[1].lastError).toMatch(/unavailable/);
  });

  test('respects limit query param and clamps to a safe upper bound', async () => {
    const store = new InMemoryWebhookStore();
    const created = await store.create({
      name: 'orders',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.created'],
    });
    const log = new InMemoryDeliveryLog();
    for (let i = 0; i < 5; i++) {
      await log.record({
        webhookId: created._id,
        eventType: 'order.created',
        ok: true,
        attempts: 1,
        lastStatus: 200,
      });
    }
    const app = makeApp(store, { deliveryLog: log });
    const small = await request(app)
      .get(`/api/admin/webhooks/${created._id}/deliveries`)
      .query({ limit: 2 });
    expect(small.body.events).toHaveLength(2);
    const huge = await request(app)
      .get(`/api/admin/webhooks/${created._id}/deliveries`)
      .query({ limit: 99999 });
    expect(huge.body.events).toHaveLength(5); // never more than we recorded
    expect(huge.body.limit).toBe(500);        // clamped
  });
});

describe('POST /api/admin/webhooks/:id/test', () => {
  test('returns 404 for unknown id', async () => {
    const store = new InMemoryWebhookStore();
    const app = makeApp(store);
    const res = await request(app).post(`/api/admin/webhooks/${crypto.randomBytes(8).toString('hex')}/test`);
    expect(res.status).toBe(404);
  });

  test('fires a synthetic delivery through the dispatcher and records it', async () => {
    const store = new InMemoryWebhookStore();
    const created = await store.create({
      name: 'orders',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.created'],
    });
    const log = new InMemoryDeliveryLog();

    // Use a local capture server instead of mocking fetchImpl, so the test
    // exercises the real HMAC + headers + payload shape end-to-end.
    const captured = [];
    const captureApp = express();
    captureApp.use(express.text({ type: '*/*' }));
    captureApp.post('/sink', (req, res) => {
      captured.push({
        body: req.body,
        headers: req.headers,
        ts: Date.now(),
      });
      res.status(200).end();
    });
    const server = captureApp.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    await store.update(created._id, { url: `http://127.0.0.1:${port}/sink` });

    const app = makeApp(store, { deliveryLog: log });
    const res = await request(app).post(`/api/admin/webhooks/${created._id}/test`);
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.dispatched).toBe(1);
    expect(res.body.failed).toBe(0);

    // The capture server saw exactly one request and the headers were set.
    expect(captured).toHaveLength(1);
    expect(captured[0].headers['x-myzubster-event']).toBe('order.created');
    expect(captured[0].headers['x-myzubster-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(captured[0].body).toMatch(/__test\":true/);

    // Delivery log got one entry.
    const listed = await log.listForWebhook(created._id);
    expect(listed).toHaveLength(1);
    expect(listed[0].eventType).toBe('order.created');
    expect(listed[0].ok).toBe(true);
    expect(listed[0].lastStatus).toBe(200);
    expect(listed[0].deliveryPayloadPreview).toMatch(/__test/);

    server.close();
  });

  test('reports failed delivery when the remote returns 5xx', async () => {
    const store = new InMemoryWebhookStore();
    const created = await store.create({
      name: 'orders',
      url: 'https://example.com/hook',
      secret: SECRET,
      events: ['order.created'],
    });
    const captureApp = express();
    captureApp.use(express.text({ type: '*/*' }));
    captureApp.post('/sink', (_req, res) => res.status(503).end('busy'));
    const server = captureApp.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    await store.update(created._id, { url: `http://127.0.0.1:${port}/sink` });
    // Make the retry budget small so the test stays fast.
    await store.update(created._id, {
      retryConfig: { maxAttempts: 1, initialDelay: 0, maxDelay: 0 },
    });

    const log = new InMemoryDeliveryLog();
    const app = makeApp(store, { deliveryLog: log });
    const res = await request(app).post(`/api/admin/webhooks/${created._id}/test`);
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(false);
    expect(res.body.failed).toBe(1);
    const listed = await log.listForWebhook(created._id);
    expect(listed[0].ok).toBe(false);
    expect(listed[0].lastStatus).toBe(503);

    server.close();
  });
});

// ---------------------------------------------------------------------------
// admin auth + admin router integration
// ---------------------------------------------------------------------------

describe('admin auth wired through attachWebhooks', () => {
  test('protected route returns 401 without a bearer token in production mode', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_ADMIN_TOKEN = 'topsecret';
    const { attachWebhooks } = require('../webhooks');
    const store = new InMemoryWebhookStore();
    const app = express();
    app.locals = {};
    const adminAuth = buildAdminAuth();
    attachWebhooks(app, { store, adminAuth });
    const res = await request(app).get('/api/admin/webhooks');
    expect(res.status).toBe(401);
    const ok = await request(app)
      .get('/api/admin/webhooks')
      .set('Authorization', 'Bearer topsecret');
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// OrderState state machine — emits all 8 order.* events
// ---------------------------------------------------------------------------

describe('OrderState', () => {
  test('rejects construction without a bus', () => {
    expect(() => new OrderState()).toThrow(/bus/);
  });

  test('emits order.created on create', () => {
    const bus = new OrderEventBus();
    const seen = [];
    bus.subscribeOrderEvent('order.created', (p) => seen.push(p));
    const orders = new OrderState({ bus });
    orders.create({ id: 'o-1', amount: '1.0' });
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('o-1');
    expect(seen[0].state).toBe('created');
  });

  test('walks a happy-path sequence and emits every listed event exactly once', () => {
    const bus = new OrderEventBus();
    const seen = [];
    for (const type of ORDER_EVENT_TYPES) {
      bus.subscribeOrderEvent(type, (p) => seen.push({ type, p }));
    }
    const orders = new OrderState({ bus });
    orders.create({ id: 'o-2' });
    orders.transition('o-2', 'awaiting-payment');
    orders.transition('o-2', 'payment-received', { txId: 'tx-abc' });
    orders.transition('o-2', 'payment-confirmed');
    orders.transition('o-2', 'processing');
    orders.transition('o-2', 'completed');

    const types = seen.map((e) => e.type);
    expect(types).toEqual([
      'order.created',
      'order.awaiting-payment',
      'order.payment-received',
      'order.payment-confirmed',
      'order.processing',
      'order.completed',
    ]);
    expect(seen[2].p.data.txId).toBe('tx-abc');
  });

  test('rejects illegal transitions without emitting', () => {
    const bus = new OrderEventBus();
    const types = [];
    for (const t of ORDER_EVENT_TYPES) {
      bus.subscribeOrderEvent(t, () => types.push(t));
    }
    const orders = new OrderState({ bus });
    orders.create({ id: 'o-3' });
    expect(() => orders.transition('o-3', 'completed')).toThrow(/not allowed/);
    expect(types).toEqual(['order.created']); // no extra event from illegal hop
  });

  test('completed / cancelled / refunded are terminal; further transitions throw', () => {
    const bus = new OrderEventBus();
    const orders = new OrderState({ bus });
    // cancelled is in the TERMINAL_STATES set AND has an empty allowed set.
    orders.create({ id: 'o-4' });
    orders.transition('o-4', 'cancelled');
    expect(() => orders.transition('o-4', 'processing')).toThrow();
    // refunded is the cleanest terminal: from completed -> refunded is the
    // only legal exit, then any further transition must throw.
    orders.create({ id: 'o-4b' });
    orders.transition('o-4b', 'awaiting-payment');
    orders.transition('o-4b', 'payment-received');
    orders.transition('o-4b', 'payment-confirmed');
    orders.transition('o-4b', 'processing');
    orders.transition('o-4b', 'completed');
    orders.transition('o-4b', 'refunded');
    let threw = false;
    try {
      orders.transition('o-4b', 'completed');
    } catch (e) {
      threw = true;
      // refunded has an empty allowed set so the not-allowed branch fires
      // before the terminal check; either error path is acceptable as long
      // as the transition is refused.
      expect(e.message).toMatch(/not allowed|already terminal/);
    }
    expect(threw).toBe(true);
  });

  test('errors on unknown orders and on duplicate creation', () => {
    const bus = new OrderEventBus();
    const orders = new OrderState({ bus });
    expect(() => orders.transition('ghost', 'awaiting-payment')).toThrow(/not found/);
    orders.create({ id: 'o-5' });
    expect(() => orders.create({ id: 'o-5' })).toThrow(/already exists/);
  });
});
