const express = require('express');
const request = require('supertest');
const { buildLimiters } = require('../middleware/rateLimiters');
const { checkEnv } = require('../config/validateEnv');
const { toE164 } = require('../utils/phone');
const { normalizePmdc, requirePmdc } = require('../utils/pmdc');
const { buildWhatsAppUrl, toWhatsAppDigits } = require('../utils/whatsapp');

describe('login rate limiting', () => {
  const makeApp = (env) => {
    const app = express();
    app.use(express.json());
    const { loginLimiters } = buildLimiters(env);
    // Always fails, like a wrong password.
    app.post('/fail', ...loginLimiters, (req, res) => res.status(401).json({ ok: false }));
    // Always succeeds.
    app.post('/ok', ...loginLimiters, (req, res) => res.json({ ok: true }));
    return app;
  };

  test('one account is locked out after repeated failures; other accounts are not', async () => {
    const app = makeApp({ LOGIN_RATE_LIMIT_MAX: '100', LOGIN_ACCOUNT_RATE_LIMIT_MAX: '3' });
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await request(app).post('/fail').send({ email: 'victim@example.com' })).status).toBe(401);
    }
    const blocked = await request(app).post('/fail').send({ email: 'Victim@Example.com' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect((await request(app).post('/fail').send({ email: 'someone-else@example.com' })).status).toBe(401);
  });

  test('successful sign-ins do not count against the account limit', async () => {
    const app = makeApp({ LOGIN_RATE_LIMIT_MAX: '100', LOGIN_ACCOUNT_RATE_LIMIT_MAX: '2' });
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await request(app).post('/ok').send({ email: 'busy@example.com' })).status).toBe(200);
    }
  });

  test('the per-IP limit stops one client hammering many accounts', async () => {
    const app = makeApp({ LOGIN_RATE_LIMIT_MAX: '3', LOGIN_ACCOUNT_RATE_LIMIT_MAX: '100' });
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/fail').send({ email: `user${i}@example.com` });
    }
    expect((await request(app).post('/fail').send({ email: 'user99@example.com' })).status).toBe(429);
  });

  test('the real login routes are wired to the limiter', () => {
    const saved = { ...process.env };
    process.env.LOGIN_RATE_LIMIT_MAX = '2';
    let app;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      app = require('../server');
    });
    Object.assign(process.env, saved);
    // Empty bodies fail validation before any database access.
    return (async () => {
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        statuses.push((await request(app).post('/api/auth/doctor-login').send({})).status);
      }
      expect(statuses).toEqual([400, 400, 429, 429]);
    })();
  });
});

describe('startup configuration checks', () => {
  test('missing JWT_SECRET is fatal', () => {
    expect(checkEnv({ NODE_ENV: 'development' }).fatal).toHaveLength(1);
  });
  test('weak or placeholder secrets are fatal in production, warnings elsewhere', () => {
    expect(checkEnv({ NODE_ENV: 'production', JWT_SECRET: 'short' }).fatal).toHaveLength(1);
    expect(checkEnv({ NODE_ENV: 'production', JWT_SECRET: 'replace-with-a-long-random-string' }).fatal).toHaveLength(1);
    const dev = checkEnv({ NODE_ENV: 'development', JWT_SECRET: 'short' });
    expect(dev.fatal).toHaveLength(0);
    expect(dev.warnings.length).toBeGreaterThan(0);
  });
  test('a 64-character random secret passes', () => {
    expect(checkEnv({ NODE_ENV: 'production', JWT_SECRET: 'f3'.repeat(32), INVITATION_CODE_PEPPER: 'x' }).fatal).toEqual([]);
  });
  test('the retired DOCTOR_REGISTRATION_KEY triggers a warning', () => {
    const r = checkEnv({ NODE_ENV: 'development', JWT_SECRET: 'f3'.repeat(32), DOCTOR_REGISTRATION_KEY: 'abc' });
    expect(r.warnings.join(' ')).toMatch(/DOCTOR_REGISTRATION_KEY/);
  });
});

describe('phone numbers and WhatsApp links', () => {
  test.each([
    ['+923001234567', '+923001234567'],
    ['+92 300 1234567', '+923001234567'],
    ['0092-300-1234567', '+923001234567'],
    ['(+92) 300.123.4567', '+923001234567'],
    ['+14155552671', '+14155552671'],
  ])('accepts %s', (input, expected) => expect(toE164(input)).toBe(expected));

  test.each([
    ['03001234567'], // no country code
    ['+920300123456'], // trunk zero kept
    ['+92300123'], // too short
    ['+9230012345678'], // too long for a PK mobile
    ['+0123456789'],
    ['abc'],
    [''],
    [null],
    [12345678901],
  ])('rejects %p', (input) => expect(toE164(input)).toBeNull());

  test('wa.me link: digits only, message URL-encoded, nothing hard-coded', () => {
    const url = buildWhatsAppUrl('+44 20 7946 0958'.replace(/\s/g, ''), 'Hi & bye?\nline 2 #1');
    expect(url).toBe(`https://wa.me/442079460958?text=${encodeURIComponent('Hi & bye?\nline 2 #1')}`);
    expect(url).not.toMatch(/\+|%2B|\s/);
    expect(toWhatsAppDigits('+923001234567')).toBe('923001234567');
    expect(buildWhatsAppUrl('nope', 'x')).toBeNull();
  });
});

describe('PMDC numbers', () => {
  test('are normalised the same way for uniqueness', () => {
    expect(normalizePmdc(' 12345 - p ')).toBe('12345-P');
    expect(requirePmdc('12345-p')).toBe(requirePmdc(' 12345 - P '));
  });
  test('obviously bad values are rejected (format only; never proof of authenticity)', () => {
    expect(() => requirePmdc('')).toThrow();
    expect(() => requirePmdc('--')).toThrow();
    expect(() => requirePmdc('ABCDEF')).toThrow(); // no digit
    expect(() => requirePmdc('1'.repeat(30))).toThrow();
  });
});
