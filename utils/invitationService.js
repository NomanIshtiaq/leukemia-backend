const Invitation = require('../models/Invitation');
const InvitationClaim = require('../models/InvitationClaim');
const ApiError = require('./ApiError');
const { generateCode, hashCode } = require('./invitationCode');

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24 * 7;
const HOUR_MS = 60 * 60 * 1000;

const parseTtlHours = (value, fallback = DEFAULT_TTL_HOURS) => {
  if (value === undefined || value === null || value === '') return fallback;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 1 || hours > MAX_TTL_HOURS) {
    throw new ApiError(400, `expiresInHours must be a number between 1 and ${MAX_TTL_HOURS}`);
  }
  return hours;
};

/** 'expired' is derived, never stored. */
const derivedStatus = (inv, now = new Date()) =>
  inv.status === 'active' && inv.expiresAt <= now ? 'expired' : inv.status;

/** Safe projection for API responses: never includes the hash or the code. */
const toMeta = (inv) => ({
  id: inv.id,
  purpose: inv.purpose,
  intendedEmail: inv.intendedEmail,
  intendedPhone: inv.intendedPhone || null,
  status: derivedStatus(inv),
  createdBy: inv.createdBy ? String(inv.createdBy._id || inv.createdBy) : null,
  createdAt: inv.createdAt,
  expiresAt: inv.expiresAt,
  usedAt: inv.usedAt || null,
  revokedAt: inv.revokedAt || null,
  revokeReason: inv.revokeReason || null,
});

/**
 * Creates a new code. Returns the plaintext code ONCE; only its hash is stored.
 * Older active codes for the same email + purpose are revoked so that exactly
 * one code per person is live at a time.
 */
const createInvitation = async ({ purpose, email, phone, createdBy, ttlHours }) => {
  const hours = ttlHours || DEFAULT_TTL_HOURS;
  const expiresAt = new Date(Date.now() + hours * HOUR_MS);

  let invitation;
  let code;
  for (let attempt = 0; attempt < 3 && !invitation; attempt += 1) {
    code = generateCode();
    try {
      // eslint-disable-next-line no-await-in-loop
      invitation = await Invitation.create({
        codeHash: hashCode(code),
        purpose,
        intendedEmail: email,
        intendedPhone: phone || undefined,
        createdBy,
        expiresAt,
      });
    } catch (err) {
      if (err.code !== 11000) throw err; // astronomically unlikely hash collision: retry
    }
  }
  if (!invitation) throw new ApiError(500, 'Could not generate an invitation code, please retry');

  await Invitation.updateMany(
    { intendedEmail: email, purpose, status: 'active', _id: { $ne: invitation._id } },
    {
      $set: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedBy: createdBy,
        revokeReason: 'superseded by a newer code',
      },
    }
  );

  return { invitation, code, expiresInHours: hours };
};

const REJECTIONS = {
  invalid: ['INVITATION_INVALID', 'The invitation code is not valid'],
  revoked: ['INVITATION_REVOKED', 'This invitation code has been revoked'],
  used: ['INVITATION_USED', 'This invitation code has already been used'],
  expired: ['INVITATION_EXPIRED', 'This invitation code has expired'],
  email: [
    'INVITATION_EMAIL_MISMATCH',
    'This invitation code was issued for a different email address',
  ],
};

const reject = (kind) => {
  const [code, message] = REJECTIONS[kind];
  return new ApiError(400, message, { code });
};

/**
 * Consumes a code so that it can never be used twice.
 *
 *  1. Find the code while it is active, unexpired and issued for this email.
 *  2. Claim it by inserting a document whose _id is the invitation's _id. The
 *     unique _id index guarantees exactly one concurrent caller succeeds; the
 *     others get a duplicate-key error and are told the code is already used.
 *  3. Mark it used. This is guarded on status 'active', so a code revoked a
 *     moment earlier is not resurrected.
 *
 * No multi-document transaction is needed, so it works on a standalone MongoDB,
 * a replica set and Atlas alike.
 */
const consumeInvitation = async ({ code, purpose, email }) => {
  if (typeof code !== 'string' || !code.trim()) {
    throw new ApiError(400, 'An invitation code is required', { code: 'INVITATION_REQUIRED' });
  }

  const codeHash = hashCode(code);
  const now = new Date();

  const candidate = await Invitation.findOne({
    codeHash,
    purpose,
    status: 'active',
    expiresAt: { $gt: now },
    intendedEmail: email,
  });

  if (candidate) {
    try {
      await InvitationClaim.create({ _id: candidate._id });
    } catch (err) {
      if (err.code === 11000) throw reject('used'); // someone else claimed it first
      throw err;
    }

    const consumed = await Invitation.findOneAndUpdate(
      { _id: candidate._id, status: 'active' },
      { $set: { status: 'used', usedAt: now } },
      { new: true }
    );
    if (consumed) return consumed;

    // Revoked between the lookup and the claim: undo the claim and report it.
    await InvitationClaim.deleteOne({ _id: candidate._id });
    throw reject('revoked');
  }

  // Not consumable: work out why so the user gets a useful message. Only
  // someone holding a real code ever reaches a specific reason; unknown codes
  // get a generic one.
  const existing = await Invitation.findOne({ codeHash, purpose });
  if (!existing) throw reject('invalid');
  if (existing.status === 'revoked') throw reject('revoked');
  if (existing.status === 'used') throw reject('used');
  if (existing.expiresAt <= now) throw reject('expired');
  if (existing.intendedEmail !== email) throw reject('email');
  throw reject('invalid');
};

/** Records which account consumed the code (audit trail). */
const attachUser = (invitationId, userId) =>
  Invitation.updateOne({ _id: invitationId }, { $set: { usedBy: userId } });

/**
 * Undoes consumeInvitation when the account could not be created afterwards, so
 * a failed registration does not burn the code. Only the request that holds the
 * claim ever calls this, so it cannot reopen a code another request is using.
 */
const releaseInvitation = async (invitation) => {
  try {
    await Invitation.updateOne(
      { _id: invitation._id, status: 'used', usedBy: null },
      { $set: { status: 'active' }, $unset: { usedAt: 1 } }
    );
    await InvitationClaim.deleteOne({ _id: invitation._id });
  } catch (err) {
    // The code stays consumed; the administrator can simply issue a new one.
    console.error(`[invitation] could not release invitation ${invitation.id}: ${err.message}`);
  }
};

const revokeInvitation = async ({ id, revokedBy, reason }) => {
  const revoked = await Invitation.findOneAndUpdate(
    { _id: id, status: 'active' },
    {
      $set: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedBy,
        revokeReason: reason || undefined,
      },
    },
    { new: true }
  );
  if (revoked) return revoked;

  const existing = await Invitation.findById(id);
  if (!existing) throw new ApiError(404, 'Invitation not found');
  throw new ApiError(409, `Only unused invitations can be revoked (this one is ${derivedStatus(existing)})`);
};

module.exports = {
  DEFAULT_TTL_HOURS,
  MAX_TTL_HOURS,
  parseTtlHours,
  derivedStatus,
  toMeta,
  createInvitation,
  consumeInvitation,
  attachUser,
  releaseInvitation,
  revokeInvitation,
};
