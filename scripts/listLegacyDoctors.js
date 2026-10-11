/**
 * Read-only report of doctor accounts created before the approval workflow
 * (no stored `status`). They are treated as "pending": they cannot sign in or
 * use any doctor feature until an administrator approves them from the admin
 * dashboard (or POST /api/admin/doctors/:id/approve). Nothing is modified here.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');

const run = async () => {
  await connectDB();
  const legacy = await User.find({
    role: 'doctor',
    $or: [{ status: { $exists: false } }, { status: null }],
  }).sort({ createdAt: 1 });

  console.log(`Doctor accounts without an approval status: ${legacy.length}`);
  legacy.forEach((d) => console.log(`  ${d.id}  ${d.email}  (${d.name})`));
  if (legacy.length) {
    console.log('\nThey stay blocked until an administrator approves each one.');
  }
};

run()
  .catch((err) => {
    console.error('Report failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
