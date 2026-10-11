const h = require('./helpers');
const { consumeInvitation } = require('../utils/invitationService');

let admin;
let adminToken;

beforeAll(h.connect);
afterAll(h.disconnect);
beforeEach(async () => {
  await h.resetDb();
  admin = await h.createAdmin();
  adminToken = await h.loginAdmin(admin);
});

describe('doctor registration with invitation codes', () => {
  test('without an invitation code is rejected', async () => {
    const res = await h.register(h.doctorBody(undefined, 'a@example.com'));
    expect(res.status).toBe(400);
    expect(await h.User.countDocuments({ role: 'doctor' })).toBe(0);
  });

  test('an unknown code is rejected', async () => {
    const res = await h.register(h.doctorBody('AAAA-BBBB-CCCC-DDDD', 'a@example.com'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVITATION_INVALID');
  });

  test('a valid code creates a PENDING account with unverified credentials and no token', async () => {
    const { code, invitation } = await h.invite(adminToken, 'new@example.com');
    const res = await h.register(h.doctorBody(code, 'new@example.com', { pmdcNumber: '12345-p' }));

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/password|\$2[aby]\$/i);

    const doctor = await h.User.findOne({ email: 'new@example.com' });
    expect(doctor.role).toBe('doctor');
    expect(doctor.status).toBe('pending');
    expect(doctor.pmdcNumber).toBe('12345-P'); // normalised
    expect(doctor.pmdcVerificationStatus).toBe('unverified');
    expect(doctor.phone).toBe('+923001234567'); // E.164, separators stripped
    expect(doctor.phoneVerified).toBe(false);
    expect(doctor.hospitalName).toBe('City Hospital');

    const stored = await h.Invitation.findById(invitation.id);
    expect(stored.status).toBe('used');
    expect(String(stored.usedBy)).toBe(doctor.id);
    expect(stored.usedAt).toBeTruthy();
  });

  test('the code cannot be used twice', async () => {
    const { code } = await h.invite(adminToken, 'once@example.com');
    expect((await h.register(h.doctorBody(code, 'once@example.com'))).status).toBe(201);
    const again = await h.register(h.doctorBody(code, 'once@example.com'));
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVITATION_USED');
  });

  test('an expired code is rejected', async () => {
    const { code, invitation } = await h.invite(adminToken, 'late@example.com');
    await h.Invitation.updateOne({ _id: invitation.id }, { expiresAt: new Date(Date.now() - 1000) });
    const res = await h.register(h.doctorBody(code, 'late@example.com'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVITATION_EXPIRED');
  });

  test('a revoked code is rejected', async () => {
    const { code, invitation } = await h.invite(adminToken, 'rev@example.com');
    await h.api().post(`/api/admin/invitations/${invitation.id}/revoke`).set(h.auth(adminToken)).send({});
    const res = await h.register(h.doctorBody(code, 'rev@example.com'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVITATION_REVOKED');
  });

  test('a code issued for a different email is rejected and stays usable', async () => {
    const { code } = await h.invite(adminToken, 'intended@example.com');
    const wrong = await h.register(h.doctorBody(code, 'someone-else@example.com'));
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVITATION_EMAIL_MISMATCH');
    // A failed attempt by the wrong person must not burn the code.
    expect((await h.register(h.doctorBody(code, 'intended@example.com'))).status).toBe(201);
  });

  test('email matching is case-insensitive', async () => {
    const { code } = await h.invite(adminToken, 'Mixed.Case@Example.com');
    expect((await h.register(h.doctorBody(code, '  MIXED.case@example.COM '))).status).toBe(201);
  });

  test('duplicate PMDC number is rejected (normalised) and the code is given back', async () => {
    await h.createDoctor({ pmdcNumber: '99999-P' });
    const { code } = await h.invite(adminToken, 'dup@example.com');

    const res = await h.register(h.doctorBody(code, 'dup@example.com', { pmdcNumber: ' 99999 - p ' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PMDC_EXISTS');

    // The failed attempt released the code, so the applicant can fix the number.
    const retry = await h.register(h.doctorBody(code, 'dup@example.com', { pmdcNumber: '11111-P' }));
    expect(retry.status).toBe(201);
  });

  test('duplicate email is rejected and the code is given back', async () => {
    const { code, invitation } = await h.invite(adminToken, 'taken@example.com');
    await h.createDoctor({ email: 'taken@example.com' }); // account appears after the code was issued

    const res = await h.register(h.doctorBody(code, 'taken@example.com'));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_EXISTS');
    expect((await h.Invitation.findById(invitation.id)).status).toBe('active');
  });

  test('without a valid code the endpoint does not reveal which emails exist', async () => {
    await h.createDoctor({ email: 'exists@example.com' });
    const res = await h.register(h.doctorBody('AAAA-BBBB-CCCC-DDDD', 'exists@example.com'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVITATION_INVALID');
  });

  test('client-supplied role, status and verification fields are ignored', async () => {
    const { code } = await h.invite(adminToken, 'sneaky@example.com');
    const res = await h.register(
      h.doctorBody(code, 'sneaky@example.com', {
        role: 'admin',
        status: 'approved',
        pmdcVerificationStatus: 'verified_by_admin',
        phoneVerified: true,
        reviewedBy: String(admin._id),
        doctorId: 'DOC-1',
      })
    );
    expect(res.status).toBe(201);
    const doctor = await h.User.findOne({ email: 'sneaky@example.com' });
    expect(doctor.role).toBe('doctor');
    expect(doctor.status).toBe('pending');
    expect(doctor.pmdcVerificationStatus).toBe('unverified');
    expect(doctor.phoneVerified).toBe(false);
    expect(doctor.reviewedBy).toBeUndefined();
    expect(doctor.doctorId).not.toBe('DOC-1');
  });

  test.each([
    ['mobile number without country code', { phone: '03001234567' }],
    ['mobile number that is not a number', { phone: 'call me' }],
    ['missing mobile number', { phone: undefined }],
    ['missing PMDC number', { pmdcNumber: undefined }],
    ['malformed PMDC number', { pmdcNumber: '!!' }],
    ['missing hospital', { hospitalName: undefined }],
    ['missing name', { name: undefined }],
    ['short password', { password: 'short' }],
    ['malformed email', { email: 'not-an-email' }],
  ])('rejects %s without consuming the code', async (label, overrides) => {
    const { code, invitation } = await h.invite(adminToken, 'valid@example.com');
    const body = h.doctorBody(code, 'valid@example.com', overrides);
    Object.keys(overrides).forEach((k) => overrides[k] === undefined && delete body[k]);
    const res = await h.register(body);
    expect(res.status).toBe(400);
    expect((await h.Invitation.findById(invitation.id)).status).toBe('active');
  });
});

describe('invitation consumption is atomic', () => {
  test('ten simultaneous consume calls: exactly one wins', async () => {
    const { code } = await h.invite(adminToken, 'race@example.com');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        consumeInvitation({ code, purpose: 'doctor_registration', email: 'race@example.com' })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(9);
  });

  test('simultaneous registrations with one code create exactly one account', async () => {
    const { code } = await h.invite(adminToken, 'parallel@example.com');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.register(h.doctorBody(code, 'parallel@example.com'))
      )
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await h.User.countDocuments({ email: 'parallel@example.com' })).toBe(1);
  });
});

describe('patients are unaffected', () => {
  test('patient login still works with case ID, phone and OTP, no invitation or approval', async () => {
    const doctor = await h.createDoctor();
    const c = await h.createCase(h.tokenFor(doctor));
    const res = await h.api().post('/api/auth/patient-login').send({
      caseId: c.caseId,
      phone: '0300 111 2222',
      otp: '123456',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('patient');
    expect(res.body.token).toBeTruthy();
  });

  test('patient login still rejects a wrong OTP or phone', async () => {
    const doctor = await h.createDoctor();
    const c = await h.createCase(h.tokenFor(doctor));
    expect((await h.api().post('/api/auth/patient-login').send({ caseId: c.caseId, phone: '03001112222', otp: '000000' })).status).toBe(401);
    expect((await h.api().post('/api/auth/patient-login').send({ caseId: c.caseId, phone: '03009999999', otp: '123456' })).status).toBe(401);
  });
});
