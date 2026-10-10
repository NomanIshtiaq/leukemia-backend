require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const { ensureDoctorId } = require('../utils/doctorId');

// One-off (and safe to re-run): gives every existing doctor without a Doctor ID
// one, oldest account first. Doctors that already have an ID are untouched.
const run = async () => {
  await connectDB();
  await User.init(); // make sure the unique index on doctorId exists

  const doctors = await User.find({ role: 'doctor', doctorId: null }).sort({ createdAt: 1 });
  console.log(`Doctors without an ID: ${doctors.length}`);

  for (const doctor of doctors) {
    await ensureDoctorId(doctor);
    console.log(`  ${doctor.email} -> ${doctor.doctorId}`);
  }
  console.log('Done.');
};

run()
  .catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
