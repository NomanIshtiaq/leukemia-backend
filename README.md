# Leukemia Detection System - Backend

Express + MongoDB REST API for the multi-modal leukemia screening platform.

## Setup

```bash
npm install
cp .env.example .env     # set JWT_SECRET and MONGO_URI
npm run seed             # creates a test doctor and a demo case
npm run dev              # or: npm start
```

Seeded credentials (see `.env.example`):

| Role    | Login                                                        |
|---------|--------------------------------------------------------------|
| Doctor  | `doctor@leukemia.test` / `Doctor@12345`                      |
| Patient | case `LK-DEMO-000001`, phone `03111234567`, OTP `123456`     |

## Endpoints

| Method | Path                         | Auth    | Description                                  |
|--------|------------------------------|---------|----------------------------------------------|
| POST   | `/api/auth/doctor-register`  | -       | Register a doctor                            |
| POST   | `/api/auth/doctor-login`     | -       | Returns JWT + doctor details                 |
| POST   | `/api/auth/patient-login`    | -       | `caseId` + `phone` + `otp` -> JWT            |
| POST   | `/api/cases/mock-predict`    | Doctor  | Simulated multi-modal AI result + XAI text   |
| POST   | `/api/cases/create`          | Doctor  | Save a patient case                          |
| PATCH  | `/api/cases/:caseId`         | Doctor  | Save inputs / partial results, or publish (`status: "completed"`) |
| GET    | `/api/cases/doctor`          | Doctor  | Cases of the logged-in doctor (`?status=&q=`) |
| GET    | `/api/cases/patient/:caseId` | Any     | Case detail (owner doctor or that patient)   |
| GET    | `/api/cases/pdf/:caseId`     | Any     | PDF report (`?download=1` to force download) |
| GET    | `/api/health`                | -       | Liveness / DB state                          |

Send the token as `Authorization: Bearer <token>`.

### Case lifecycle (used by the Flutter app)

1. `POST /api/cases/create` with `status: "pending"` and `aiResults: {}` opens an empty case.
2. `POST /api/cases/mock-predict` scores one stage (or all of them); the app then
   saves the stage with `PATCH /api/cases/:caseId` (`symptoms`, `cbcData`, `imageUrl`,
   and any of the `aiResults` fields; `null` clears a field).
3. `PATCH` with `status: "completed"` and `doctorNotes` publishes the report. It is
   rejected until symptom, CBC and image results and the overall result exist, and a
   published case can no longer be edited.
4. Patients can sign in at any time, but `GET /api/cases/patient/:caseId` returns only
   their name, case ID and status until the case is published, and `GET /api/cases/pdf/:caseId`
   is refused for them until then.

## Example

```bash
curl -X POST localhost:5000/api/cases/mock-predict \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"symptoms":{"fever":true,"easyBruising":true},
       "cbcData":{"wbc":42,"rbc":3.8,"hemoglobin":9.1,"platelets":70},
       "imageUrl":"smear.jpg"}'
```

## Notes

- `utils/riskEngine.js` is the only place that fakes inference. Replace `analyse()` with a call to the real model service when ready.
- Patient OTP is mocked via `MOCK_OTP`. Add a rate limiter and a real SMS provider before going live.
- In development any `http://localhost:<port>` / `127.0.0.1` origin is allowed by CORS (Flutter web runs on a random port). In production only `CORS_ORIGINS` is honoured.
- The image is not uploaded: `imageUrl` is a reference string (the app sends the file name) and the mock classifier only hashes it.
- Set `DOCTOR_REGISTRATION_KEY` to stop open self-registration of doctor accounts.


## Doctor invitations, admin approval and security

Doctor accounts can only be created with a single-use invitation code issued by an administrator (shared over a WhatsApp click-to-chat link), and every new doctor starts as `pending` until an administrator approves them.

- API reference and workflow: [docs/DOCTOR_APPROVAL_API.md](docs/DOCTOR_APPROVAL_API.md)
- First administrator: `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run create-admin` (safe to re-run)
- Doctor accounts created before this feature are treated as `pending`: `npm run list:legacy-doctors`, then approve each one from the admin dashboard
- Tests: set `TEST_MONGO_URI` to a throw-away database whose name contains `test`, then `npm test`
