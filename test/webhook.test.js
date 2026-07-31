'use strict';
// Unit tests for the order-event webhook system (bounty #5). Pure: no network
// hits to external hosts and no real DB. HTTP router coverage uses a loopback
// express server with the global fetch client. jest testEnvironment = node.
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const { ORDER_EVENTS, DEFAULTS, getWebhookModel, webhookSchemaFields } = require('../models/Webhook');
const { signPayload, computeBackoffMs, buildPayload, deliverWithRetry, deliverOnce } = require('../services/webhookDelivery');
const { createInMemoryStore } = require('../services/inMemoryStore');
const { createWebhookRouter, validateWebhookInput, sanitize } = require('../routes/admin/webhooks');
const { attachWebhooks, dispatchOrderEvent, createWebhookModule } = require('../webhooks');
const { createOrderEventBus, emitOrderEvent, bus } = require('../events/orderEventBus');

let tmpModel = null;

afterAll(async () => {
  try {
    if (tmpModel) { await mongoose.deleteModel(/Webhook/); }
    await mongoose.disconnect();
  } catch (e) { /* best effort */ }
});

describe('Webhook model & catalog', () => {
  test('ORDER_EVENTS lists exactly the order lifecycle events', () => {
    expect(ORDER_EVENTS.length).toBe(8);
    ORDER_EVENTS.forEach((e) => expect(e.startsWith('order.')).toBe(true));
    expect(ORDER_EVENTS).toContain('order.created');
    expect(ORDER_EVENTS).toContain('order.refunded');
  });

  test('DEFAULTS surface sensible retry config', () => {
    expect(DEFAULTS.active).toBe(true);
    expect(DEFAULTS.events).toEqual([]);
    expect(DEFAULTS.retryConfig).toEqual({ maxAttempts: 5, initialDelay: 1000, maxDelay: 60000 });
  });

  test('getWebhookModel lazily compiles a Mongoose model and caches it', () => {
    tmpModel = getWebhookModel(mongoose);
    expect(tmpModel.modelName).toBe('Webhook');
    expect(getWebhookModel(mongoose)).toBe(tmpModel); // cached
    const paths = Object.keys(tmpModel.schema.paths);
    ['name', 'url', 'secret', 'events', 'active'].forEach((f) => expect(paths).toContain(f));
    expect(paths).toContain('retryConfig.maxAttempts');
    expect(tmpModel.schema.paths.secret.options).toMatchObject({ type: String, select: false });
  });
});

describe('webhookDelivery — signPayload / buildPayload', () => {
  test('signPayload matches a known HMAC-SHA256 vector', () => {
    const want = crypto.createHmac('sha256', 's3cr3t').update('{"a":1}').digest('hex');
    expect(signPayload('s3cr3t', '{"a":1}')).toBe(want);
    expect(signPayload('s3cr3t', '{"a":1}')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('signPayload stringifies and tolerates falsy secret', () => {
    const want = crypto.createHmac('sha256', '').update('body').digest('hex');
    expect(signPayload(null, 'body')).toBe(want);
  });

  test('buildPayload shapes id/event/deliveredAt/data and coerces null data', () => {
    const p = buildPayload({ _id: 'abc' }, { type: 'order.created', data: { x: 7 } });
    expect(p.id).toBe('wh_abc');
    expect(p.event).toBe('order.created');
    expect(p.data).toEqual({ x: 7 });
    expect(typeof p.deliveredAt).toBe('string');
    const p2 = buildPayload({ id: 'z' }, { type: 'order.completed', data: null });
    expect(p2.id).toBe('wh_z');
    expect(p2.data).toEqual({});
  });
});

describe('webhookDelivery — computeBackoffMs (full-jitter, capped)', () => {
  test('0..cap base, deterministic with injected rng', () => {
    const out = computeBackoffMs(3, 1000, 60000, () => 0.5);
    // init*2^3 = 8000, cap 60000 -> base 8000; floor(0.5*(8000+1)) = 4000
    expect(out).toBe(4000);
  });

  test('capped at maxDelay for huge attempt', () => {
    for (let i = 0; i < 5; i++) {
      const v = computeBackoffMs(100, 1000, 60000, () => 0.5);
      expect(v).toBeLessThanOrEqual(60000);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test('uses Math.random when no rng and stays in range', () => {
    for (let i = 0; i < 50; i++) {
      expect(computeBackoffMs(i, 1000, 60000)).toBeGreaterThanOrEqual(0);
      expect(computeBackoffMs(i, 1000, 60000)).toBeLessThanOrEqual(60000);
    }
  });
});

describe('webhookDelivery — deliverWithRetry', () => {
  function mkHook(over) { return Object.assign({ _id: 'h1', url: 'https://example/wh', secret: 's', events: ['order.created'], active: true, retryConfig: { maxAttempts: 5, initialDelay: 1000, maxDelay: 60000 } }, over || {}); }

  test('succeeds on first attempt, no sleep, returns signature', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
    const sleep = jest.fn();
    const r = await deliverWithRetry(mkHook(), { type: 'order.created', data: { id: 1 } }, { fetchImpl, sleepImpl: sleep, rng: () => 0.1 });
    expect(r.delivered).toBe(true);
    expect(r.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(r.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe('https://example/wh');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['X-MyZubster-Signature']).toBe('sha256=' + r.signature);
    expect(call[1].headers['X-MyZubster-Event']).toBe('order.created');
  });

  test('retries up to maxAttempts on persistent HTTP failure', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 503 }));
    const sleeps = [];
    const r = await deliverWithRetry(mkHook({ retryConfig: { maxAttempts: 3, initialDelay: 100, maxDelay: 500 } }), { type: 'order.created', data: {} }, { fetchImpl, sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); }, rng: () => 0.5 });
    expect(r.delivered).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.lastError).toBe('HTTP 503');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps.length).toBe(2); // wait before attempts 2 and 3
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);
  });

  test('catches throw and reports message, keeps retrying', async () => {
    let n = 0;
    const fetchImpl = jest.fn(async () => { n++; if (n < 3) throw new Error('boom'); return { ok: true, status: 200 }; });
    const r = await deliverWithRetry(mkHook({ retryConfig: { maxAttempts: 5, initialDelay: 1, maxDelay: 2 } }), { type: 'order.created', data: {} }, { fetchImpl, sleepImpl: () => Promise.resolve(), rng: () => 0.5 });
    expect(r.delivered).toBe(true);
    expect(r.attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('inMemoryStore — CRUD + findByEvent', () => {
  let s;
  beforeEach(() => { s = createInMemoryStore(); });

  test('create defaults and keeps secret (store never strips secret)', async () => {
    const w = await s.create({ name: 'a', url: 'https://x', secret: 'top', events: ['order.created'] });
    expect(w.secret).toBe('top');
    expect(w.active).toBe(true);
    expect(w.events).toEqual(['order.created']);
    expect(w.retryConfig).toEqual({ maxAttempts: 5, initialDelay: 1000, maxDelay: 60000 });
    expect(w.id).toBeTruthy();
    expect(w._id).toBe(w.id);
    expect(w.createdAt).toBeTruthy();
  });

  test('list / findById / remove present then absent', async () => {
    let w = await s.create({ name: 'a', url: 'https://x', secret: 's' });
    const id = w.id;
    expect((await s.list()).length).toBe(1);
    expect((await s.findById(id)).url).toBe('https://x');
    expect(await s.remove(id)).toBeTruthy();
    expect(await s.findById(id)).toBeNull();
    expect(await s.remove(id)).toBeNull();
  });

  test('findByEvent filters active=false and event membership, drops unknown events', async () => {
    await s.create({ name: 'in', url: 'https://1', secret: 's', events: ['order.created'], active: true });
    await s.create({ name: 'paused', url: 'https://2', secret: 's', events: ['order.created'], active: false });
    await s.create({ name: 'other', url: 'https://3', secret: 's', events: ['order.completed'] });
    await s.create({ name: 'bad', url: 'https://4', secret: 's', events: ['order.nope'] }); // normalized to []
    const got = await s.findByEvent('order.created');
    expect(got.length).toBe(1);
    expect(got[0].name).toBe('in');
  });

  test('update partial merges and bumps updatedAt', async () => {
    const w = await s.create({ name: 'a', url: 'https://x', secret: 's' });
    const u = await s.update(w.id, { active: false, name: 'b' });
    expect(u.active).toBe(false);
    expect(u.name).toBe('b');
    expect(u.url).toBe('https://x');
  });
});

describe('validateWebhookInput + sanitize', () => {
  const good = { name: 'n', url: 'https://x', secret: 's', events: ['order.created'] };

  test('full mode flags missing required fields', () => {
    expect(validateWebhookInput({}, { partial: false })).toEqual(expect.arrayContaining([
      expect.stringMatching(/name/), expect.stringMatching(/url/), expect.stringMatching(/secret/),
    ]));
  });

  test('full mode flags bad url / unknown event / bad active / bad retry', () => {
    expect(validateWebhookInput({ ...good, url: 'ftp://x' }, { partial: false })).toEqual([expect.stringMatching(/http/)]);
    expect(validateWebhookInput({ ...good, events: ['order.bogus'] }, { partial: false })).toEqual([expect.stringMatching(/unknown event/)]);
    expect(validateWebhookInput({ ...good, active: 'yes' }, { partial: false })).toEqual([expect.stringMatching(/active/)]);
    expect(validateWebhookInput({ ...good, retryConfig: 5 }, { partial: false })).toEqual([expect.stringMatching(/retryConfig/)]);
    expect(validateWebhookInput({ ...good, retryConfig: { maxAttempts: -1 } }, { partial: false })).toEqual([expect.stringMatching(/maxAttempts/)]);
  });

  test('partial mode only validates provided fields', () => {
    expect(validateWebhookInput({ active: true }, { partial: true })).toEqual([]);
    expect(validateWebhookInput({ active: 'x' }, { partial: true })).toEqual([expect.stringMatching(/active/)]);
  });

  test('sanitize strips secret top-level, in arrays, leaves buffers', () => {
    expect(sanitize({ a: 1, secret: 'x' }).secret).toBeUndefined();
    const arr = sanitize([{ secret: 'y' }]);
    expect(arr[0].secret).toBeUndefined();
    expect(sanitize({ name: 'n' }).name).toBe('n');
  });
});

describe('webhooks/index — attachWebhooks + dispatchOrderEvent', () => {
  test('attachWebhooks mounts router at base and exposes dispatch on app.locals', () => {
    const app = { use: jest.fn(), locals: {} };
    const store = createInMemoryStore();
    const r = attachWebhooks(app, { store, base: '/api/admin/webhooks' });
    expect(r.store).toBe(store);
    expect(app.use.mock.calls[0][0]).toBe('/api/admin/webhooks');
    expect(typeof app.locals.webhooks.dispatchOrderEvent).toBe('function');
    expect(app.locals.webhooks.store).toBe(store);
  });

  test('dispatchOrderEvent fans only to active subscribed webhooks with a signed POST', async () => {
    const store = createInMemoryStore();
    await store.create({ name: 'match', url: 'https://hit', secret: 'k', events: ['order.created'], active: true });
    await store.create({ name: 'other', url: 'https://no', secret: 'k', events: ['order.completed'], active: true });
    await store.create({ name: 'paused', url: 'https://pause', secret: 'k', events: ['order.created'], active: false });
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
    const res = await dispatchOrderEvent(store, 'order.created', { id: 42 }, { fetchImpl, sleepImpl: jest.fn(), rng: () => 0.5 });
    expect(res.length).toBe(1);
    expect(res[0].url).toBe('https://hit');
    expect(res[0].delivered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://hit');
    const sig = fetchImpl.mock.calls[0][1].headers['X-MyZubster-Signature'];
    expect(sig.startsWith('sha256=')).toBe(true);
    const body = fetchImpl.mock.calls[0][1].body;
    expect(signPayload('k', body)).toBe(sig.slice('sha256='.length));
  });

  test('dispatchOrderEvent rejects unknown events', async () => {
    const store = createInMemoryStore();
    await expect(dispatchOrderEvent(store, 'order.bogus', {})).rejects.toThrow(/Unknown order event/);
  });

  test('createWebhookModule wires Model/store/connect/attach', async () => {
    const mod = createWebhookModule(mongoose, { base: '/x' });
    expect(mod.Model.modelName).toBe('Webhook');
    expect(typeof mod.attach).toBe('function');
    expect(typeof mod.dispatch).toBe('function');
    expect(typeof mod.connect).toBe('function');
  });
});

describe('orderEventBus', () => {
  test('emitOrderEvent emits "order" envelope with matching data', () => {
    const seen = [];
    const off = (ev) => bus.on('order', (env) => seen.push(env));
    off();
    const env = emitOrderEvent('order.cancelled', { id: 9 });
    expect(env.type).toBe('order.cancelled');
    expect(env.data).toEqual({ id: 9 });
    const got = seen.find((x) => x.type === 'order.cancelled');
    expect(got).toBeTruthy();
    expect(got.data).toEqual({ id: 9 });
  });

  test('emitOrderEvent throws on unknown event', () => {
    expect(() => emitOrderEvent('not.real', {})).toThrow(/Unknown order event/);
  });

  test('createOrderEventBus builds an isolated bus', () => {
    const { bus: b2, emitOrderEvent: emit2 } = createOrderEventBus();
    expect(b2).not.toBe(bus);
    const env = emit2('order.created', {});
    expect(env.type).toBe('order.created');
  });
});

// --- Router end-to-end on a loopback express server (no external network) ---
describe('admin webhooks router (HTTP end-to-end)', () => {
  let server, base, lastId;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const store = createInMemoryStore();
    attachWebhooks(app, { store, base: '/api/admin/webhooks' });
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
  });
  afterAll(() => new Promise((r) => server.close(() => r())));

  async function call(p, method, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(base + p, opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = text; }
    return { status: res.status, json };
  }

  test('POST validates and creates, omits secret', async () => {
    const r = await call('/api/admin/webhooks', 'POST', { name: 'h', url: 'https://x', secret: 'top', events: ['order.created'] });
    expect(r.status).toBe(201);
    expect(r.json.secret).toBeUndefined();
    expect(r.json.name).toBe('h');
    expect(r.json.events).toEqual(['order.created']);
    lastId = r.json.id;
  });

  test('POST 400 on invalid url', async () => {
    const r = await call('/api/admin/webhooks', 'POST', { name: 'h', url: 'not-a-url', secret: 's' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('validation_failed');
  });

  test('GET list returns sanitized array', async () => {
    const r = await call('/api/admin/webhooks', 'GET');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
    r.json.forEach((w) => expect(w.secret).toBeUndefined());
  });

  test('GET /:id present then 404', async () => {
    const r = await call('/api/admin/webhooks/' + lastId, 'GET');
    expect(r.status).toBe(200);
    expect(r.json.secret).toBeUndefined();
    const r2 = await call('/api/admin/webhooks/nope', 'GET');
    expect(r2.status).toBe(404);
  });

  test('PUT /:id partial update', async () => {
    const r = await call('/api/admin/webhooks/' + lastId, 'PUT', { active: false });
    expect(r.status).toBe(200);
    expect(r.json.active).toBe(false);
    expect(r.json.secret).toBeUndefined();
  });

  test('DELETE /:id then 404', async () => {
    const r = await call('/api/admin/webhooks/' + lastId, 'DELETE');
    expect(r.status).toBe(204);
    const r2 = await call('/api/admin/webhooks/' + lastId, 'GET');
    expect(r2.status).toBe(404);
  });
});
