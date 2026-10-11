const AuditLog = require('../models/AuditLog');

// Anything that looks like a credential is dropped before it can reach the log.
const SENSITIVE_KEY = /pass(word)?|token|secret|hash|authorization|^code$|invitation_?code|resetcode|whatsappurl|message$/i;

const sanitize = (value, depth = 0) => {
  if (value === null || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  return Object.keys(value).reduce((acc, key) => {
    if (!SENSITIVE_KEY.test(key)) acc[key] = sanitize(value[key], depth + 1);
    return acc;
  }, {});
};

/**
 * Appends an audit record. Never throws: a failure to write the trail must not
 * turn a successful action into an error, but it is reported on stderr.
 *
 * @param {import('express').Request} req
 * @param {string} action   e.g. 'doctor.approve'
 * @param {{ actorId?: string, actorRole?: string, targetType?: string, targetId?: string, metadata?: object }} [opts]
 */
const recordAudit = async (req, action, opts = {}) => {
  try {
    await AuditLog.create({
      action,
      actor: opts.actorId || (req && req.user && req.user.id) || undefined,
      actorRole: opts.actorRole || (req && req.user && req.user.role) || undefined,
      targetType: opts.targetType,
      targetId: opts.targetId ? String(opts.targetId) : undefined,
      metadata: sanitize(opts.metadata),
      ip: req && req.ip,
    });
  } catch (err) {
    console.error(`[audit] could not record "${action}": ${err.message}`);
  }
};

module.exports = { recordAudit, sanitize };
