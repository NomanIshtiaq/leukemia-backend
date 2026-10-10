const mongoose = require('mongoose');

/**
 * Generic atomic counter. One document per named sequence (for example
 * `doctorId`). Incremented with a single `$inc`, so concurrent requests can
 * never receive the same number.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Counter', counterSchema);
