const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: 120,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    role: {
      type: String,
      // 'admin' accounts can only be created by scripts/createAdmin.js; no HTTP
      // endpoint accepts a role from the client.
      enum: ['doctor', 'patient', 'admin'],
      default: 'doctor',
    },
    // Doctors registered through the invitation flow store their mobile number
    // here in E.164 form (+923001234567), the number the administrator uses for
    // the WhatsApp click-to-chat link. Older accounts may hold free-form values.
    phone: {
      type: String,
      trim: true,
    },
    // Always false today: the server cannot prove that the number belongs to the
    // doctor or has WhatsApp. Only flip this if a real verification step is added.
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    caseId: {
      type: String,
      trim: true,
      uppercase: true,
      index: true,
      sparse: true,
    },
    // Internal application identifier for doctors (e.g. DOC-1001), assigned by
    // the server. It is NOT a medical licence (PMDC) number and does not verify
    // any professional qualification. Absent for patients and for doctor
    // accounts created before this field existed (filled in on next login).
    doctorId: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true,
    },

    // ---- Doctor approval workflow -------------------------------------------
    // Deliberately NO schema default: doctor accounts created before this
    // feature have no status, and a missing status is treated as "pending" (not
    // approved) by effectiveStatus() / the approval middleware. Nobody is
    // approved implicitly; an administrator must approve each account.
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
    },
    // PMDC number as normalised by utils/pmdc.js (upper-case, no whitespace).
    // Unique across doctors. Sparse so patients, admins and legacy doctors
    // (which have no PMDC number) do not collide.
    pmdcNumber: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true,
    },
    // 'unverified' = number submitted, nobody has checked it. 'verified_by_admin'
    // is only set when an administrator explicitly confirms they checked it.
    pmdcVerificationStatus: {
      type: String,
      enum: ['unverified', 'verified_by_admin'],
    },
    hospitalName: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String, trim: true, maxlength: 500 },
    registeredWithInvitation: { type: mongoose.Schema.Types.ObjectId, ref: 'Invitation' },

    // Set when a doctor asks for a password reset so the administrator can see
    // who is waiting. Cleared when the password is reset.
    passwordResetRequestedAt: { type: Date },
    // Informational: when the password was last changed or reset.
    passwordChangedAt: { type: Date },
    // Embedded in every doctor/admin JWT (claim `tv`). Bumped on password
    // change/reset, which instantly invalidates all previously issued tokens.
    // Missing = 0, so tokens issued before this field existed stay valid.
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** Missing status (legacy accounts) counts as 'pending', never as 'approved'. */
userSchema.methods.effectiveStatus = function effectiveStatus() {
  return this.status || 'pending';
};

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  const rounds = parseInt(process.env.BCRYPT_ROUNDS, 10) || 12;
  this.password = await bcrypt.hash(this.password, rounds);
  return next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.__v;
    delete ret.passwordChangedAt;
    delete ret.tokenVersion;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
