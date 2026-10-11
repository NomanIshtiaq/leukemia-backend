const ApiError = require('./ApiError');

/**
 * Doctor mobile numbers must be in international format (country code
 * included) because the same number is used to build the WhatsApp
 * click-to-chat link. We validate the *shape* only. The server has no way to
 * prove the number belongs to the doctor or that it has a WhatsApp account, so
 * it is always stored with phoneVerified = false.
 */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
// Pakistan mobile numbers: +92 3XX XXXXXXX (10 national digits, starting with 3).
const PK_MOBILE_PATTERN = /^\+923\d{9}$/;

/**
 * Returns the number as E.164 ("+923001234567") or null when it is not
 * acceptable. Accepts spaces, hyphens, dots and brackets as separators and a
 * leading "00" in place of "+".
 */
const toE164 = (value) => {
  if (typeof value !== 'string') return null;
  let cleaned = value.trim().replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`;
  if (!E164_PATTERN.test(cleaned)) return null;
  if (cleaned.startsWith('+92') && !PK_MOBILE_PATTERN.test(cleaned)) return null;
  return cleaned;
};

const PHONE_HELP =
  'Enter the mobile number with its country code, e.g. +923001234567 (do not start with 0)';

const requireE164 = (value, field = 'Mobile number') => {
  const phone = toE164(value);
  if (!phone) {
    throw new ApiError(
      400,
      `${field} must include the country code and be linked to WhatsApp. ${PHONE_HELP}`
    );
  }
  return phone;
};

module.exports = { toE164, requireE164, PHONE_HELP };
