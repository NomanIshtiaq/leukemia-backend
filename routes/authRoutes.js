const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const PatientCase = require('../models/PatientCase');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const {
  normalizePhone,
  requireString,
  requireEmail,
  validateNewPassword,
} = require('../utils/helpers');
const { requireE164 } = require('../utils/phone');
const { requirePmdc } = require('../utils/pmdc');
const { generateDoctorId, ensureDoctorId } = require('../utils/doctorId');
const {
  consumeInvitation,
  attachUser,
  releaseInvitation,
} = require('../utils/invitationService');
const { recordAudit } = require('../utils/audit');
const { protect, authorize, requireApprovedDoctor, STATUS_BLOCK } = require('../middleware/authMiddleware');
const { buildLimiters } = require('../middleware/rateLimiters');

const router = express.Router();
const { loginLimiters } = buildLimiters();

const signToken = (payload, expiresIn) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });

const doctorToken = (doctor) =>
  signToken(
    { id: doctor.id, role: 'doctor', tv: doctor.tokenVersion || 0 },
    process.env.JWT_EXPIRES_IN || '7d'
  );

const adminToken = (admin) =>
  signToken(
    { id: admin.id, role: 'admin', tv: admin.tokenVersion || 0 },
    process.env.ADMIN_JWT_EXPIRES_IN || '8h'
  );

// A well-formed bcrypt hash of a random value. Comparing against it when the
// email is unknown keeps "no such account" and "wrong password" equally slow.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const doctorPayload = (doctor) => ({
  id: doctor.id,
  name: doctor.name,
  email: doctor.email,
  phone: doctor.phone,
  phoneVerified: Boolean(doctor.phoneVerified),
  role: doctor.role,
  doctorId: doctor.doctorId,
  status: doctor.effectiveStatus(),
  pmdcNumber: doctor.pmdcNumber || null,
  pmdcVerificationStatus: doctor.pmdcVerificationStatus || 'unverified',
  hospitalName: doctor.hospitalName || null,
});

const adminPayload = (admin) => ({
  id: admin.id,
  name: admin.name,
  email: admin.email,
  role: 'admin',
});

const maxLength = (value, max, field) => {
  if (value.length > max) throw new ApiError(400, `${field} must be at most ${max} characters`);
  return value;
};

/** Turns a duplicate-key error from User.create into a precise 409. */
const duplicateAccountError = (err) => {
  const fields = Object.keys(err.keyPattern || err.keyValue || {});
  if (fields.includes('pmdcNumber')) {
    return new ApiError(409, 'A doctor with this PMDC registration number is already registered', {
      code: 'PMDC_EXISTS',
    });
  }
  if (fields.includes('email')) {
    return new ApiError(409, 'An account with this email already exists', { code: 'EMAIL_EXISTS' });
  }
  return new ApiError(409, 'A record with these details already exists');
};

// ---------------------------------------------------------------------------
// Doctor registration (invitation required, account starts as "pending")
// ---------------------------------------------------------------------------
router.post(
  '/doctor-register',
  ...loginLimiters,
  asyncHandler(async (req, res) => {
    const body = req.body || {};

    // Validate everything first so a typo never touches the invitation code.
    // Role, status and verification fields in the body are never read.
    const name = maxLength(requireString(body.name, 'Name'), 120, 'Name');
    const email = requireEmail(body.email);
    const password = validateNewPassword(body.password);
    const phone = requireE164(body.phone);
    const pmdcNumber = requirePmdc(body.pmdcNumber);
    const hospitalName = maxLength(
      requireString(body.hospitalName, 'Hospital or clinic name'),
      160,
      'Hospital or clinic name'
    );
    const invitationCode = requireString(body.invitationCode, 'Invitation code');

    // 1. Atomically consume the one-time code (fails if invalid, expired,
    //    revoked, already used, or issued to a different email).
    const invitation = await consumeInvitation({
      code: invitationCode,
      purpose: 'doctor_registration',
      email,
    });

    // 2. Create the account. If anything fails, give the code back so the
    //    applicant can retry. Duplicate checks run only after the code is
    //    proven valid, so this endpoint cannot be used to probe which emails
    //    or PMDC numbers exist.
    let doctor;
    try {
      if (await User.exists({ email })) {
        throw new ApiError(409, 'An account with this email already exists', { code: 'EMAIL_EXISTS' });
      }
      if (await User.exists({ pmdcNumber })) {
        throw new ApiError(
          409,
          'A doctor with this PMDC registration number is already registered',
          { code: 'PMDC_EXISTS' }
        );
      }

      const doctorId = await generateDoctorId();
      doctor = await User.create({
        name,
        email,
        password,
        phone,
        phoneVerified: false,
        role: 'doctor',
        doctorId,
        status: 'pending', // always: the invitation authorises applying, not access
        pmdcNumber,
        pmdcVerificationStatus: 'unverified',
        hospitalName,
        registeredWithInvitation: invitation._id,
      });
    } catch (err) {
      await releaseInvitation(invitation);
      throw err.code === 11000 ? duplicateAccountError(err) : err;
    }

    try {
      await attachUser(invitation._id, doctor._id);
    } catch (err) {
      console.error(`[invitation] could not link invitation ${invitation.id} to its account: ${err.message}`);
    }
    await recordAudit(req, 'doctor.register', {
      actorId: doctor.id,
      actorRole: 'doctor',
      targetType: 'user',
      targetId: doctor.id,
      metadata: { invitationId: invitation.id, pmdcVerification: 'unverified' },
    });

    // No token: the doctor cannot sign in until an administrator approves.
    res.status(201).json({
      success: true,
      message:
        'Application submitted. An administrator will review your credentials; you can sign in once it is approved.',
      status: 'pending',
      user: doctorPayload(doctor),
    });
  })
);

// ---------------------------------------------------------------------------
// Logins
// ---------------------------------------------------------------------------
router.post(
  '/doctor-login',
  ...loginLimiters,
  asyncHandler(async (req, res) => {
    const email = requireEmail(req.body.email);
    const password = requireString(req.body.password, 'Password');

    const doctor = await User.findOne({ email, role: 'doctor' }).select('+password');
    if (!doctor) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw new ApiError(401, 'Invalid email or password');
    }
    if (!(await doctor.comparePassword(password))) {
      throw new ApiError(401, 'Invalid email or password');
    }

    // The password is correct, so it is now safe to say where the application
    // stands. No token is issued until the account is approved.
    const status = doctor.effectiveStatus();
    if (status !== 'approved') {
      const [code, message] = STATUS_BLOCK[status] || STATUS_BLOCK.pending;
      throw new ApiError(403, message, {
        code,
        details: { status, ...(status === 'rejected' && doctor.reviewNote ? { reason: doctor.reviewNote } : {}) },
      });
    }

    // Accounts registered before Doctor IDs existed get theirs on first login.
    await ensureDoctorId(doctor);

    res.json({
      success: true,
      token: doctorToken(doctor),
      user: doctorPayload(doctor),
    });
  })
);

router.post(
  '/admin-login',
  ...loginLimiters,
  asyncHandler(async (req, res) => {
    const email = requireEmail(req.body.email);
    const password = requireString(req.body.password, 'Password');

    const admin = await User.findOne({ email, role: 'admin' }).select('+password');
    if (!admin) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw new ApiError(401, 'Invalid email or password');
    }
    if (!(await admin.comparePassword(password))) {
      await recordAudit(req, 'admin.login_failed', { actorId: admin.id, actorRole: 'admin', targetType: 'user', targetId: admin.id });
      throw new ApiError(401, 'Invalid email or password');
    }

    await recordAudit(req, 'admin.login', { actorId: admin.id, actorRole: 'admin', targetType: 'user', targetId: admin.id });
    res.json({ success: true, token: adminToken(admin), user: adminPayload(admin) });
  })
);

router.post(
  '/patient-login',
  ...loginLimiters,
  asyncHandler(async (req, res) => {
    const caseId = requireString(req.body.caseId, 'Case ID').toUpperCase();
    const phone = normalizePhone(requireString(req.body.phone, 'Phone number'));
    const otp = requireString(String(req.body.otp ?? ''), 'OTP');

    // Archived cases are hidden from patients as well as from the doctor's list.
    const patientCase = await PatientCase.findOne({ caseId, archivedAt: null });
    const credentialsMatch =
      patientCase && normalizePhone(patientCase.phone) === phone;

    if (!credentialsMatch) {
      throw new ApiError(401, 'Case ID and phone number do not match any record');
    }

    if (otp !== (process.env.MOCK_OTP || '123456')) {
      throw new ApiError(401, 'Invalid OTP');
    }

    const token = signToken(
      { id: patientCase.id, role: 'patient', caseId: patientCase.caseId },
      process.env.PATIENT_JWT_EXPIRES_IN || '2h'
    );

    res.json({
      success: true,
      token,
      user: {
        id: patientCase.id,
        name: patientCase.patientName,
        role: 'patient',
        caseId: patientCase.caseId,
        phone: patientCase.phone,
      },
    });
  })
);

// ---------------------------------------------------------------------------
// Session / account management
// ---------------------------------------------------------------------------

// Lets the app validate a stored token on start-up and read the live account
// status (a pending or rejected doctor still gets an answer here).
router.get(
  '/me',
  protect,
  asyncHandler(async (req, res) => {
    if (req.user.role === 'patient') {
      return res.json({
        success: true,
        user: { id: req.user.id, role: 'patient', caseId: req.user.caseId },
      });
    }
    const account = await User.findById(req.user.id);
    return res.json({
      success: true,
      user: account.role === 'admin' ? adminPayload(account) : doctorPayload(account),
    });
  })
);

router.post(
  '/change-password',
  protect,
  authorize('doctor', 'admin'),
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    const currentPassword = requireString(req.body.currentPassword, 'Current password');
    const newPassword = validateNewPassword(req.body.newPassword, 'New password');

    const account = await User.findById(req.user.id).select('+password');
    // 400, not 401: a 401 makes the app think the session expired and sign out.
    if (!account || !(await account.comparePassword(currentPassword))) {
      throw new ApiError(400, 'Current password is incorrect');
    }
    if (currentPassword === newPassword) {
      throw new ApiError(400, 'New password must be different from the current password');
    }

    account.password = newPassword;
    account.passwordChangedAt = new Date();
    account.tokenVersion = (account.tokenVersion || 0) + 1; // revokes every older token
    await account.save();
    await recordAudit(req, 'auth.password_changed', { targetType: 'user', targetId: account.id });

    // Older tokens stop working; hand back a fresh one so this session carries on.
    const token = account.role === 'admin' ? adminToken(account) : doctorToken(account);
    res.json({ success: true, message: 'Password updated', token });
  })
);

// Password reset without e-mail or SMS: the doctor asks with their email and
// WhatsApp number, the administrator sees a "Password reset request" in the
// Pending list, generates a one-time reset code and sends it to that WhatsApp
// number (admin routes), and the doctor redeems it here.
router.post(
  '/forgot-password',
  ...loginLimiters,
  asyncHandler(async (req, res) => {
    const email = requireEmail(req.body.email);
    // Optional here so older app versions keep working. A badly formatted number
    // says nothing about whether an account exists.
    const hasPhone = typeof req.body.phone === 'string' && req.body.phone.trim() !== '';
    const phone = hasPhone ? requireE164(req.body.phone, 'WhatsApp number') : null;

    const result = await User.updateOne(
      { email, role: 'doctor' },
      {
        $set: {
          passwordResetRequestedAt: new Date(),
          ...(phone ? { passwordResetRequestedPhone: phone } : {}),
        },
      }
    );
    if (result.matchedCount) {
      await recordAudit(req, 'auth.password_reset_requested', { targetType: 'email', targetId: email });
    }

    // Identical answer whether or not the account exists.
    res.json({
      success: true,
      message:
        'If a doctor account exists for this email, the administrator has been notified and will send you a reset code on WhatsApp.',
    });
  })
);

router.post(
  '/reset-password',
  ...loginLimiters,
  asyncHandler(async (req, res) => {
    const email = requireEmail(req.body.email);
    const code = requireString(req.body.code, 'Reset code');
    const newPassword = validateNewPassword(req.body.newPassword, 'New password');

    const invitation = await consumeInvitation({ code, purpose: 'password_reset', email });

    let doctor;
    try {
      doctor = await User.findOne({ email, role: 'doctor' }).select('+password');
      if (!doctor) throw new ApiError(404, 'Account not found');
      doctor.password = newPassword;
      doctor.passwordChangedAt = new Date();
      doctor.tokenVersion = (doctor.tokenVersion || 0) + 1; // revokes every older token
      doctor.passwordResetRequestedAt = undefined;
      doctor.passwordResetRequestedPhone = undefined;
      await doctor.save();
    } catch (err) {
      await releaseInvitation(invitation);
      throw err;
    }

    try {
      await attachUser(invitation._id, doctor._id);
    } catch (err) {
      console.error(`[invitation] could not link reset ${invitation.id}: ${err.message}`);
    }
    await recordAudit(req, 'auth.password_reset', {
      actorId: doctor.id,
      actorRole: 'doctor',
      targetType: 'user',
      targetId: doctor.id,
      metadata: { invitationId: invitation.id },
    });

    res.json({ success: true, message: 'Password updated. Please sign in with your new password.' });
  })
);

module.exports = router;
