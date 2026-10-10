const Counter = require('../models/Counter');
const User = require('../models/User');

// First issued ID is DOC-1001 (counter value 1 + base 1000).
const DOCTOR_ID_PREFIX = 'DOC-';
const DOCTOR_ID_BASE = 1000;
const COUNTER_NAME = 'doctorId';

/**
 * Reserves the next Doctor ID. The increment is one atomic MongoDB
 * operation, so simultaneous registrations always get different numbers.
 * A number is never reused: if the registration that reserved it later fails,
 * that number is simply skipped.
 */
const generateDoctorId = async () => {
  let lastError;
  // Two requests upserting the very first counter at the same moment can make
  // one of them fail with a duplicate-key error; a single retry resolves it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const counter = await Counter.findOneAndUpdate(
        { _id: COUNTER_NAME },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      return `${DOCTOR_ID_PREFIX}${DOCTOR_ID_BASE + counter.seq}`;
    } catch (err) {
      if (err.code !== 11000) throw err;
      lastError = err;
    }
  }
  throw lastError;
};

/**
 * Gives an existing doctor account (created before this feature) a Doctor ID
 * the first time it is needed. Safe to call repeatedly and concurrently: the
 * write only succeeds while the account still has no ID, so an ID that has
 * been assigned is never replaced.
 */
const ensureDoctorId = async (doctor) => {
  if (doctor.doctorId) return doctor;

  const candidate = await generateDoctorId();
  const updated = await User.findOneAndUpdate(
    { _id: doctor._id, role: 'doctor', doctorId: null },
    { $set: { doctorId: candidate } },
    { new: true }
  );
  if (updated) {
    doctor.doctorId = updated.doctorId;
    return doctor;
  }

  // Another request assigned one first; use the stored value.
  const current = await User.findById(doctor._id).select('doctorId');
  doctor.doctorId = current && current.doctorId;
  return doctor;
};

module.exports = { generateDoctorId, ensureDoctorId };
