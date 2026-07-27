const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const express = require("express");
const mongoose = require("mongoose");
const request = require("supertest");

const Webhook = require("../models/Webhook");
const webhookService = require("../services/webhookService");
const webhookRoutes = require("../routes/webhooks");

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/myzubster_test";

test.before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
  } catch (err) {
    // If local MongoDB is not running, tests use in-memory/mock fallback for DB-dependent operations
  }
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
});

test.beforeEach(async () => {
  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    await Webhook.deleteMany({});
  }
});

// --- 1. Mongoose Webhook Schema Validation Unit Tests ---
test("Webhook Model: creates valid webhook subscription with defaults", async (t) => {
  const data = {
    name: "Order Event Receiver",
    url: "https://example.com/webhooks/orders",
    secret: "test-secret-key-123",
    events: ["order.created", "order.completed"],
  };

  const webhook = new Webhook(data);
  const err = webhook.validateSync();
  assert.equal(err, undefined);
  assert.equal(webhook.name, "Order Event Receiver");
  assert.equal(webhook.url, "https://example.com/webhooks/orders");
  assert.equal(webhook.active, true);
  assert.equal(webhook.retryConfig.maxAttempts, 5);
  assert.equal(webhook.retryConfig.initialDelay, 1000);
  assert.equal(webhook.retryConfig.maxDelay, 60000);
});

test("Webhook Model: supports all allowed order event types", async (t) => {
  const allEvents = [
    "order.created",
    "order.awaiting-payment",
    "order.payment-received",
    "order.payment-confirmed",
    "order.processing",
    "order.completed",
    "order.cancelled",
    "order.refunded",
  ];

  const webhook = new Webhook({
    name: "All Events Listener",
    url: "https://example.com/all",
    secret: "secret-all",
    events: allEvents,
  });

  const err = webhook.validateSync();
  assert.equal(err, undefined);
});

test("Webhook Model: fails validation when required fields are missing", async (t) => {
  const webhook = new Webhook({});
  const err = webhook.validateSync();
  assert.notEqual(err, undefined);
  assert.ok(err.errors.name);
  assert.ok(err.errors.url);
  assert.ok(err.errors.secret);
  assert.ok(err.errors.events);
});

test("Webhook Model: fails validation when URL format is invalid", async (t) => {
  const invalidUrls = [
    "ftp://example.com",
    "invalid-url-format",
    "http:/missing-slash",
  ];
  for (const url of invalidUrls) {
    const webhook = new Webhook({
      name: "Test",
      url,
      secret: "secret",
      events: ["order.created"],
    });
    const err = webhook.validateSync();
    assert.notEqual(err, undefined, `URL "${url}" should fail validation`);
    assert.ok(err.errors.url);
  }
});

test("Webhook Model: fails validation when events array contains invalid event type", async (t) => {
  const webhook = new Webhook({
    name: "Test",
    url: "https://example.com/hook",
    secret: "secret",
    events: ["order.created", "invalid.event.type"],
  });
  const err = webhook.validateSync();
  assert.notEqual(err, undefined);
  assert.ok(err.errors.events);
});

test("Webhook Model: fails validation when events array is empty", async (t) => {
  const webhook = new Webhook({
    name: "Test",
    url: "https://example.com/hook",
    secret: "secret",
    events: [],
  });
  const err = webhook.validateSync();
  assert.notEqual(err, undefined);
  assert.ok(err.errors.events);
});

// --- 2. Webhook Service Unit Tests ---
test("Webhook Service: generateSignature produces deterministic 64-char hex string", async (t) => {
  const payload = { orderId: "12345", status: "created" };
  const secret = "my-super-secret-key";
  const sig1 = webhookService.generateSignature(payload, secret);
  const sig2 = webhookService.generateSignature(payload, secret);

  assert.equal(typeof sig1, "string");
  assert.equal(sig1.length, 64);
  assert.equal(/^[0-9a-f]{64}$/.test(sig1), true);
  assert.equal(sig1, sig2);

  const expected = crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
  assert.equal(sig1, expected);
});

test("Webhook Service: calculateBackoffDelay calculates exponential delays correctly", async (t) => {
  assert.equal(webhookService.calculateBackoffDelay(1, 1000, 60000), 1000);
  assert.equal(webhookService.calculateBackoffDelay(2, 1000, 60000), 2000);
  assert.equal(webhookService.calculateBackoffDelay(3, 1000, 60000), 4000);
  assert.equal(webhookService.calculateBackoffDelay(4, 1000, 60000), 8000);
  assert.equal(webhookService.calculateBackoffDelay(10, 1000, 60000), 60000);
});

test("Webhook Service: deliverToWebhook sends correct headers and payload to HTTP endpoint", async (t) => {
  let receivedHeaders = null;
  let receivedBody = null;

  const server = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    let bodyStr = "";
    req.on("data", (chunk) => {
      bodyStr += chunk;
    });
    req.on("end", () => {
      receivedBody = JSON.parse(bodyStr);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const mockUrl = `http://127.0.0.1:${port}/webhook`;

  try {
    const mockWebhook = {
      _id: "wh-123",
      url: mockUrl,
      secret: "my-webhook-secret",
      retryConfig: { maxAttempts: 1, initialDelay: 100, maxDelay: 1000 },
    };
    const payload = { orderId: "ord-999", event: "order.created" };

    const result = await webhookService.deliverToWebhook(
      mockWebhook,
      "order.created",
      payload,
    );

    assert.equal(result.success, true);
    assert.equal(result.statusCode, 200);
    assert.equal(receivedHeaders["x-webhook-event"], "order.created");
    assert.ok(receivedHeaders["x-webhook-signature"]);
    assert.equal(
      receivedHeaders["x-webhook-signature"],
      webhookService.generateSignature(payload, mockWebhook.secret),
    );
    assert.deepEqual(receivedBody, payload);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Webhook Service: deliverToWebhook retries on HTTP failure", async (t) => {
  let attemptCount = 0;

  const server = http.createServer((req, res) => {
    attemptCount++;
    if (attemptCount < 2) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server Error" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "success" }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const mockUrl = `http://127.0.0.1:${port}/webhook-retry`;

  try {
    const mockWebhook = {
      _id: "wh-retry",
      url: mockUrl,
      secret: "secret-key",
      retryConfig: { maxAttempts: 3, initialDelay: 50, maxDelay: 200 },
    };

    const result = await webhookService.deliverToWebhook(
      mockWebhook,
      "order.payment-received",
      { orderId: "ord-1" },
    );

    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(attemptCount, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Webhook Service: dispatchWebhook queries active subscriptions and dispatches", async (t) => {
  let receivedCount = 0;

  const server = http.createServer((req, res) => {
    receivedCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const mockUrl = `http://127.0.0.1:${port}/webhook-dispatch`;

  try {
    if (mongoose.connection.readyState === 1) {
      await Webhook.create([
        {
          name: "Active 1",
          url: mockUrl,
          secret: "s1",
          events: ["order.created"],
          active: true,
        },
        {
          name: "Inactive",
          url: mockUrl,
          secret: "s2",
          events: ["order.created"],
          active: false,
        },
        {
          name: "Other Event",
          url: mockUrl,
          secret: "s3",
          events: ["order.completed"],
          active: true,
        },
      ]);
    } else {
      Webhook.find = (query) => {
        const docs = [
          {
            _id: "1",
            name: "Active 1",
            url: mockUrl,
            secret: "s1",
            events: ["order.created"],
            active: true,
            retryConfig: { maxAttempts: 1, initialDelay: 10, maxDelay: 50 },
          },
        ];
        const res = Promise.resolve(docs);
        res.sort = () => Promise.resolve(docs);
        return res;
      };
    }

    const payload = { orderId: "ord-100" };
    const dispatchResult = await webhookService.dispatchWebhook(
      "order.created",
      payload,
    );

    assert.equal(dispatchResult.dispatchedCount, 1);
    assert.equal(dispatchResult.event, "order.created");
    assert.equal(dispatchResult.results.length, 1);
    assert.equal(dispatchResult.results[0].success, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- 3. Express Admin RESTful Webhook Router CRUD Tests ---
test("Admin Webhook API: Full CRUD Endpoints", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/webhooks", webhookRoutes);

  let createdId = null;

  if (mongoose.connection.readyState !== 1) {
    const store = new Map();
    Webhook.prototype.save = async function () {
      const err = this.validateSync();
      if (err) throw err;
      const id = new mongoose.Types.ObjectId().toString();
      this._id = id;
      store.set(id, this.toObject ? this.toObject() : this);
      return this;
    };
    Webhook.find = (query) => {
      const docs = Array.from(store.values());
      const res = Promise.resolve(docs);
      res.sort = () => Promise.resolve(docs);
      return res;
    };
    Webhook.findById = async (id) => store.get(id) || null;
    Webhook.findByIdAndUpdate = async (id, update) => {
      const item = store.get(id);
      if (!item) return null;
      if (
        update.$set &&
        update.$set.url &&
        !/^https?:\/\/.+/i.test(update.$set.url)
      ) {
        throw new Error("Invalid URL");
      }
      Object.assign(item, update.$set || update);
      store.set(id, item);
      return item;
    };
    Webhook.findByIdAndDelete = async (id) => {
      const item = store.get(id);
      if (!item) return null;
      store.delete(id);
      return item;
    };
  }

  // 1. POST /api/admin/webhooks (Create)
  const createPayload = {
    name: "Main Admin Webhook",
    url: "https://example.com/webhook/admin",
    secret: "top-secret-key-1",
    events: ["order.created", "order.completed"],
    active: true,
    retryConfig: {
      maxAttempts: 3,
      initialDelay: 500,
      maxDelay: 10000,
    },
  };

  const createRes = await request(app)
    .post("/api/admin/webhooks")
    .send(createPayload);

  assert.equal(createRes.status, 201);
  assert.ok(createRes.body._id);
  assert.equal(createRes.body.name, createPayload.name);
  assert.equal(createRes.body.url, createPayload.url);
  assert.equal(createRes.body.retryConfig.maxAttempts, 3);

  createdId = createRes.body._id;

  // Test Invalid POST (400)
  const badPostRes = await request(app)
    .post("/api/admin/webhooks")
    .send({ name: "Short Payload" });
  assert.equal(badPostRes.status, 400);

  // 2. GET /api/admin/webhooks (List)
  const listRes = await request(app).get("/api/admin/webhooks");
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body));
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0]._id, createdId);

  // 3. GET /api/admin/webhooks/:id (Get Single)
  const getSingleRes = await request(app).get(
    `/api/admin/webhooks/${createdId}`,
  );
  assert.equal(getSingleRes.status, 200);
  assert.equal(getSingleRes.body._id, createdId);

  // GET Invalid ID format (400)
  const getBadIdRes = await request(app).get(
    "/api/admin/webhooks/invalid-object-id",
  );
  assert.equal(getBadIdRes.status, 400);

  // GET Non-existent ID (404)
  const fakeId = new mongoose.Types.ObjectId().toString();
  const getNotFoundRes = await request(app).get(
    `/api/admin/webhooks/${fakeId}`,
  );
  assert.equal(getNotFoundRes.status, 404);

  // 4. PUT /api/admin/webhooks/:id (Update)
  const updateRes = await request(app)
    .put(`/api/admin/webhooks/${createdId}`)
    .send({ name: "Updated Webhook Name", active: false });

  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.name, "Updated Webhook Name");
  assert.equal(updateRes.body.active, false);

  // PUT Invalid update (400)
  const badPutRes = await request(app)
    .put(`/api/admin/webhooks/${createdId}`)
    .send({ url: "not-a-valid-url" });
  assert.equal(badPutRes.status, 400);

  // PUT Non-existent ID (404)
  const putNotFoundRes = await request(app)
    .put(`/api/admin/webhooks/${fakeId}`)
    .send({ name: "Ghost Webhook" });
  assert.equal(putNotFoundRes.status, 404);

  // 5. DELETE /api/admin/webhooks/:id (Delete)
  const deleteRes = await request(app).delete(
    `/api/admin/webhooks/${createdId}`,
  );
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.id, createdId);

  // Verify deleted (404 on subsequent get)
  const verifyDeleteRes = await request(app).get(
    `/api/admin/webhooks/${createdId}`,
  );
  assert.equal(verifyDeleteRes.status, 404);

  // DELETE Invalid ID format (400)
  const deleteBadIdRes = await request(app).delete(
    "/api/admin/webhooks/bad-id-123",
  );
  assert.equal(deleteBadIdRes.status, 400);

  // DELETE Non-existent ID (404)
  const deleteNotFoundRes = await request(app).delete(
    `/api/admin/webhooks/${fakeId}`,
  );
  assert.equal(deleteNotFoundRes.status, 404);
});
