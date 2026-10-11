/**
 * One-time (and safe to re-run) administrator provisioning.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' \
 *   ADMIN_NAME='Site Administrator' npm run create-admin
 *
 * - Credentials come from environment variables only; nothing is hard-coded and
 *   the password is never printed.
 * - Idempotent: if an admin with this email exists, nothing is changed (the
 *   existing password is NOT overwritten). If the email belongs to a doctor,
 *   the script refuses instead of promoting that account.
 * - There is deliberately no HTTP endpoint that can create an admin.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');

const MIN_PASSWORD_LENGTH = 12;

const provisionAdmin = async ({ name, email, password }) => {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('ADMIN_EMAIL must be a valid email address');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('ADMIN_PASSWORD must be at most 72 bytes');
  }

  await User.init(); // make sure the unique email index exists before inserting

  const existing = await User.findOne({ email: cleanEmail });
  if (existing) {
    if (existing.role === 'admin') return { created: false, email: cleanEmail };
    throw new Error(
      `${cleanEmail} already belongs to a ${existing.role} account. Use a different ADMIN_EMAIL; this script never promotes existing accounts.`
    );
  }

  try {
    await User.create({
      name: (name || 'Administrator').trim(),
      email: cleanEmail,
      password,
      role: 'admin',
    });
  } catch (err) {
    // Two runs at once: the unique email index lets only one win.
    if (err.code === 11000) return { created: false, email: cleanEmail };
    throw err;
  }
  return { created: true, email: cleanEmail };
};

const run = async () => {
  const connectDB = require('../config/db');
  await connectDB();
  const result = await provisionAdmin({
    name: process.env.ADMIN_NAME,
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  console.log(
    result.created
      ? `Administrator created: ${result.email}`
      : `Administrator already exists: ${result.email} (left unchanged)`
  );
};

if (require.main === module) {
  run()
    .catch((err) => {
      console.error('Could not provision administrator:', err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close());
}

module.exports = { provisionAdmin };
