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

  if (decoded.role === 'doctor') {
    const doctor = await User.findById(decoded.id).select('name email role');
    if (!doctor || doctor.role !== 'doctor') {
      throw new ApiError(401, 'Account no longer exists');
    }
    req.user = { id: doctor.id, role: 'doctor', name: doctor.name, email: doctor.email };
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

module.exports = { protect, authorize };
