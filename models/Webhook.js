'use strict';
// Mongoose model + event catalog for the order-event webhook system (bounty #5).
// The model is compiled lazily via getWebhookModel() so requiring this module
// never attempts a live DB connection (keeps unit tests pure).

const ORDER_EVENTS = [
  'order.created',
  'order.awaiting-payment',
  'order.payment-received',
  'order.payment-confirmed',
  'order.processing',
  'order.completed',
  'order.cancelled',
  'order.refunded',
];

const DEFAULTS = {
  active: true,
  events: [],
  retryConfig: { maxAttempts: 5, initialDelay: 1000, maxDelay: 60000 },
};

// Fields exactly as specified by the bounty issue (Webhook model). `secret` is
// marked select:false so it is excluded from query results by default.
const webhookSchemaFields = {
  name: { type: String, required: true, trim: true },
  url: { type: String, required: true, trim: true },
  secret: { type: String, required: true, select: false },
  events: { type: [{ type: String, enum: ORDER_EVENTS }], default: [] },
  active: { type: Boolean, default: true },
  retryConfig: {
    maxAttempts: { type: Number, default: 5 },
    initialDelay: { type: Number, default: 1000 },
    maxDelay: { type: Number, default: 60000 },
  },
};

let _model = null;
function getWebhookModel(mongoose) {
  if (_model) return _model;
  const schema = new mongoose.Schema(webhookSchemaFields, { timestamps: true });
  _model = mongoose.model('Webhook', schema);
  return _model;
}

module.exports = { ORDER_EVENTS, DEFAULTS, webhookSchemaFields, getWebhookModel };
