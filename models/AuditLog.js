const mongoose = require('mongoose');

/**
 * Append-only trail of security-relevant actions. `metadata` must never hold
 * passwords, tokens or invitation codes (utils/audit.js strips known keys).
 */
const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    targetType: { type: String },
    targetId: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });

auditLogSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
