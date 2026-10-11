const ApiError = require('./ApiError');

/**
 * PMDC registration numbers are validated for FORMAT only. A well-formed
 * number says nothing about whether it exists or belongs to this person; the
 * application stays "submitted / unverified" until an administrator checks it
 * (pmdcVerificationStatus). No official PMDC verification API is integrated.
 * `verifyPmdc` is the extension point where one could be added later.
 */
const PMDC_PATTERN = /^(?=.*\d)[A-Z0-9][A-Z0-9\-/]{2,19}$/;

/** Uppercase and strip whitespace so "12345 - p" and "12345-P" collide. */
const normalizePmdc = (value) =>
  String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '');

const requirePmdc = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, 'PMDC registration number is required');
  }
  const normalized = normalizePmdc(value);
  if (!PMDC_PATTERN.test(normalized)) {
    throw new ApiError(
      400,
      'PMDC registration number looks invalid (3-20 letters, digits, "-" or "/", with at least one digit)'
    );
  }
  return normalized;
};

// Future hook: replace with a call to an authorised verification service.
// eslint-disable-next-line no-unused-vars
const verifyPmdc = async (_normalizedNumber) => ({ status: 'unverified' });

module.exports = { normalizePmdc, requirePmdc, verifyPmdc };
