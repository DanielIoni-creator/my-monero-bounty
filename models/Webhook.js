'use strict';

/**
 * Mongoose Webhook model.
 *
 * Schema mirrors the field-for-field requirements of the bounty issue:
 *   name (required), url (required), secret (required, hidden from API),
 *   events (enum of the 8 order lifecycle events), active (default true),
 *   retryConfig (maxAttempts/initialDelay/maxDelay, with the same defaults
 *   the issue pins), and createdAt/updatedAt via Mongoose timestamps.
 *
 * The model is built lazily through `getWebhookModel(mongoose)` so requiring
 * this module never opens a DB connection. That keeps the admin routes and
 * the in-memory test path decoupled from the production Mongo connection.
 */

const ORDER_EVENT_TYPES = Object.freeze([
  'order.created',
  'order.awaiting-payment',
  'order.payment-received',
  'order.payment-confirmed',
  'order.processing',
  'order.completed',
  'order.cancelled',
  'order.refunded',
]);

const DEFAULT_RETRY_CONFIG = Object.freeze({
  maxAttempts: 5,
  initialDelay: 1000,
  maxDelay: 60000,
});

function buildWebhookSchema(mongoose) {
  const { Schema } = mongoose;

  const retryConfigSchema = new Schema(
    {
      maxAttempts: { type: Number, default: DEFAULT_RETRY_CONFIG.maxAttempts, min: 1 },
      initialDelay: { type: Number, default: DEFAULT_RETRY_CONFIG.initialDelay, min: 0 },
      maxDelay: { type: Number, default: DEFAULT_RETRY_CONFIG.maxDelay, min: 0 },
    },
    { _id: false }
  );

  const webhookSchema = new Schema(
    {
      name: { type: String, required: true, trim: true },
      url: { type: String, required: true, trim: true },
      secret: { type: String, required: true, select: false },
      events: [
        {
          type: String,
          enum: ORDER_EVENT_TYPES,
        },
      ],
      active: { type: Boolean, default: true },
      retryConfig: { type: retryConfigSchema, default: () => ({}) },
    },
    { timestamps: true, collection: 'webhooks' }
  );

  // Helpful compound index for "active webhooks subscribed to event X"
  webhookSchema.index({ active: 1, events: 1 });

  return webhookSchema;
}

let cachedModel = null;

function getWebhookModel(mongoose) {
  if (cachedModel) return cachedModel;
  const schema = buildWebhookSchema(mongoose);
  cachedModel = mongoose.model('Webhook', schema);
  return cachedModel;
}

function resetWebhookModelCache() {
  cachedModel = null;
}

module.exports = {
  ORDER_EVENT_TYPES,
  DEFAULT_RETRY_CONFIG,
  buildWebhookSchema,
  getWebhookModel,
  resetWebhookModelCache,
};
