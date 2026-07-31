'use strict';

/**
 * Mongoose-backed Webhook store.
 *
 * Thin wrapper around the `Webhook` model. `secret` is `select:false` on the
 * model so the secret is never leaked via the standard `find`/`findById`
 * paths — the store exposes `findByIdWithSecret` and `findActiveForEvent`
 * for the delivery service, both of which explicitly call `.select('+secret')`.
 *
 * Both store implementations expose the same shape:
 *   create(input) -> publicView
 *   findById(id)  -> publicView | null
 *   findByIdWithSecret(id) -> fullRow | null
 *   findAll() -> publicView[]
 *   findAllWithSecrets() -> fullRow[]
 *   findActiveForEvent(eventType) -> fullRow[]
 *   update(id, patch) -> publicView | null
 *   remove(id) -> boolean
 */

const { getWebhookModel } = require('../models/Webhook');

function makeMongooseStore(mongoose) {
  if (!mongoose) {
    throw new TypeError('makeMongooseStore: mongoose instance is required');
  }

  function publicView(doc) {
    if (!doc) return null;
    const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
    delete obj.secret;
    if (obj.retryConfig) obj.retryConfig = { ...obj.retryConfig };
    return obj;
  }

  return {
    async create(input) {
      const Model = getWebhookModel(mongoose);
      const doc = await Model.create({
        name: input.name,
        url: input.url,
        secret: input.secret,
        events: Array.isArray(input.events) ? [...input.events] : [],
        active: input.active !== false,
        retryConfig: input.retryConfig || undefined,
      });
      return publicView(doc);
    },

    async findById(id) {
      const Model = getWebhookModel(mongoose);
      const doc = await Model.findById(id);
      return publicView(doc);
    },

    async findByIdWithSecret(id) {
      const Model = getWebhookModel(mongoose);
      const doc = await Model.findById(id).select('+secret');
      if (!doc) return null;
      return typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
    },

    async findAll() {
      const Model = getWebhookModel(mongoose);
      const docs = await Model.find({}).sort({ createdAt: -1 });
      return docs.map(publicView);
    },

    async findAllWithSecrets() {
      const Model = getWebhookModel(mongoose);
      const docs = await Model.find({}).select('+secret').sort({ createdAt: -1 });
      return docs.map((d) => (typeof d.toObject === 'function' ? d.toObject() : { ...d }));
    },

    async findActiveForEvent(eventType) {
      const Model = getWebhookModel(mongoose);
      const docs = await Model.find({ active: true, events: eventType })
        .select('+secret')
        .lean();
      return docs.map((d) => ({ ...d }));
    },

    async update(id, patch) {
      const Model = getWebhookModel(mongoose);
      const doc = await Model.findById(id);
      if (!doc) return null;
      if (patch && typeof patch === 'object') {
        if (typeof patch.name === 'string') doc.name = patch.name;
        if (typeof patch.url === 'string') doc.url = patch.url;
        if (typeof patch.secret === 'string' && patch.secret.length > 0) doc.secret = patch.secret;
        if (Array.isArray(patch.events)) doc.events = [...patch.events];
        if (typeof patch.active === 'boolean') doc.active = patch.active;
        if (patch.retryConfig && typeof patch.retryConfig === 'object') {
          doc.retryConfig = { ...(doc.retryConfig ? doc.retryConfig.toObject() : {}), ...patch.retryConfig };
        }
      }
      await doc.save();
      return publicView(doc);
    },

    async remove(id) {
      const Model = getWebhookModel(mongoose);
      const res = await Model.deleteOne({ _id: id });
      return Boolean(res && res.deletedCount);
    },
  };
}

module.exports = {
  makeMongooseStore,
};
