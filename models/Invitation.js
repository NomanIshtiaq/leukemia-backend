const mongoose = require('mongoose');

/**
 * One-time codes issued by an administrator:
 *   - doctor_registration: lets one specific email address apply for a doctor account
 *   - password_reset:      lets one specific doctor choose a new password
 *
 * Only a keyed hash of the code is stored (see utils/invitationCode.js), so a
 * database leak does not reveal usable codes. The plaintext code exists only in
 * the response to the administrator who generated it.
 */
const invitationSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    purpose: {
      type: String,
      enum: ['doctor_registration', 'password_reset'],
      required: true,
    },
    intendedEmail: { type: String, required: true, lowercase: true, trim: true },
    // Optional WhatsApp number (E.164) the administrator typed when generating.
    intendedPhone: { type: String, trim: true },
    // 'expired' is never stored; it is derived from expiresAt when listing.
    status: {
      type: String,
      enum: ['active', 'used', 'revoked'],
      default: 'active',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokeReason: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true }
);

invitationSchema.index({ intendedEmail: 1, purpose: 1, status: 1 });
invitationSchema.index({ createdAt: -1 });

// Never serialise the hash.
invitationSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.codeHash;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Invitation', invitationSchema);
