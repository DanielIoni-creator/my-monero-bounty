'use strict';

const express = require('express');
const { ORDER_EVENT_TYPES } = require('../../models/Webhook');

const VALID_EVENTS = new Set(ORDER_EVENT_TYPES);

function badRequest(res, message, details) {
  return res.status(400).json({ error: 'bad_request', message, ...(details ? { details } : {}) });
}

function notFound(res, message = 'webhook not found') {
  return res.status(404).json({ error: 'not_found', message });
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidUrl(v) {
  if (!isNonEmptyString(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_err) {
    return false;
  }
}

function validateSecret(v, { required }) {
  if (v === undefined || v === null) {
    return required ? 'secret is required' : null;
  }
  if (typeof v !== 'string' || v.length < 8) {
    return 'secret must be a string of at least 8 characters';
  }
  return null;
}

function validateEvents(v) {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return 'events must be an array';
  for (const e of v) {
    if (typeof e !== 'string' || !VALID_EVENTS.has(e)) {
      return `events contains invalid value "${String(e)}"`;
    }
  }
  return null;
}

function validateRetryConfig(v) {
  if (v === undefined) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return 'retryConfig must be an object';
  }
  if (v.maxAttempts !== undefined && (!Number.isInteger(v.maxAttempts) || v.maxAttempts < 1)) {
    return 'retryConfig.maxAttempts must be a positive integer';
  }
  if (v.initialDelay !== undefined && (typeof v.initialDelay !== 'number' || v.initialDelay < 0)) {
    return 'retryConfig.initialDelay must be a non-negative number';
  }
  if (v.maxDelay !== undefined && (typeof v.maxDelay !== 'number' || v.maxDelay < 0)) {
    return 'retryConfig.maxDelay must be a non-negative number';
  }
  return null;
}

function validateCreateBody(body) {
  if (!body || typeof body !== 'object') return 'request body must be an object';
  if (!isNonEmptyString(body.name)) return 'name is required';
  if (!isValidUrl(body.url)) return 'url is required and must be a valid http(s) URL';
  const secretErr = validateSecret(body.secret, { required: true });
  if (secretErr) return secretErr;
  const eventsErr = validateEvents(body.events);
  if (eventsErr) return eventsErr;
  const rcErr = validateRetryConfig(body.retryConfig);
  if (rcErr) return rcErr;
  if (body.active !== undefined && typeof body.active !== 'boolean') {
    return 'active must be a boolean';
  }
  return null;
}

function validateUpdateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'request body must be an object';
  }
  if (body.name !== undefined && !isNonEmptyString(body.name)) {
    return 'name must be a non-empty string';
  }
  if (body.url !== undefined && !isValidUrl(body.url)) {
    return 'url must be a valid http(s) URL';
  }
  const secretErr = validateSecret(body.secret, { required: false });
  if (secretErr) return secretErr;
  const eventsErr = validateEvents(body.events);
  if (eventsErr) return eventsErr;
  const rcErr = validateRetryConfig(body.retryConfig);
  if (rcErr) return rcErr;
  if (body.active !== undefined && typeof body.active !== 'boolean') {
    return 'active must be a boolean';
  }
  return null;
}

function buildAdminWebhooksRouter({ store } = {}) {
  if (!store) {
    throw new TypeError('buildAdminWebhooksRouter: store is required');
  }

  const router = express.Router();

  // POST /api/admin/webhooks — create
  router.post('/webhooks', async (req, res, next) => {
    try {
      const err = validateCreateBody(req.body);
      if (err) return badRequest(res, err);
      const created = await store.create({
        name: req.body.name,
        url: req.body.url,
        secret: req.body.secret,
        events: req.body.events || [],
        active: req.body.active,
        retryConfig: req.body.retryConfig,
      });
      return res.status(201).json(created);
    } catch (e) {
      return next(e);
    }
  });

  // GET /api/admin/webhooks — list
  router.get('/webhooks', async (_req, res, next) => {
    try {
      const rows = await store.findAll();
      return res.json(rows);
    } catch (e) {
      return next(e);
    }
  });

  // GET /api/admin/webhooks/:id
  router.get('/webhooks/:id', async (req, res, next) => {
    try {
      const row = await store.findById(req.params.id);
      if (!row) return notFound(res);
      return res.json(row);
    } catch (e) {
      return next(e);
    }
  });

  // PUT /api/admin/webhooks/:id — partial update
  router.put('/webhooks/:id', async (req, res, next) => {
    try {
      const err = validateUpdateBody(req.body);
      if (err) return badRequest(res, err);
      const updated = await store.update(req.params.id, req.body);
      if (!updated) return notFound(res);
      return res.json(updated);
    } catch (e) {
      return next(e);
    }
  });

  // DELETE /api/admin/webhooks/:id
  router.delete('/webhooks/:id', async (req, res, next) => {
    try {
      const removed = await store.remove(req.params.id);
      if (!removed) return notFound(res);
      return res.status(204).end();
    } catch (e) {
      return next(e);
    }
  });

  return router;
}

module.exports = {
  buildAdminWebhooksRouter,
  // exported for tests
  validateCreateBody,
  validateUpdateBody,
  ORDER_EVENT_TYPES,
};
