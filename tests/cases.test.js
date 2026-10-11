const h = require('./helpers');

let doctor;
let token;

beforeAll(h.connect);
afterAll(h.disconnect);
beforeEach(async () => {
  await h.resetDb();
  doctor = await h.createDoctor();
  token = h.tokenFor(doctor);
});

const complete = {
  symptoms: { fever: true },
  cbcData: { wbc: 40, rbc: 3, hemoglobin: 8, platelets: 50 },
  aiResults: { symptomRisk: 60, cbcRisk: 70, imageClass: 'Blast', overallRisk: 'High', xaiSummary: 'x' },
};

const open = (extra = {}) => h.createCase(token, { status: 'pending', aiResults: {}, ...extra });
const patch = (id, body, t = token) => h.api().patch(`/api/cases/${id}`).set(h.auth(t)).send(body);

describe('editing patient details', () => {
  test('doctor can correct name, age, gender and phone', async () => {
    const c = await open();
    const res = await patch(c.caseId, { patientName: 'Fixed Name', age: 41, gender: 'male', phone: '0300 999 8888' });
    expect(res.status).toBe(200);
    expect(res.body.case).toMatchObject({ patientName: 'Fixed Name', age: 41, gender: 'male', phone: '03009998888' });
  });

  test('validates edits', async () => {
    const c = await open();
    expect((await patch(c.caseId, { age: 500 })).status).toBe(400);
    expect((await patch(c.caseId, { gender: 'robot' })).status).toBe(400);
    expect((await patch(c.caseId, { patientName: '   ' })).status).toBe(400);
  });

  test('details stay editable after publishing, but clinical content is locked', async () => {
    const c = await open();
    expect((await patch(c.caseId, { ...complete, status: 'completed', doctorNotes: 'done' })).status).toBe(200);
    expect((await patch(c.caseId, { patientName: 'Typo Fixed' })).status).toBe(200);
    const locked = await patch(c.caseId, { doctorNotes: 'changed' });
    expect(locked.status).toBe(409);
  });
});

describe('archive, restore, delete', () => {
  test('archived cases leave the default list, appear under ?archived=true, and can be restored', async () => {
    const c = await open();
    expect((await h.api().post(`/api/cases/${c.caseId}/archive`).set(h.auth(token)).send({})).status).toBe(200);
    expect((await h.api().get('/api/cases/doctor').set(h.auth(token))).body.count).toBe(0);
    expect((await h.api().get('/api/cases/doctor?archived=true').set(h.auth(token))).body.count).toBe(1);
    expect((await h.api().post(`/api/cases/${c.caseId}/archive`).set(h.auth(token)).send({})).status).toBe(409);

    expect((await patch(c.caseId, { doctorNotes: 'x' })).status).toBe(409); // must restore first

    expect((await h.api().post(`/api/cases/${c.caseId}/restore`).set(h.auth(token)).send({})).status).toBe(200);
    expect((await h.api().get('/api/cases/doctor').set(h.auth(token))).body.count).toBe(1);
    expect((await h.api().post(`/api/cases/${c.caseId}/restore`).set(h.auth(token)).send({})).status).toBe(409);
  });

  test('permanent delete needs the case to be archived first', async () => {
    const c = await open();
    expect((await h.api().delete(`/api/cases/${c.caseId}`).set(h.auth(token))).status).toBe(409);
    await h.api().post(`/api/cases/${c.caseId}/archive`).set(h.auth(token)).send({});
    expect((await h.api().delete(`/api/cases/${c.caseId}`).set(h.auth(token))).status).toBe(200);
    expect(await h.PatientCase.countDocuments({ caseId: c.caseId })).toBe(0);
    expect((await h.api().delete(`/api/cases/${c.caseId}`).set(h.auth(token))).status).toBe(404);
  });

  test('legacy cases without archivedAt still show up as active', async () => {
    const c = await open();
    await h.PatientCase.collection.updateOne({ caseId: c.caseId }, { $unset: { archivedAt: '' } });
    expect((await h.api().get('/api/cases/doctor').set(h.auth(token))).body.count).toBe(1);
  });

  test('patients can no longer sign in to, or read, an archived case', async () => {
    const c = await open();
    const pt = h.patientToken(await h.PatientCase.findOne({ caseId: c.caseId }));
    await h.api().post(`/api/cases/${c.caseId}/archive`).set(h.auth(token)).send({});
    const login = await h.api().post('/api/auth/patient-login').send({ caseId: c.caseId, phone: '03001112222', otp: '123456' });
    expect(login.status).toBe(401);
    expect((await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(pt))).status).toBe(404);
  });
});

describe('report-published notice for patients', () => {
  test('patient sees isNewReport exactly once after publication', async () => {
    const c = await open();
    const pt = h.patientToken(await h.PatientCase.findOne({ caseId: c.caseId }));

    const before = await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(pt));
    expect(before.body.case.status).toBe('pending');
    expect(before.body.isNewReport).toBeUndefined();

    await patch(c.caseId, { ...complete, status: 'completed', doctorNotes: 'done' });

    const first = await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(pt));
    expect(first.body.case.status).toBe('completed');
    expect(first.body.isNewReport).toBe(true);
    const second = await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(pt));
    expect(second.body.isNewReport).toBe(false);

    // The owning doctor's view is not flagged.
    const doc = await h.api().get(`/api/cases/patient/${c.caseId}`).set(h.auth(token));
    expect(doc.body.isNewReport).toBeUndefined();
  });

  test('published reports download as PDF for the patient and the doctor', async () => {
    const c = await open();
    await patch(c.caseId, { ...complete, status: 'completed', doctorNotes: 'done' });
    const pt = h.patientToken(await h.PatientCase.findOne({ caseId: c.caseId }));
    const p = await h.api().get(`/api/cases/pdf/${c.caseId}`).set(h.auth(pt));
    expect(p.status).toBe(200);
    expect(p.headers['content-type']).toMatch(/pdf/);
    expect((await h.api().get(`/api/cases/pdf/${c.caseId}`).set(h.auth(token))).status).toBe(200);
  });
});
