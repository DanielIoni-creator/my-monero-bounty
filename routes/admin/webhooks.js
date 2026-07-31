'use strict';
// Admin CRUD router for webhooks: POST/GET/PUT/DELETE /api/admin/webhooks[/:id]
const { Router } = require('express');
const { ORDER_EVENTS } = require('../../models/Webhook');

function isUrl(v) {
  try { const u = new URL(String(v)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; }
}

function validateWebhookInput(body, opts) {
  const partial = !!(opts && opts.partial);
  const errors = [];
  const has = (f) => body && body[f] !== undefined;
  const need = (f) => !partial || has(f);

  if (need('name') && (typeof body.name !== 'string' || !body.name.trim())) errors.push('name is required and must be a non-empty string');
  if (need('url') && !isUrl(body.url)) errors.push('url is required and must be an http(s) URL');
  if (need('secret') && (typeof body.secret !== 'string' || body.secret.length === 0)) errors.push('secret is required and must be a non-empty string');
  if (has('events')) {
    if (!Array.isArray(body.events)) errors.push('events must be an array');
    else {
      const invalid = body.events.filter((e) => !ORDER_EVENTS.includes(e));
      if (invalid.length) errors.push('events contains unknown event(s): ' + invalid.join(', '));
    }
  }
  if (has('active') && typeof body.active !== 'boolean') errors.push('active must be a boolean');
  if (has('retryConfig')) {
    const rc = body.retryConfig;
    if (typeof rc !== 'object' || rc === null) errors.push('retryConfig must be an object');
    else for (const k of ['maxAttempts', 'initialDelay', 'maxDelay']) {
      if (rc[k] !== undefined && (typeof rc[k] !== 'number' || rc[k] < 0 || !Number.isFinite(rc[k]))) errors.push('retryConfig.' + k + ' must be a finite non-negative number');
    }
  }
  return errors;
}

// Never echo the shared secret back in API responses.
function sanitize(w) {
  if (w && typeof w === 'object' && !Buffer.isBuffer(w)) {
    const c = Array.isArray(w) ? w.map(sanitize) : Object.assign({}, w);
    delete c.secret;
    return c;
  }
  return w;
}

function createWebhookRouter({ store } = {}) {
  if (!store) throw new Error('createWebhookRouter requires a store');
  const router = Router();

  router.post('/', async (req, res) => {
    const errs = validateWebhookInput(req.body || {}, { partial: false });
    if (errs.length) return res.status(400).json({ error: 'validation_failed', details: errs });
    try { return res.status(201).json(sanitize(await store.create(req.body))); }
    catch (e) { return res.status(503).json({ error: 'webhook_store_unavailable', detail: String((e && e.message) || e) }); }
  });

  router.get('/', async (req, res) => {
    try { return res.json(sanitize(await store.list())); }
    catch (e) { return res.status(503).json({ error: 'webhook_store_unavailable', detail: String((e && e.message) || e) }); }
  });

  router.get('/:id', async (req, res) => {
    try { const w = await store.findById(req.params.id); if (!w) return res.status(404).json({ error: 'not_found' }); return res.json(sanitize(w)); }
    catch (e) { return res.status(503).json({ error: 'webhook_store_unavailable', detail: String((e && e.message) || e) }); }
  });

  router.put('/:id', async (req, res) => {
    const errs = validateWebhookInput(req.body || {}, { partial: true });
    if (errs.length) return res.status(400).json({ error: 'validation_failed', details: errs });
    try { const w = await store.update(req.params.id, req.body); if (!w) return res.status(404).json({ error: 'not_found' }); return res.json(sanitize(w)); }
    catch (e) { return res.status(503).json({ error: 'webhook_store_unavailable', detail: String((e && e.message) || e) }); }
  });

  router.delete('/:id', async (req, res) => {
    try { const w = await store.remove(req.params.id); if (!w) return res.status(404).json({ error: 'not_found' }); return res.status(204).end(); }
    catch (e) { return res.status(503).json({ error: 'webhook_store_unavailable', detail: String((e && e.message) || e) }); }
  });

  return router;
}

module.exports = { createWebhookRouter, validateWebhookInput, sanitize, ORDER_EVENTS };
