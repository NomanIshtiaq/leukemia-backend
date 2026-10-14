const h = require('./helpers');

let admin;
let at;

beforeAll(h.connect);
afterAll(h.disconnect);
beforeEach(async () => {
  await h.resetDb();
  admin = await h.createAdmin();
  at = await h.loginAdmin(admin);
});

const get = (path) => h.api().get(path).set(h.auth(at));
const post = (path, body = {}) => h.api().post(path).set(h.auth(at)).send(body);
const forgot = (body) => h.api().post('/api/auth/forgot-password').send(body);

describe('password reset request with a WhatsApp number', () => {
  test('appears in the admin Pending list and the code link goes to the number given', async () => {
    const d = await h.createDoctor({ phone: '+923001234567' });
    const res = await forgot({ email: d.email, phone: '+92 333 5556666' });
    expect(res.status).toBe(200);

    const pending = await get('/api/admin/doctors?status=pending');
    const row = pending.body.doctors.find((x) => x.id === d.id);
    expect(row).toMatchObject({ passwordResetRequested: true, passwordResetPhone: '+923335556666', status: 'approved' });

    const gen = await post(`/api/admin/doctors/${d.id}/password-reset-code`);
    expect(gen.status).toBe(201);
    expect(gen.body.whatsapp.url).toMatch(/^https:\/\/wa\.me\/923335556666\?text=/);

    const reset = await h.api().post('/api/auth/reset-password').send({ email: d.email, code: gen.body.code, newPassword: 'Brand-New-Pass-1' });
    expect(reset.status).toBe(200);
    const after = await h.User.findById(d.id);
    expect(after.passwordResetRequestedAt).toBeUndefined();
    expect(after.passwordResetRequestedPhone).toBeUndefined();
    const pendingAfter = await get('/api/admin/doctors?status=pending');
    expect(pendingAfter.body.doctors.find((x) => x.id === d.id)).toBeUndefined();
  });

  test('doctors who did not ask are not in Pending; the response never reveals if the account exists', async () => {
    const d = await h.createDoctor();
    const known = await forgot({ email: d.email, phone: '+923001234567' });
    const unknown = await forgot({ email: 'ghost@example.com', phone: '+923001234567' });
    expect(known.body).toEqual(unknown.body);

    const other = await h.createDoctor();
    const pending = (await get('/api/admin/doctors?status=pending')).body.doctors;
    expect(pending.find((x) => x.id === other.id)).toBeUndefined();
  });

  test('a malformed number is a 400, and an email-only request still works', async () => {
    const d = await h.createDoctor();
    expect((await forgot({ email: d.email, phone: 'abc' })).status).toBe(400);
    expect((await forgot({ email: d.email })).status).toBe(200);
  });
});
