const { rateLimit } = require('express-rate-limit');

const num = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const tooMany = (message) => (req, res) =>
  res.status(429).json({ success: false, message, code: 'RATE_LIMITED' });

/**
 * Brute-force protection for credential endpoints.
 *
 * Two limiters are stacked on every login-style route:
 *   - per IP address (stops one machine hammering many accounts)
 *   - per account/email (stops many machines hammering one account)
 *
 * Counters live in process memory, which is correct for a single Render
 * instance. If the service is ever scaled to several instances, switch to a
 * shared store (e.g. rate-limit-redis).
 */
const buildLimiters = (env = process.env) => {
  const windowMs = num(env.RATE_LIMIT_WINDOW_MINUTES, 15) * 60 * 1000;
  const ipMax = num(env.LOGIN_RATE_LIMIT_MAX, 20);
  const accountMax = num(env.LOGIN_ACCOUNT_RATE_LIMIT_MAX, 8);
  const message = 'Too many attempts. Please wait a few minutes and try again.';

  const byIp = rateLimit({
    windowMs,
    limit: ipMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: tooMany(message),
  });

  const byAccount = rateLimit({
    windowMs,
    limit: accountMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Keyed on the submitted identifier only, never on the IP, so rotating
    // addresses does not reset the counter.
    keyGenerator: (req) =>
      `acct:${String((req.body && (req.body.email || req.body.caseId)) || 'unknown')
        .trim()
        .toLowerCase()
        .slice(0, 120)}`,
    // Count only failures so a legitimate user is not locked out by logging in.
    skipSuccessfulRequests: true,
    handler: tooMany(message),
  });

  return { loginLimiters: [byIp, byAccount] };
};

module.exports = { buildLimiters };
