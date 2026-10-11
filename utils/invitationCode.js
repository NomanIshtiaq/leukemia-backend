const crypto = require('crypto');

// 31 symbols: no I, L, O, 0 or 1, so codes read out loud or copied from a chat
// are hard to mistype. 16 symbols ~ 79 bits of entropy.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 16;

/**
 * Generates a code with the OS CSPRNG (crypto.randomInt is unbiased). Nothing
 * about the code is derived from time, counters or database ids.
 * Format: XXXX-XXXX-XXXX-XXXX
 */
const generateCode = () => {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    raw += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return raw.match(/.{4}/g).join('-');
};

/** Upper-case and drop separators/whitespace so "abcd efgh..." still matches. */
const normalizeCode = (value) =>
  String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const pepper = () => {
  const key = process.env.INVITATION_CODE_PEPPER || process.env.JWT_SECRET;
  if (!key) throw new Error('INVITATION_CODE_PEPPER or JWT_SECRET must be set');
  return key;
};

/**
 * Keyed hash (HMAC-SHA256) of the normalised code. Codes are long random
 * values, so a fast keyed hash is appropriate and allows an indexed lookup;
 * without the server-side key a leaked hash cannot be checked offline.
 */
const hashCode = (code) =>
  crypto.createHmac('sha256', pepper()).update(normalizeCode(code)).digest('hex');

module.exports = { generateCode, normalizeCode, hashCode, ALPHABET, CODE_LENGTH };
