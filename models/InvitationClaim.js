const mongoose = require('mongoose');

/**
 * Single-use guard for invitation codes.
 *
 * The claim's _id IS the invitation's _id, so MongoDB's built-in unique _id
 * index lets exactly one insert succeed no matter how many requests race for
 * the same code. This does not rely on find-and-update atomicity, so it holds on
 * any engine that enforces unique indexes. The claim is deleted only if the
 * registration that took it fails and gives the code back.
 */
const invitationClaimSchema = new mongoose.Schema(
  { _id: { type: mongoose.Schema.Types.ObjectId, required: true } },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

module.exports = mongoose.model('InvitationClaim', invitationClaimSchema);
