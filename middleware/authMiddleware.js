const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const protect = asyncHandler(async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw new ApiError(401, 'Authentication required');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError'
        ? 'Session expired, please sign in again'
        : 'Invalid authentication token';
    throw new ApiError(401, message);
  }

  if (decoded.role === 'doctor' || decoded.role === 'admin') {
    // Role and approval status are always re-read from the database. Nothing the
    // client (or an old token) claims about them is trusted.
    const account = await User.findById(decoded.id).select(
      'name email role status tokenVersion'
    );
    if (!account || account.role !== decoded.role) {
      throw new ApiError(401, 'Account no longer exists');
    }

    // A password change/reset bumps tokenVersion, which invalidates every token
    // issued before it (exact, with no clock-resolution gap).
    if ((decoded.tv || 0) !== (account.tokenVersion || 0)) {
      throw new ApiError(401, 'Your password was changed, please sign in again');
    }

    req.user = {
      id: account.id,
      role: account.role,
      name: account.name,
      email: account.email,
      // Legacy doctor accounts have no stored status; they count as 'pending'.
      ...(account.role === 'doctor' ? { status: account.effectiveStatus() } : {}),
    };
  } else if (decoded.role === 'patient' && decoded.caseId) {
    req.user = { id: decoded.id, role: 'patient', caseId: decoded.caseId };
  } else {
    throw new ApiError(401, 'Invalid authentication token');
  }

  next();
});

const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new ApiError(403, 'You do not have permission to perform this action'));
  }
  return next();
};

const STATUS_BLOCK = {
  pending: [
    'ACCOUNT_PENDING',
    'Your doctor account is awaiting administrator approval. You will be able to use the system once it is approved.',
  ],
  rejected: [
    'ACCOUNT_REJECTED',
    'Your doctor application was not approved. Please contact the administrator.',
  ],
};

/**
 * Blocks doctors whose application has not been approved. Place it after
 * `protect`. Patients and admins pass straight through so it can sit on routes
 * that serve several roles; combine it with `authorize(...)` or an ownership
 * check to restrict who else gets in.
 */
const requireApprovedDoctor = (req, res, next) => {
  if (req.user && req.user.role === 'doctor' && req.user.status !== 'approved') {
    const [code, message] = STATUS_BLOCK[req.user.status] || STATUS_BLOCK.pending;
    return next(new ApiError(403, message, { code, details: { status: req.user.status } }));
  }
  return next();
};

module.exports = { protect, authorize, requireApprovedDoctor, STATUS_BLOCK };
