const mongoose = require("mongoose");

const ALLOWED_EVENTS = [
  "order.created",
  "order.awaiting-payment",
  "order.payment-received",
  "order.payment-confirmed",
  "order.processing",
  "order.completed",
  "order.cancelled",
  "order.refunded",
];

const urlRegex = /^https?:\/\/.+/i;

const webhookSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "Webhook name is required"],
    trim: true,
  },
  url: {
    type: String,
    required: [true, "Webhook target URL is required"],
    trim: true,
    validate: {
      validator: function (v) {
        return urlRegex.test(v);
      },
      message: (props) => `${props.value} is not a valid HTTP/HTTPS URL`,
    },
  },
  secret: {
    type: String,
    required: [true, "Secret key for HMAC signature is required"],
  },
  events: {
    type: [String],
    required: [true, "Events array is required"],
    validate: {
      validator: function (v) {
        if (!Array.isArray(v) || v.length === 0) return false;
        return v.every((event) => ALLOWED_EVENTS.includes(event));
      },
      message: "Events array must contain at least one valid event type",
    },
  },
  active: {
    type: Boolean,
    default: true,
  },
  retryConfig: {
    maxAttempts: {
      type: Number,
      default: 5,
      min: [1, "maxAttempts must be at least 1"],
    },
    initialDelay: {
      type: Number,
      default: 1000,
      min: [0, "initialDelay cannot be negative"],
    },
    maxDelay: {
      type: Number,
      default: 60000,
      min: [0, "maxDelay cannot be negative"],
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

webhookSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Webhook", webhookSchema);
