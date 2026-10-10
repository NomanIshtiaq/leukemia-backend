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
      enum: ['doctor', 'patient'],
      default: 'doctor',
    },
    phone: {
      type: String,
      trim: true,
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
  },
  { timestamps: true }
);

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
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
