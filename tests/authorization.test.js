const h = require('./helpers');

beforeAll(h.connect);
afterAll(h.disconnect);
beforeEach(h.resetDb);

// Every doctor-only endpoint, as [label, method, path builder, body].
const doctorEndpoints = (caseId = 'LK-X-1') => [
  ['GET /api/cases/doctor', 'get', '/api/cases/doctor'],
  ['POST /api/cases/mock-predict', 'post', '/api/cases/mock-predict', { symptoms: { fever: true } }],
  ['POST /api/cases/create', 'post', '/api/cases/create', h.caseBody()],
  ['GET /api/cases/patient/:id', 'get', `/api/cases/patient/${caseId}`],
  ['GET /api/cases/pdf/:id', 'get', `/api/cases/pdf/${caseId}`],
  ['PATCH /api/cases/:id', 'patch', `/api/cases/${caseId}`, { doctorNotes: 'x' }],
  ['POST /api/cases/:id/archive', 'post', `/api/cases/${caseId}/archive`, {}],
  ['POST /api/cases/:id/restore', 'post', `/api/cases/${caseId}/restore`, {}],
  ['DELETE /api/cases/:id', 'delete', `/api/cases/${caseId}`],
];

const call = (ep, token) => {
  const [, method, path, body] = ep;
  let r = h.api()[method](path);
  if (token) r = r.set(h.auth(token));
  return body ? r.send(body) : r;
};

describe('doctor sign-in and approval status', () => {
  test('approved doctor signs in and receives a token', async () => {
    const d = await h.createDoctor();
    const res = await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.status).toBe('approved');
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
  });

  test('pending doctor gets 403 ACCOUNT_PENDING and NO token', async () => {
    const d = await h.createDoctor({ status: 'pending' });
    const res = await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_PENDING');
    expect(res.body.status).toBe('pending');
    expect(res.body.token).toBeUndefined();
  });

  test('rejected doctor gets 403 ACCOUNT_REJECTED with the reason and no token', async () => {
    const d = await h.createDoctor({ status: 'rejected', reviewNote: 'PMDC number could not be confirmed' });
    const res = await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_REJECTED');
    expect(res.body.reason).toBe('PMDC number could not be confirmed');
    expect(res.body.token).toBeUndefined();
  });

  test('legacy doctor (no stored status) is NOT silently approved', async () => {
    const d = await h.createLegacyDoctor();
    expect(d.status).toBeUndefined();
    const res = await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_PENDING');
  });

  test('wrong password or unknown email: 401 and no status disclosure', async () => {
    const d = await h.createDoctor({ status: 'pending' });
    const wrong = await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: 'wrong-password-1' });
    const unknown = await h.api().post('/api/auth/doctor-login').send({ email: 'nobody@example.com', password: 'wrong-password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
    expect(wrong.body.status).toBeUndefined();
  });

  test('an admin cannot sign in through the doctor endpoint, nor a doctor through the admin one', async () => {
    const a = await h.createAdmin();
    const d = await h.createDoctor();
    expect((await h.api().post('/api/auth/doctor-login').send({ email: a.email, password: h.PASSWORD })).status).toBe(401);
    expect((await h.api().post('/api/auth/admin-login').send({ email: d.email, password: h.PASSWORD })).status).toBe(401);
  });
});

describe('pending, rejected and legacy doctors cannot use protected endpoints', () => {
  test.each([
    ['pending', 'ACCOUNT_PENDING'],
    ['rejected', 'ACCOUNT_REJECTED'],
  ])('%s doctor holding a token is blocked everywhere', async (status, code) => {
    const owner = await h.createDoctor();
    const c = await h.createCase(h.tokenFor(owner));
    const blocked = await h.createDoctor({ status });
    const token = h.tokenFor(blocked);

    for (const ep of doctorEndpoints(c.caseId)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(ep, token);
      expect([ep[0], res.status, res.body.code]).toEqual([ep[0], 403, code]);
    }
  });

  test('legacy doctor holding a token is blocked everywhere', async () => {
    const legacy = await h.createLegacyDoctor();
    const token = h.tokenFor(legacy);
    for (const ep of doctorEndpoints()) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(ep, token);
      expect([ep[0], res.status]).toEqual([ep[0], 403]);
    }
  });

  test('approval is re-checked on every request: a doctor rejected after login loses access immediately', async () => {
    const d = await h.createDoctor();
    const login = await h.api().post('/api/auth/doctor-login').send({ email: d.email, password: h.PASSWORD });
    const token = login.body.token;
    expect((await h.api().get('/api/cases/doctor').set(h.auth(token))).status).toBe(200);

    await h.User.updateOne({ _id: d._id }, { status: 'rejected' });
    expect((await h.api().get('/api/cases/doctor').set(h.auth(token))).status).toBe(403);
  });

  test('a pending doctor can still ask who they are (GET /me) to see their status', async () => {
    const d = await h.createDoctor({ status: 'pending' });
    const res = await h.api().get('/api/auth/me').set(h.auth(h.tokenFor(d)));
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('pending');
  });
});

describe('approved doctors', () => {
  test('can use the permitted endpoints', async () => {
    const d = await h.createDoctor();
    const token = h.tokenFor(d);
    expect((await h.api().post('/api/cases/mock-predict').set(h.auth(token)).send({ symptoms: { fever: true } })).status).toBe(200);
    const c = await h.createCase(token);
    expect((await h.api().get('/api/cases/doctor').set(h.auth(token))).body.count).toBe(1);
    expect((await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(token))).status).toBe(200);
  });

  test('cannot read or change another doctor\'s records', async () => {
    const a = await h.createDoctor();
    const b = await h.createDoctor();
    const c = await h.createCase(h.tokenFor(a));
    const tb = h.tokenFor(b);

    expect((await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(tb))).status).toBe(403);
    expect((await h.api().get(`/api/cases/pdf/${c.caseId}`).set(h.auth(tb))).status).toBe(403);
    expect((await h.api().patch(`/api/cases/${c.caseId}`).set(h.auth(tb)).send({ doctorNotes: 'hijack' })).status).toBe(403);
    expect((await h.api().post(`/api/cases/${c.caseId}/archive`).set(h.auth(tb)).send({})).status).toBe(403);
    expect((await h.api().delete(`/api/cases/${c.caseId}`).set(h.auth(tb))).status).toBe(403);
    expect((await h.api().get('/api/cases/doctor').set(h.auth(tb))).body.count).toBe(0);
    expect((await h.PatientCase.findOne({ caseId: c.caseId })).doctorNotes).toBeUndefined();
  });
});

describe('patients', () => {
  let doctor;
  let c;
  beforeEach(async () => {
    doctor = await h.createDoctor();
    // The Flutter app always opens cases as 'pending' (the API default is 'completed').
    c = await h.createCase(h.tokenFor(doctor), { status: 'pending', aiResults: {} });
  });

  test.each(doctorEndpoints().filter((e) => !e[0].includes(':id') || e[0].startsWith('GET /api/cases/patient') === false && e[0].startsWith('GET /api/cases/pdf') === false).map((e) => [e[0], e]))(
    'cannot call doctor-only endpoint %s',
    async (label, ep) => {
      const [, method, path, body] = ep;
      const real = path.replace('LK-X-1', c.caseId);
      let r = h.api()[method](real).set(h.auth(h.patientToken(await h.PatientCase.findOne({ caseId: c.caseId }))));
      if (body) r = r.send(body);
      const res = await r;
      expect(res.status).toBe(403);
    }
  );

  test('can read only their own case; another case is forbidden', async () => {
    const other = await h.createCase(h.tokenFor(doctor), { patientName: 'Other', phone: '03005550000' });
    const tok = h.patientToken(await h.PatientCase.findOne({ caseId: c.caseId }));
    expect((await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(tok))).status).toBe(200);
    expect((await h.api().get(`/api/cases/patient/${other.caseId}`).set(h.auth(tok))).status).toBe(403);
    expect((await h.api().get(`/api/cases/pdf/${other.caseId}`).set(h.auth(tok))).status).toBe(403);
  });

  test('see only limited data until the report is published, and no PDF', async () => {
    const tok = h.patientToken(await h.PatientCase.findOne({ caseId: c.caseId }));
    const res = await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(tok));
    expect(res.body.case.status).toBe('pending');
    expect(res.body.case.symptoms).toBeUndefined();
    expect((await h.api().get(`/api/cases/pdf/${c.caseId}`).set(h.auth(tok))).status).toBe(403);
  });

  test('cannot use admin endpoints', async () => {
    const tok = h.patientToken(await h.PatientCase.findOne({ caseId: c.caseId }));
    expect((await h.api().get('/api/admin/doctors').set(h.auth(tok))).status).toBe(403);
    expect((await h.api().post('/api/admin/invitations').set(h.auth(tok)).send({ email: 'x@example.com' })).status).toBe(403);
  });
});

describe('admin endpoints are administrator-only', () => {
  const adminEndpoints = (id = '64b000000000000000000001') => [
    ['get', '/api/admin/doctors'],
    ['get', `/api/admin/doctors/${id}`],
    ['post', `/api/admin/doctors/${id}/approve`, {}],
    ['post', `/api/admin/doctors/${id}/reject`, { reason: 'x' }],
    ['post', `/api/admin/doctors/${id}/password-reset-code`, {}],
    ['get', '/api/admin/invitations'],
    ['post', '/api/admin/invitations', { email: 'a@example.com' }],
    ['post', `/api/admin/invitations/${id}/revoke`, {}],
    ['get', '/api/admin/audit-logs'],
  ];

  test('anonymous callers get 401', async () => {
    for (const [method, path, body] of adminEndpoints()) {
      // eslint-disable-next-line no-await-in-loop
      const res = await (body ? h.api()[method](path).send(body) : h.api()[method](path));
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });

  test('approved doctors get 403 on every admin endpoint', async () => {
    const d = await h.createDoctor();
    for (const [method, path, body] of adminEndpoints(d.id)) {
      // eslint-disable-next-line no-await-in-loop
      const r = h.api()[method](path).set(h.auth(h.tokenFor(d)));
      // eslint-disable-next-line no-await-in-loop
      const res = await (body ? r.send(body) : r);
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  test('a doctor cannot approve their own application', async () => {
    const d = await h.createDoctor({ status: 'pending' });
    const res = await h.api().post(`/api/admin/doctors/${d.id}/approve`).set(h.auth(h.tokenFor(d))).send({});
    expect(res.status).toBe(403);
    expect((await h.User.findById(d.id)).status).toBe('pending');
  });

  test('a doctor token cannot be turned into an admin by claiming the role', async () => {
    const d = await h.createDoctor();
    // A token that merely CLAIMS role admin for a doctor's id is rejected: the role is read from the database.
    const forged = h.tokenFor(d, 'admin');
    expect((await h.api().get('/api/admin/doctors').set(h.auth(forged))).status).toBe(401);
  });

  test('there is no public way to create an admin', async () => {
    expect((await h.api().post('/api/auth/admin-register').send({ email: 'x@example.com', password: h.PASSWORD })).status).toBe(404);
    expect((await h.api().post('/api/auth/doctor-register').send({ email: 'x@example.com', password: h.PASSWORD, role: 'admin' })).status).toBe(400);
    expect(await h.User.countDocuments({ role: 'admin' })).toBe(0);
  });

  test('admins cannot read patient records through the doctor/patient case endpoints', async () => {
    const doctor = await h.createDoctor();
    const c = await h.createCase(h.tokenFor(doctor));
    const a = await h.createAdmin();
    const tok = h.tokenFor(a);
    expect((await h.api().get('/api/cases/doctor').set(h.auth(tok))).status).toBe(403);
    expect((await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(tok))).status).toBe(403);
    expect((await h.api().get(`/api/cases/pdf/${c.caseId}`).set(h.auth(tok))).status).toBe(403);
  });
});

describe('tokens', () => {
  test('missing, malformed and tampered tokens are rejected', async () => {
    expect((await h.api().get('/api/cases/doctor')).status).toBe(401);
    expect((await h.api().get('/api/cases/doctor').set('Authorization', 'Bearer not-a-token')).status).toBe(401);
    const d = await h.createDoctor();
    const good = h.tokenFor(d);
    expect((await h.api().get('/api/cases/doctor').set(h.auth(`${good}x`))).status).toBe(401);
  });

  test('a deleted account\'s token stops working', async () => {
    const d = await h.createDoctor();
    const token = h.tokenFor(d);
    await h.User.deleteOne({ _id: d._id });
    expect((await h.api().get('/api/cases/doctor').set(h.auth(token))).status).toBe(401);
  });
});
