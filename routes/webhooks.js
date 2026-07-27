const express = require("express");
const mongoose = require("mongoose");
const Webhook = require("../models/Webhook");

const router = express.Router();

// Helper to validate ObjectId format
function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// POST /api/admin/webhooks - Create subscription
router.post("/", async (req, res) => {
  try {
    const webhook = new Webhook(req.body);
    const savedWebhook = await webhook.save();
    return res.status(201).json(savedWebhook);
  } catch (err) {
    return res.status(400).json({
      error: err.message,
      details: err.errors
        ? Object.keys(err.errors).map((key) => err.errors[key].message)
        : [],
    });
  }
});

// GET /api/admin/webhooks - List subscriptions
router.get("/", async (req, res) => {
  try {
    const webhooks = await Webhook.find({}).sort({ createdAt: -1 });
    return res.status(200).json(webhooks);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/webhooks/:id - Get subscription by ID
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid Webhook ID format" });
  }

  try {
    const webhook = await Webhook.findById(id);
    if (!webhook) {
      return res.status(404).json({ error: "Webhook not found" });
    }
    return res.status(200).json(webhook);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/webhooks/:id - Update subscription
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid Webhook ID format" });
  }

  try {
    const updatedWebhook = await Webhook.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true, runValidators: true },
    );

    if (!updatedWebhook) {
      return res.status(404).json({ error: "Webhook not found" });
    }

    return res.status(200).json(updatedWebhook);
  } catch (err) {
    return res.status(400).json({
      error: err.message,
      details: err.errors
        ? Object.keys(err.errors).map((key) => err.errors[key].message)
        : [],
    });
  }
});

// DELETE /api/admin/webhooks/:id - Delete subscription
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid Webhook ID format" });
  }

  try {
    const deletedWebhook = await Webhook.findByIdAndDelete(id);
    if (!deletedWebhook) {
      return res.status(404).json({ error: "Webhook not found" });
    }
    return res.status(200).json({
      message: "Webhook deleted successfully",
      id: deletedWebhook._id,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
