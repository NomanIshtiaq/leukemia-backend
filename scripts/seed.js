require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const PatientCase = require('../models/PatientCase');
const { analyse } = require('../utils/riskEngine');

const doctorData = {
  name: process.env.SEED_DOCTOR_NAME || 'Dr. Ayesha Khan',
  email: (process.env.SEED_DOCTOR_EMAIL || 'doctor@leukemia.test').toLowerCase(),
  password: process.env.SEED_DOCTOR_PASSWORD || 'Doctor@12345',
  phone: process.env.SEED_DOCTOR_PHONE || '03001234567',
  role: 'doctor',
};

const sampleCase = {
  caseId: 'LK-DEMO-000001',
  patientName: 'Bilal Ahmed',
  age: 34,
  gender: 'male',
  phone: '03111234567',
  symptoms: {
    fatigue: true,
    fever: true,
    weightLoss: true,
    frequentInfections: false,
    easyBruising: true,
    bonePain: false,
    nightSweats: true,
  },
  cbcData: { wbc: 48.2, rbc: 3.6, hemoglobin: 8.9, platelets: 62 },
  imageUrl: 'samples/smear-demo-001.jpg',
  doctorNotes: 'Referred for bone marrow biopsy and flow cytometry.',
};

const run = async () => {
  await connectDB();

  let doctor = await User.findOne({ email: doctorData.email });
  if (doctor) {
    console.log(`Doctor already exists: ${doctor.email}`);
  } else {
    doctor = await User.create(doctorData);
    console.log(`Doctor created: ${doctor.email}`);
  }

  if (await PatientCase.exists({ caseId: sampleCase.caseId })) {
    console.log(`Sample case already exists: ${sampleCase.caseId}`);
  } else {
    await PatientCase.create({
      ...sampleCase,
      doctorId: doctor.id,
      aiResults: analyse(sampleCase),
      status: 'completed',
    });
    console.log(`Sample case created: ${sampleCase.caseId}`);
  }

  console.log('\nTest credentials');
  console.log(`  Doctor  -> ${doctorData.email} / ${doctorData.password}`);
  console.log(`  Patient -> case ${sampleCase.caseId}, phone ${sampleCase.phone}, OTP ${process.env.MOCK_OTP || '123456'}`);
};

run()
  .catch((err) => {
    console.error('Seeding failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
