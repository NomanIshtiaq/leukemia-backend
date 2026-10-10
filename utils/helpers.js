const ApiError = require('./ApiError');

const normalizePhone = (value) => String(value || '').replace(/[\s\-()]/g, '');

const requireString = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `${field} is required`);
  }
  return value.trim();
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { normalizePhone, requireString, escapeRegex };
