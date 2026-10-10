const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const PatientCase = require('../models/PatientCase');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { normalizePhone, requireString } = require('../utils/helpers');
const { generateDoctorId, ensureDoctorId } = require('../utils/doctorId');

const router = express.Router();

const signToken = (payload, expiresIn) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });

const doctorToken = (doctor) =>
  signToken({ id: doctor.id, role: 'doctor' }, process.env.JWT_EXPIRES_IN || '7d');

const doctorPayload = (doctor) => ({
  id: doctor.id,
  name: doctor.name,
  email: doctor.email,
  phone: doctor.phone,
  role: doctor.role,
  doctorId: doctor.doctorId,
});

router.post(
  '/doctor-register',
  asyncHandler(async (req, res) => {
    const name = requireString(req.body.name, 'Name');
    const email = requireString(req.body.email, 'Email').toLowerCase();
    const password = requireString(req.body.password, 'Password');
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : undefined;

    const requiredKey = process.env.DOCTOR_REGISTRATION_KEY;
    if (requiredKey && req.body.registrationKey !== requiredKey) {
      throw new ApiError(403, 'A valid registration key is required');
    }

    if (password.length < 8) {
      throw new ApiError(400, 'Password must be at least 8 characters');
    }

    if (await User.exists({ email })) {
      throw new ApiError(409, 'An account with this email already exists');
    }

    const doctorId = await generateDoctorId();
    const doctor = await User.create({ name, email, password, phone, role: 'doctor', doctorId });

    res.status(201).json({
      success: true,
      message: 'Doctor registered successfully',
      token: doctorToken(doctor),
      user: doctorPayload(doctor),
    });
  })
);

router.post(
  '/doctor-login',
  asyncHandler(async (req, res) => {
    const email = requireString(req.body.email, 'Email').toLowerCase();
    const password = requireString(req.body.password, 'Password');

    const doctor = await User.findOne({ email, role: 'doctor' }).select('+password');
    if (!doctor || !(await doctor.comparePassword(password))) {
      throw new ApiError(401, 'Invalid email or password');
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
  '/patient-login',
  asyncHandler(async (req, res) => {
    const caseId = requireString(req.body.caseId, 'Case ID').toUpperCase();
    const phone = normalizePhone(requireString(req.body.phone, 'Phone number'));
    const otp = requireString(String(req.body.otp ?? ''), 'OTP');

    const patientCase = await PatientCase.findOne({ caseId });
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

module.exports = router;
