const ApiError = require('./ApiError');

const normalizePhone = (value) => String(value || '').replace(/[\s\-()]/g, '');

const requireString = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `${field} is required`);
  }
  return value.trim();
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase, so uniqueness checks and lookups always agree. */
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const requireEmail = (value) => {
  const email = normalizeEmail(requireString(value, 'Email'));
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new ApiError(400, 'Please provide a valid email address');
  }
  return email;
};

/**
 * Passwords are hashed with bcrypt, which silently ignores everything after
 * 72 bytes. Rejecting longer input is safer than pretending it all counts.
 */
const validateNewPassword = (value, field = 'Password') => {
  if (typeof value !== 'string' || !value) {
    throw new ApiError(400, `${field} is required`);
  }
  if (value.length < 8) {
    throw new ApiError(400, `${field} must be at least 8 characters`);
  }
  if (Buffer.byteLength(value, 'utf8') > 72) {
    throw new ApiError(400, `${field} must be at most 72 bytes long`);
  }
  return value;
};

module.exports = {
  normalizePhone,
  requireString,
  escapeRegex,
  normalizeEmail,
  requireEmail,
  validateNewPassword,
};
