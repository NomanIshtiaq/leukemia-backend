const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Invitation = require('../models/Invitation');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { requireEmail, escapeRegex } = require('../utils/helpers');
const { requireE164, toE164 } = require('../utils/phone');
const {
  buildWhatsAppUrl,
  toWhatsAppDigits,
  doctorInvitationMessage,
  passwordResetMessage,
} = require('../utils/whatsapp');
const {
  parseTtlHours,
  toMeta,
  createInvitation,
  revokeInvitation,
} = require('../utils/invitationService');
const { recordAudit } = require('../utils/audit');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

// Every route below is administrator-only. The role is read from the database by
// `protect`, so a client-supplied role (or an old token) cannot grant access.
router.use(protect, authorize('admin'));

const RESET_CODE_TTL_HOURS = 1;
const DOCTOR_STATUSES = ['pending', 'approved', 'rejected'];

const requireObjectId = (value, label) => {
  if (!mongoose.isValidObjectId(value)) throw new ApiError(404, `${label} not found`);
  return value;
};

const clampInt = (value, fallback, min, max) => {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

// Legacy doctor accounts have no status field; they are reviewed like pending ones.
const statusFilter = (status) =>
  status === 'pending'
    ? { $or: [{ status: 'pending' }, { status: { $exists: false } }, { status: null }] }
    : { status };

/** What an administrator needs to review an application. Never includes the password. */
const doctorView = (doctor) => ({
  id: doctor.id,
  name: doctor.name,
  email: doctor.email,
  phone: doctor.phone || null,
  phoneVerified: Boolean(doctor.phoneVerified), // always false: not verified by this system
  doctorId: doctor.doctorId || null,
  status: doctor.effectiveStatus(),
  pmdcNumber: doctor.pmdcNumber || null,
  pmdcVerificationStatus: doctor.pmdcVerificationStatus || 'unverified',
  hospitalName: doctor.hospitalName || null,
  reviewedBy: doctor.reviewedBy ? String(doctor.reviewedBy) : null,
  reviewedAt: doctor.reviewedAt || null,
  reviewNote: doctor.reviewNote || null,
  passwordResetRequested: Boolean(doctor.passwordResetRequestedAt),
  passwordResetRequestedAt: doctor.passwordResetRequestedAt || null,
  // WhatsApp number the doctor typed when asking for the reset code.
  passwordResetPhone: doctor.passwordResetRequestedPhone || null,
  // Registered before the approval workflow existed (no stored status).
  legacy: !doctor.status,
  registeredAt: doctor.createdAt,
});

const whatsappBlock = (phone, message) => {
  const url = buildWhatsAppUrl(phone, message);
  return url
    ? { url, number: toWhatsAppDigits(phone), message }
    : { url: null, number: null, message };
};

// ---------------------------------------------------------------------------
// Doctor applications
// ---------------------------------------------------------------------------
router.get(
  '/doctors',
  asyncHandler(async (req, res) => {
    const status = DOCTOR_STATUSES.includes(req.query.status) ? req.query.status : 'pending';
    const limit = clampInt(req.query.limit, 50, 1, 100);
    const page = clampInt(req.query.page, 1, 1, 10000);

    // "Pending" is the admin's inbox: new applications AND password reset
    // requests from approved doctors. (Reset requests also stay in "approved".)
    const filter = {
      role: 'doctor',
      ...(status === 'pending'
        ? {
            $or: [
              ...statusFilter('pending').$or,
              { status: 'approved', passwordResetRequestedAt: { $ne: null } },
            ],
          }
        : statusFilter(status)),
    };
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const pattern = new RegExp(escapeRegex(req.query.q.trim().slice(0, 80)), 'i');
      filter.$and = [{ $or: [{ name: pattern }, { email: pattern }, { pmdcNumber: pattern }] }];
    }

    const [doctors, pending, approved, rejected] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments({ role: 'doctor', ...statusFilter('pending') }),
      User.countDocuments({ role: 'doctor', status: 'approved' }),
      User.countDocuments({ role: 'doctor', status: 'rejected' }),
    ]);

    res.json({
      success: true,
      status,
      page,
      count: doctors.length,
      counts: { pending, approved, rejected },
      doctors: doctors.map(doctorView),
    });
  })
);

router.get(
  '/doctors/:id',
  asyncHandler(async (req, res) => {
    const doctor = await User.findOne({ _id: requireObjectId(req.params.id, 'Doctor'), role: 'doctor' });
    if (!doctor) throw new ApiError(404, 'Doctor not found');
    res.json({ success: true, doctor: doctorView(doctor) });
  })
);

const loadDoctor = async (id) => {
  const doctor = await User.findOne({ _id: requireObjectId(id, 'Doctor'), role: 'doctor' });
  if (!doctor) throw new ApiError(404, 'Doctor not found');
  return doctor;
};

router.post(
  '/doctors/:id/approve',
  asyncHandler(async (req, res) => {
    const doctor = await loadDoctor(req.params.id);
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    // Only true when the administrator explicitly says they checked the number.
    const pmdcChecked = req.body.pmdcChecked === true;

    if (pmdcChecked && !doctor.pmdcNumber) {
      throw new ApiError(400, 'This doctor has not submitted a PMDC number to mark as checked');
    }

    // Guarded single-document write: only moves accounts that are not already
    // approved, so two simultaneous approvals cannot both "win".
    const result = await User.updateOne(
      { _id: doctor._id, role: 'doctor', status: { $ne: 'approved' } },
      {
        $set: {
          status: 'approved',
          reviewedBy: req.user.id, // from the verified token, never from the body
          reviewedAt: new Date(),
          reviewNote: note || undefined,
          ...(pmdcChecked ? { pmdcVerificationStatus: 'verified_by_admin' } : {}),
        },
      }
    );
    if (!result.matchedCount) throw new ApiError(409, 'This doctor is already approved');
    const updated = await User.findById(doctor._id);

    await recordAudit(req, 'doctor.approve', {
      targetType: 'user',
      targetId: updated.id,
      metadata: { previousStatus: doctor.effectiveStatus(), pmdcChecked, hasNote: Boolean(note) },
    });
    res.json({ success: true, message: 'Doctor approved', doctor: doctorView(updated) });
  })
);

router.post(
  '/doctors/:id/reject',
  asyncHandler(async (req, res) => {
    const doctor = await loadDoctor(req.params.id);
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!reason) throw new ApiError(400, 'A reason is required when rejecting an application');

    const result = await User.updateOne(
      { _id: doctor._id, role: 'doctor', status: { $ne: 'rejected' } },
      {
        $set: {
          status: 'rejected',
          reviewedBy: req.user.id,
          reviewedAt: new Date(),
          reviewNote: reason,
        },
      }
    );
    if (!result.matchedCount) throw new ApiError(409, 'This doctor is already rejected');
    const updated = await User.findById(doctor._id);

    await recordAudit(req, 'doctor.reject', {
      targetType: 'user',
      targetId: updated.id,
      metadata: { previousStatus: doctor.effectiveStatus() },
    });
    res.json({ success: true, message: 'Doctor rejected', doctor: doctorView(updated) });
  })
);

// One-time password-reset code for a doctor, shared over WhatsApp like an invitation.
router.post(
  '/doctors/:id/password-reset-code',
  asyncHandler(async (req, res) => {
    const doctor = await loadDoctor(req.params.id);
    const ttlHours = parseTtlHours(req.body.expiresInHours, RESET_CODE_TTL_HOURS);

    // Send to the number the doctor gave with the request; otherwise the number
    // on file; an administrator-typed number overrides both.
    const phone =
      toE164(req.body.phone) ||
      toE164(doctor.passwordResetRequestedPhone) ||
      toE164(doctor.phone) ||
      null;

    const { invitation, code, expiresInHours } = await createInvitation({
      purpose: 'password_reset',
      email: doctor.email,
      phone,
      createdBy: req.user.id,
      ttlHours,
    });

    await recordAudit(req, 'password_reset_code.create', {
      targetType: 'user',
      targetId: doctor.id,
      metadata: { invitationId: invitation.id, expiresAt: invitation.expiresAt },
    });

    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      success: true,
      message: 'Reset code generated. It is shown only once.',
      invitation: toMeta(invitation),
      code, // the only time this plaintext value ever leaves the server
      whatsapp: whatsappBlock(phone, passwordResetMessage(code, expiresInHours)),
    });
  })
);

// ---------------------------------------------------------------------------
// Invitation codes
// ---------------------------------------------------------------------------
router.post(
  '/invitations',
  asyncHandler(async (req, res) => {
    const email = requireEmail(req.body.email);
    const ttlHours = parseTtlHours(req.body.expiresInHours);
    const hasPhone = typeof req.body.phone === 'string' && req.body.phone.trim() !== '';
    const phone = hasPhone ? requireE164(req.body.phone, 'WhatsApp number') : undefined;

    if (await User.exists({ email })) {
      throw new ApiError(409, 'An account with this email already exists', { code: 'EMAIL_EXISTS' });
    }

    const { invitation, code, expiresInHours } = await createInvitation({
      purpose: 'doctor_registration',
      email,
      phone,
      createdBy: req.user.id,
      ttlHours,
    });

    await recordAudit(req, 'invitation.create', {
      targetType: 'invitation',
      targetId: invitation.id,
      metadata: {
        intendedEmail: email,
        purpose: 'doctor_registration',
        expiresAt: invitation.expiresAt,
        hasPhone: Boolean(phone),
      },
    });

    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      success: true,
      message: 'Invitation generated. The code is shown only once; copy or share it now.',
      invitation: toMeta(invitation),
      code, // plaintext appears ONLY in this response
      expiresInHours,
      // null when no number was given: the app then offers "Copy code" only.
      whatsapp: whatsappBlock(phone, doctorInvitationMessage(code, expiresInHours)),
    });
  })
);

router.get(
  '/invitations',
  asyncHandler(async (req, res) => {
    const now = new Date();
    const filter = {};

    if (['doctor_registration', 'password_reset'].includes(req.query.purpose)) {
      filter.purpose = req.query.purpose;
    }
    switch (req.query.status) {
      case 'active':
        Object.assign(filter, { status: 'active', expiresAt: { $gt: now } });
        break;
      case 'expired':
        Object.assign(filter, { status: 'active', expiresAt: { $lte: now } });
        break;
      case 'used':
      case 'revoked':
        filter.status = req.query.status;
        break;
      default:
    }

    const limit = clampInt(req.query.limit, 50, 1, 100);
    const invitations = await Invitation.find(filter).sort({ createdAt: -1 }).limit(limit);

    res.json({ success: true, count: invitations.length, invitations: invitations.map(toMeta) });
  })
);

router.post(
  '/invitations/:id/revoke',
  asyncHandler(async (req, res) => {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
    const revoked = await revokeInvitation({
      id: requireObjectId(req.params.id, 'Invitation'),
      revokedBy: req.user.id,
      reason,
    });

    await recordAudit(req, 'invitation.revoke', {
      targetType: 'invitation',
      targetId: revoked.id,
      metadata: { purpose: revoked.purpose, intendedEmail: revoked.intendedEmail },
    });
    res.json({ success: true, message: 'Invitation revoked', invitation: toMeta(revoked) });
  })
);

// ---------------------------------------------------------------------------
// Audit trail (read-only)
// ---------------------------------------------------------------------------
router.get(
  '/audit-logs',
  asyncHandler(async (req, res) => {
    const filter = {};
    if (typeof req.query.action === 'string' && /^[a-z_.]{3,60}$/.test(req.query.action)) {
      filter.action = req.query.action;
    }
    const logs = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(clampInt(req.query.limit, 50, 1, 200));
    res.json({ success: true, count: logs.length, logs });
  })
);

module.exports = router;
