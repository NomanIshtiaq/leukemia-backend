const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = require('../server');
const User = require('../models/User');
const Invitation = require('../models/Invitation');
const AuditLog = require('../models/AuditLog');
const PatientCase = require('../models/PatientCase');
const Counter = require('../models/Counter');
const { generateDoctorId } = require('../utils/doctorId');
const InvitationClaim = require('../models/InvitationClaim');

const DB_URI = process.env.TEST_MONGO_URI;

// The suite deletes everything it can see. Refuse to run against anything that
// does not look like a throw-away database.
const assertSafeTestDatabase = () => {
  const dbName = (DB_URI.split('?')[0].split('/').pop() || '').toLowerCase();
  if (!dbName.includes('test')) {
    throw new Error(
      `Refusing to run tests: TEST_MONGO_URI database "${dbName}" must contain "test" in its name.`
    );
  }
};

const connect = async () => {
  assertSafeTestDatabase();
  await mongoose.connect(DB_URI, { serverSelectionTimeoutMS: 8000 });
  await Promise.all([User, Invitation, InvitationClaim, AuditLog, PatientCase, Counter].map((m) => m.init()));
};

const resetDb = async () => {
  await Promise.all([User, Invitation, InvitationClaim, AuditLog, PatientCase, Counter].map((m) => m.deleteMany({})));
};

const disconnect = () => mongoose.disconnect();

const api = () => request(app);

const PASSWORD = 'Correct-Horse-9';
let counter = 0;
const unique = () => {
  counter += 1;
  return `${Date.now()}${counter}`;
};

const createAdmin = async (overrides = {}) =>
  User.create({
    name: 'Admin',
    email: `admin${unique()}@example.com`,
    password: PASSWORD,
    role: 'admin',
    ...overrides,
  });

const createDoctor = async (overrides = {}) => {
  const n = unique();
  return User.create({
    // Real doctors always have a Doctor ID (assigned at registration).
    doctorId: await generateDoctorId(),
    name: 'Dr Test',
    email: `doc${n}@example.com`,
    password: PASSWORD,
    role: 'doctor',
    status: 'approved',
    phone: '+923001234567',
    pmdcNumber: `P${n}`,
    pmdcVerificationStatus: 'unverified',
    hospitalName: 'Test Hospital',
    ...overrides,
  });
};

/** A doctor document with NO status field, like accounts created before the workflow. */
const createLegacyDoctor = async () => {
  const n = unique();
  const email = `legacy${n}@example.com`;
  await User.collection.insertOne({
    name: 'Legacy Doc',
    email,
    password: bcrypt.hashSync(PASSWORD, 4),
    role: 'doctor',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return User.findOne({ email });
};

// Signs a token the way the server does, for accounts that cannot log in
// (pending / rejected) but may still hold an older token.
const tokenFor = (user, role = user.role) =>
  jwt.sign({ id: user.id, role }, process.env.JWT_SECRET, { expiresIn: '1h' });

const patientToken = (patientCase) =>
  jwt.sign(
    { id: patientCase.id, role: 'patient', caseId: patientCase.caseId },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const loginAdmin = async (admin) => {
  const res = await api().post('/api/auth/admin-login').send({ email: admin.email, password: PASSWORD });
  return res.body.token;
};

/** Admin generates an invitation through the real endpoint. */
const invite = async (adminToken, email, extra = {}) => {
  const res = await api().post('/api/admin/invitations').set(auth(adminToken)).send({ email, ...extra });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body; // { invitation, code, whatsapp, ... }
};

const doctorBody = (code, email, overrides = {}) => ({
  name: 'Dr Applicant',
  email,
  password: PASSWORD,
  phone: '+92 300 1234567',
  pmdcNumber: `${unique()}-P`,
  hospitalName: 'City Hospital',
  invitationCode: code,
  ...overrides,
});

const register = (body) => api().post('/api/auth/doctor-register').send(body);

const caseBody = (overrides = {}) => ({
  patientName: 'Patient One',
  age: 40,
  gender: 'female',
  phone: '03001112222',
  ...overrides,
});

const createCase = async (token, overrides = {}) => {
  const res = await api().post('/api/cases/create').set(auth(token)).send(caseBody(overrides));
  if (res.status !== 201) throw new Error(`create case failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.case;
};

module.exports = {
  app, api, connect, resetDb, disconnect,
  User, Invitation, AuditLog, PatientCase,
  PASSWORD, unique,
  createAdmin, createDoctor, createLegacyDoctor,
  tokenFor, patientToken, auth, loginAdmin,
  invite, doctorBody, register, caseBody, createCase,
};
