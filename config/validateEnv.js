const PLACEHOLDER_PATTERN = /replace-with|change-?me|your[-_ ]?secret|example|^secret$|^password$/i;
const MIN_SECRET_LENGTH = 32;

/**
 * Returns a list of configuration problems. `fatal` ones should stop start-up.
 * Pure function (no process.exit) so it can be unit-tested.
 */
const checkEnv = (env = process.env) => {
  const fatal = [];
  const warnings = [];
  const production = env.NODE_ENV === 'production';

  const secret = env.JWT_SECRET || '';
  if (!secret) {
    fatal.push('JWT_SECRET is not set. Copy .env.example to .env and configure it.');
  } else if (PLACEHOLDER_PATTERN.test(secret)) {
    (production ? fatal : warnings).push(
      'JWT_SECRET still looks like a placeholder. Generate a real one (see README / .env.example).'
    );
  } else if (secret.length < MIN_SECRET_LENGTH) {
    (production ? fatal : warnings).push(
      `JWT_SECRET is only ${secret.length} characters; use at least ${MIN_SECRET_LENGTH} random characters.`
    );
  }

  if (production && !env.INVITATION_CODE_PEPPER) {
    warnings.push(
      'INVITATION_CODE_PEPPER is not set; invitation codes are hashed with JWT_SECRET instead. ' +
        'Rotating JWT_SECRET would then invalidate unused invitation codes.'
    );
  }

  if (env.DOCTOR_REGISTRATION_KEY) {
    warnings.push(
      'DOCTOR_REGISTRATION_KEY is no longer used: doctor registration now requires an administrator-issued invitation code. You can delete this variable.'
    );
  }

  return { fatal, warnings };
};

module.exports = { checkEnv, MIN_SECRET_LENGTH };
