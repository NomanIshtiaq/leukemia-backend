const crypto = require('crypto');
const h = require('./helpers');

let admin;
let at; // admin token

beforeAll(h.connect);
afterAll(h.disconnect);
beforeEach(async () => {
  await h.resetDb();
  admin = await h.createAdmin();
  at = await h.loginAdmin(admin);
});

const get = (path) => h.api().get(path).set(h.auth(at));
const post = (path, body = {}) => h.api().post(path).set(h.auth(at)).send(body);

describe('reviewing doctor applications', () => {
  test('lists pending applications with the details needed for review, never secrets', async () => {
    const { code } = await h.invite(at, 'app@example.com');
    await h.register(h.doctorBody(code, 'app@example.com', { pmdcNumber: '55555-P', hospitalName: 'Aga Khan' }));
    await h.createDoctor({ status: 'approved' });
    await h.createLegacyDoctor();

    const res = await get('/api/admin/doctors?status=pending');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ pending: 2, approved: 1, rejected: 0 });

    const app = res.body.doctors.find((d) => d.email === 'app@example.com');
    expect(app).toMatchObject({
      name: 'Dr Applicant',
      status: 'pending',
      pmdcNumber: '55555-P',
      pmdcVerificationStatus: 'unverified',
      hospitalName: 'Aga Khan',
      phone: '+923001234567',
      phoneVerified: false,
      legacy: false,
    });
    expect(res.body.doctors.some((d) => d.legacy === true)).toBe(true); // legacy listed as pending

    expect(JSON.stringify(res.body)).not.toMatch(/"password"|\$2[aby]\$|codeHash|tokenVersion/);
  });

  test('views one application', async () => {
    const d = await h.createDoctor({ status: 'pending' });
    const res = await get(`/api/admin/doctors/${d.id}`);
    expect(res.status).toBe(200);
    expect(res.body.doctor.pmdcNumber).toBe(d.pmdcNumber);
    expect((await get('/api/admin/doctors/not-an-id')).status).toBe(404);
  });

  test('approve: doctor can then sign in; reviewer comes from the token, not the body; PMDC stays unverified by default', async () => {
    const d = await h.createDoctor({ status: 'pending' });
    const res = await post(`/api/admin/doctors/${d.id}/approve`, { reviewedBy: 'someone-else', status: 'rejected' });
    expect(res.status).toBe(200);
    expect(res.body.doctor.status).toBe('approved');
    expect(res.body.doctor.pmdcVerificationStatus).toBe('unverified');

    const stored = await h.User.findById(d.id);
    expect(String(stored.reviewedBy)).toBe(admin.id);
    expect(stored.reviewedAt).toBeTruthy();

    const login = await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD });
    expect(login.status).toBe(200);
  });

  test('PMDC is marked verified only when the administrator explicitly says they checked it', async () => {
    const d = await h.createDoctor({ status: 'pending' });
    const res = await post(`/api/admin/doctors/${d.id}/approve`, { pmdcChecked: true, note: 'Checked on the PMDC register' });
    expect(res.body.doctor.pmdcVerificationStatus).toBe('verified_by_admin');
    expect(res.body.doctor.reviewNote).toBe('Checked on the PMDC register');
  });

  test('a legacy doctor can be approved explicitly', async () => {
    const legacy = await h.createLegacyDoctor();
    expect((await post(`/api/admin/doctors/${legacy.id}/approve`)).status).toBe(200);
    expect((await h.User.findById(legacy.id)).status).toBe('approved');
  });

  test('reject needs a reason, blocks sign-in, and shows the reason to the doctor', async () => {
    const d = await h.createDoctor({ status: 'pending' });
    expect((await post(`/api/admin/doctors/${d.id}/reject`, {})).status).toBe(400);
    expect((await post(`/api/admin/doctors/${d.id}/reject`, { reason: 'Could not confirm PMDC' })).status).toBe(200);

    const login = await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('ACCOUNT_REJECTED');
    expect(login.body.reason).toBe('Could not confirm PMDC');
  });

  test('repeating a decision is a 409; an approved doctor can later be rejected (access withdrawn)', async () => {
    const d = await h.createDoctor({ status: 'pending' });
    expect((await post(`/api/admin/doctors/${d.id}/approve`)).status).toBe(200);
    expect((await post(`/api/admin/doctors/${d.id}/approve`)).status).toBe(409);
    expect((await post(`/api/admin/doctors/${d.id}/reject`, { reason: 'Licence suspended' })).status).toBe(200);
    expect((await post(`/api/admin/doctors/${d.id}/reject`, { reason: 'again' })).status).toBe(409);
  });

  test('filters by approved / rejected and searches', async () => {
    await h.createDoctor({ status: 'approved', name: 'Dr Alpha' });
    await h.createDoctor({ status: 'rejected', name: 'Dr Beta' });
    expect((await get('/api/admin/doctors?status=approved')).body.doctors.map((d) => d.name)).toEqual(['Dr Alpha']);
    expect((await get('/api/admin/doctors?status=rejected')).body.doctors.map((d) => d.name)).toEqual(['Dr Beta']);
    expect((await get('/api/admin/doctors?status=approved&q=alp')).body.count).toBe(1);
    expect((await get('/api/admin/doctors?status=approved&q=zzz')).body.count).toBe(0);
  });

  test('admin accounts are not treated as doctors (404)', async () => {
    expect((await post(`/api/admin/doctors/${admin.id}/approve`)).status).toBe(404);
  });
});

describe('invitation codes', () => {
  test('generation returns the code once, with expiry, status and a WhatsApp click-to-chat link', async () => {
    const res = await post('/api/admin/invitations', { email: 'Dr.New@Example.com', phone: '+92 300 1234567' });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toMatch(/no-store/);

    expect(res.body.code).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    expect(res.body.invitation).toMatchObject({
      intendedEmail: 'dr.new@example.com',
      intendedPhone: '+923001234567',
      status: 'active',
      purpose: 'doctor_registration',
    });
    const hours = (new Date(res.body.invitation.expiresAt) - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    const { url, number, message } = res.body.whatsapp;
    expect(number).toBe('923001234567'); // international format, no "+", spaces or punctuation
    expect(url).toBe(`https://wa.me/923001234567?text=${encodeURIComponent(message)}`);
    expect(message).toContain(res.body.code);
    expect(message).toContain('expires in 24 hours');
    expect(message).toContain('can only be used once');
    expect(decodeURIComponent(url.split('?text=')[1])).toBe(message);
  });

  test('without a WhatsApp number there is no link (copy-code fallback)', async () => {
    const res = await post('/api/admin/invitations', { email: 'nophone@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.whatsapp.url).toBeNull();
    expect(res.body.code).toBeTruthy();
  });

  test('custom expiry is honoured and limited', async () => {
    const res = await post('/api/admin/invitations', { email: 'ttl@example.com', expiresInHours: 2 });
    const hours = (new Date(res.body.invitation.expiresAt) - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThanOrEqual(2);
    expect((await post('/api/admin/invitations', { email: 'ttl2@example.com', expiresInHours: 0 })).status).toBe(400);
    expect((await post('/api/admin/invitations', { email: 'ttl3@example.com', expiresInHours: 5000 })).status).toBe(400);
  });

  test('rejects bad input: email, WhatsApp number, existing account', async () => {
    expect((await post('/api/admin/invitations', {})).status).toBe(400);
    expect((await post('/api/admin/invitations', { email: 'nope' })).status).toBe(400);
    expect((await post('/api/admin/invitations', { email: 'a@example.com', phone: '03001234567' })).status).toBe(400);
    const d = await h.createDoctor();
    const res = await post('/api/admin/invitations', { email: d.email });
    expect(res.status).toBe(409);
  });

  test('only a hash is stored: the plaintext code is nowhere in the database', async () => {
    const { code, invitation } = await h.invite(at, 'hash@example.com');
    const stored = await h.Invitation.findById(invitation.id).lean();
    expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(JSON.stringify(stored)).not.toContain(code.replace(/-/g, ''));
    expect(stored.createdBy.toString()).toBe(admin.id); // audit metadata
    expect(stored.intendedEmail).toBe('hash@example.com');
    expect(stored.expiresAt).toBeTruthy();
  });

  test('listing shows metadata and status but never codes, hashes or share links', async () => {
    const a = await h.invite(at, 'one@example.com', { phone: '+923001234567' });
    const b = await h.invite(at, 'two@example.com');
    await h.register(h.doctorBody(b.code, 'two@example.com'));
    const c = await h.invite(at, 'three@example.com');
    await post(`/api/admin/invitations/${c.invitation.id}/revoke`);
    const d = await h.invite(at, 'four@example.com');
    await h.Invitation.updateOne({ _id: d.invitation.id }, { expiresAt: new Date(Date.now() - 1000) });

    const res = await get('/api/admin/invitations');
    expect(res.status).toBe(200);
    const statusByEmail = Object.fromEntries(res.body.invitations.map((i) => [i.intendedEmail, i.status]));
    expect(statusByEmail).toEqual({
      'one@example.com': 'active',
      'two@example.com': 'used',
      'three@example.com': 'revoked',
      'four@example.com': 'expired',
    });

    const body = JSON.stringify(res.body);
    [a, b, c, d].forEach(({ code }) => {
      expect(body).not.toContain(code);
      expect(body).not.toContain(code.replace(/-/g, ''));
    });
    expect(body).not.toMatch(/codeHash|wa\.me/);

    expect((await get('/api/admin/invitations?status=active')).body.count).toBe(1);
    expect((await get('/api/admin/invitations?status=expired')).body.count).toBe(1);
    expect((await get('/api/admin/invitations?status=used')).body.count).toBe(1);
    expect((await get('/api/admin/invitations?status=revoked')).body.count).toBe(1);
  });

  test('a new code for the same email supersedes the old one', async () => {
    const first = await h.invite(at, 'again@example.com');
    const second = await h.invite(at, 'again@example.com');
    expect((await h.register(h.doctorBody(first.code, 'again@example.com'))).body.code).toBe('INVITATION_REVOKED');
    expect((await h.register(h.doctorBody(second.code, 'again@example.com'))).status).toBe(201);
  });

  test('revoke: works on unused codes, not on used ones, 404 for unknown', async () => {
    const a = await h.invite(at, 'revoke@example.com');
    const res = await post(`/api/admin/invitations/${a.invitation.id}/revoke`, { reason: 'wrong doctor' });
    expect(res.status).toBe(200);
    expect(res.body.invitation.status).toBe('revoked');
    expect((await post(`/api/admin/invitations/${a.invitation.id}/revoke`)).status).toBe(409);

    const b = await h.invite(at, 'used@example.com');
    await h.register(h.doctorBody(b.code, 'used@example.com'));
    expect((await post(`/api/admin/invitations/${b.invitation.id}/revoke`)).status).toBe(409);

    expect((await post('/api/admin/invitations/64b000000000000000000009/revoke')).status).toBe(404);
  });

  test('codes are generated with the CSPRNG, are unique, and never touch Math.random', () => {
    const { generateCode } = require('../utils/invitationCode');
    const randomInt = jest.spyOn(crypto, 'randomInt');
    const mathRandom = jest.spyOn(Math, 'random');
    const codes = new Set(Array.from({ length: 2000 }, () => generateCode()));
    expect(codes.size).toBe(2000);
    expect(randomInt).toHaveBeenCalledTimes(2000 * 16);
    expect(mathRandom).not.toHaveBeenCalled();
    randomInt.mockRestore();
    mathRandom.mockRestore();
  });
});

describe('audit trail', () => {
  test('records generation, revocation, approval, rejection and registration, without any secret', async () => {
    const a = await h.invite(at, 'trail@example.com', { phone: '+923001234567' });
    const r = await h.invite(at, 'revoked@example.com');
    await post(`/api/admin/invitations/${r.invitation.id}/revoke`);
    await h.register(h.doctorBody(a.code, 'trail@example.com'));
    const doc = await h.User.findOne({ email: 'trail@example.com' });
    await post(`/api/admin/doctors/${doc.id}/approve`, { note: 'ok' });
    const other = await h.createDoctor({ status: 'pending' });
    await post(`/api/admin/doctors/${other.id}/reject`, { reason: 'no' });

    const res = await get('/api/admin/audit-logs?limit=100');
    const actions = res.body.logs.map((l) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'admin.login',
        'invitation.create',
        'invitation.revoke',
        'doctor.register',
        'doctor.approve',
        'doctor.reject',
      ])
    );
    const create = res.body.logs.find(
      (l) => l.action === 'invitation.create' && l.metadata.intendedEmail === 'trail@example.com'
    );
    expect(String(create.actor)).toBe(admin.id);
    expect(create.metadata.hasPhone).toBe(true);

    const everything = JSON.stringify(await h.AuditLog.find().lean());
    [a.code, r.code, h.PASSWORD].forEach((secret) => {
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(secret.replace(/-/g, ''));
    });
    expect(everything).not.toMatch(/wa\.me|codeHash|\$2[aby]\$/);
  });

  test('sanitize() drops credential-looking keys', () => {
    const { sanitize } = require('../utils/audit');
    expect(sanitize({ ok: 1, password: 'p', token: 't', code: 'c', nested: { invitationCode: 'x', keep: 2 } })).toEqual({
      ok: 1,
      nested: { keep: 2 },
    });
  });
});

describe('password reset and change (no e-mail or SMS needed)', () => {
  test('forgot-password answers identically for known and unknown emails', async () => {
    const d = await h.createDoctor();
    const known = await h.api().post('/api/auth/forgot-password').send({ email: d.email });
    const unknown = await h.api().post('/api/auth/forgot-password').send({ email: 'ghost@example.com' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect((await h.User.findById(d.id)).passwordResetRequestedAt).toBeTruthy();
    expect((await get('/api/admin/doctors?status=approved')).body.doctors[0].passwordResetRequested).toBe(true);
  });

  test('admin issues a reset code, doctor redeems it once, old sessions die', async () => {
    const d = await h.createDoctor();
    const oldToken = (await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD })).body.token;
    await h.api().post('/api/auth/forgot-password').send({ email: d.email });

    const gen = await post(`/api/admin/doctors/${d.id}/password-reset-code`);
    expect(gen.status).toBe(201);
    expect(gen.body.whatsapp.url).toMatch(/^https:\/\/wa\.me\/923001234567\?text=/);
    expect(gen.body.whatsapp.message).toContain(gen.body.code);
    expect(gen.body.whatsapp.message).toContain('expires in 1 hour');

    const reset = await h.api().post('/api/auth/reset-password').send({ email: d.email, code: gen.body.code, newPassword: 'Brand-New-Pass-1' });
    expect(reset.status).toBe(200);

    expect((await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD })).status).toBe(401);
    expect((await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: 'Brand-New-Pass-1' })).status).toBe(200);
    expect((await h.api().get('/api/cases/doctor').set(h.auth(oldToken))).status).toBe(401); // pre-reset token revoked
    expect((await h.User.findById(d.id)).passwordResetRequestedAt).toBeUndefined();

    const again = await h.api().post('/api/auth/reset-password').send({ email: d.email, code: gen.body.code, newPassword: 'Another-Pass-2' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVITATION_USED');
  });

  test('a reset code only works for its own account and purpose', async () => {
    const d1 = await h.createDoctor();
    const d2 = await h.createDoctor();
    const gen = await post(`/api/admin/doctors/${d1.id}/password-reset-code`);
    const wrong = await h.api().post('/api/auth/reset-password').send({ email: d2.email, code: gen.body.code, newPassword: 'Another-Pass-2' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVITATION_EMAIL_MISMATCH');

    // A registration code cannot be used as a reset code, and vice versa.
    const inv = await h.invite(at, 'reg@example.com');
    const cross = await h.api().post('/api/auth/reset-password').send({ email: 'reg@example.com', code: inv.code, newPassword: 'Another-Pass-2' });
    expect(cross.status).toBe(400);
    expect((await h.register(h.doctorBody(gen.body.code, d1.email.replace(/^doc/, 'doc2')))).status).toBe(400);
  });

  test('change-password: wrong current password is 400 (not 401), success returns a fresh token and kills the old one', async () => {
    const d = await h.createDoctor();
    const login = await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD });
    const old = login.body.token;

    const wrong = await h.api().post('/api/auth/change-password').set(h.auth(old)).send({ currentPassword: 'nope-nope-1', newPassword: 'Brand-New-Pass-1' });
    expect(wrong.status).toBe(400);

    expect((await h.api().post('/api/auth/change-password').set(h.auth(old)).send({ currentPassword: h.PASSWORD, newPassword: 'short' })).status).toBe(400);

    const ok = await h.api().post('/api/auth/change-password').set(h.auth(old)).send({ currentPassword: h.PASSWORD, newPassword: 'Brand-New-Pass-1' });
    expect(ok.status).toBe(200);
    expect((await h.api().get('/api/cases/doctor').set(h.auth(ok.body.token))).status).toBe(200);
    expect((await h.api().get('/api/cases/doctor').set(h.auth(old))).status).toBe(401);
  });

  test('patients cannot change passwords; passwords over 72 bytes are refused', async () => {
    const d = await h.createDoctor();
    const c = await h.createCase(h.tokenFor(d));
    const pt = h.patientToken(await h.PatientCase.findOne({ caseId: c.caseId }));
    expect((await h.api().post('/api/auth/change-password').set(h.auth(pt)).send({ currentPassword: 'x', newPassword: 'Brand-New-Pass-1' })).status).toBe(403);
    const long = await h.api().post('/api/auth/change-password').set(h.auth(h.tokenFor(d))).send({ currentPassword: h.PASSWORD, newPassword: 'a'.repeat(80) });
    expect(long.status).toBe(400);
  });
});

describe('administrator provisioning', () => {
  const { provisionAdmin } = require('../scripts/createAdmin');

  test('creates one admin; running again changes nothing (idempotent) and never overwrites the password', async () => {
    await h.resetDb();
    const first = await provisionAdmin({ name: 'Boss', email: 'Boss@Example.com', password: 'a-long-passphrase-1' });
    const second = await provisionAdmin({ name: 'Other', email: 'boss@example.com', password: 'a-different-passphrase-2' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await h.User.countDocuments({ role: 'admin' })).toBe(1);

    const login = (password) => h.api().post('/api/auth/admin-login').send({ email: 'boss@example.com', password });
    expect((await login('a-long-passphrase-1')).status).toBe(200);
    expect((await login('a-different-passphrase-2')).status).toBe(401);
  });

  test('refuses weak passwords and refuses to promote an existing doctor', async () => {
    await h.resetDb();
    await expect(provisionAdmin({ email: 'x@example.com', password: 'short' })).rejects.toThrow(/at least 12/);
    await expect(provisionAdmin({ email: 'bad', password: 'a-long-passphrase-1' })).rejects.toThrow(/valid email/);
    const d = await h.createDoctor();
    await expect(provisionAdmin({ email: d.email, password: 'a-long-passphrase-1' })).rejects.toThrow(/never promotes/);
    expect((await h.User.findById(d.id)).role).toBe('doctor');
  });

  test('concurrent runs still produce a single admin', async () => {
    await h.resetDb();
    await Promise.allSettled(
      Array.from({ length: 5 }, () => provisionAdmin({ email: 'race-admin@example.com', password: 'a-long-passphrase-1' }))
    );
    expect(await h.User.countDocuments({ email: 'race-admin@example.com' })).toBe(1);
  });
});
