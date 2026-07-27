const crypto = require('crypto');
const fetch = require('node-fetch');

let webhooks = [];

const loadWebhooks = async (db) => {
  webhooks = await db.collection('webhooks').find({ active: true }).toArray();
};

const registerWebhook = async (db, { url, events, secret }) => {
  const doc = { url, events: events || ['order.*'], secret: secret || crypto.randomBytes(16).toString('hex'), active: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await db.collection('webhooks').insertOne(doc);
  webhooks.push(doc);
  return { id: result.insertedId, url, events: doc.events };
};

const fireWebhook = async (event, data) => {
  const matching = webhooks.filter(w => w.events.some(e => event.match(new RegExp('^' + e.replace('*','.*') + '$'))));
  const results = await Promise.allSettled(matching.map(async (w) => {
    const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    const signature = crypto.createHmac('sha256', w.secret).update(payload).digest('hex');
    const resp = await fetch(w.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature },
      body: payload,
      timeout: 10000,
    });
    return { url: w.url, status: resp.status, ok: resp.ok };
  }));
  return results.map((r, i) => r.status === 'fulfilled' ? r.value : { url: matching[i]?.url, error: r.reason?.message });
};

const triggerOrderEvent = async (db, event, order) => {
  const events = { 'order.created': 'Order created', 'order.confirmed': 'Payment confirmed', 'order.completed': 'Tokens minted', 'order.cancelled': 'Order cancelled' };
  await fireWebhook(event, { orderId: order._id, type: event, description: events[event] || event, order });
};

module.exports = { loadWebhooks, registerWebhook, fireWebhook, triggerOrderEvent };
