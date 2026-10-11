// Runs before every test file. Order matters: these values must be set before
// server.js calls dotenv, because dotenv never overrides variables that exist.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = `test-jwt-secret-${'a'.repeat(40)}`;
process.env.INVITATION_CODE_PEPPER = `test-pepper-${'b'.repeat(40)}`;
process.env.BCRYPT_ROUNDS = '4'; // fast hashing; production keeps its own value
process.env.MOCK_OTP = '123456';
process.env.LOGIN_RATE_LIMIT_MAX = '1000';
process.env.LOGIN_ACCOUNT_RATE_LIMIT_MAX = '1000';

const uri = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/leukemia_test';
process.env.TEST_MONGO_URI = uri;
// If anything ever calls connectDB(), it must reach the test database, never the
// production one from a developer's .env.
process.env.MONGO_URI = uri;
