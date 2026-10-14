# Doctor invitation, approval and admin API

All responses are JSON: `{ "success": true, ... }` or `{ "success": false, "message": "...", "code": "..." }`.
`code` (optional) is a stable string the app can switch on. Send `Authorization: Bearer <token>` on protected calls.

## Workflow

1. Admin signs in (`POST /api/auth/admin-login`) and generates an invitation for a doctor's email (`POST /api/admin/invitations`). The response contains the **code (shown once)** and a ready `wa.me` link.
2. Admin taps *Share via WhatsApp*; WhatsApp opens with the doctor's number and the message prefilled; the admin presses Send. (Nothing is sent by the server.)
3. Doctor registers (`POST /api/auth/doctor-register`) with the code, using the invited email. The account is created as `pending`; **no token is issued**.
4. Admin reviews the application (`GET /api/admin/doctors?status=pending`), checks the PMDC number manually, then approves or rejects.
5. Doctor signs in. Approved → token. Pending/rejected → `403` with a code, no token.

The invitation authorises *applying*; it never approves. The PMDC number is stored as `unverified` until an admin explicitly passes `pmdcChecked: true` when approving. The mobile number is stored with `phoneVerified: false` (the system cannot prove it belongs to the doctor or has WhatsApp).

## Error codes

| HTTP | code | meaning |
|---|---|---|
| 400 | `INVITATION_REQUIRED / INVITATION_INVALID / INVITATION_EXPIRED / INVITATION_REVOKED / INVITATION_USED / INVITATION_EMAIL_MISMATCH` | code problems |
| 403 | `ACCOUNT_PENDING` | application awaiting approval (`status: "pending"`) |
| 403 | `ACCOUNT_REJECTED` | application rejected (`status`, `reason`) |
| 403 | – | wrong role ("You do not have permission…") |
| 401 | – | missing/expired/invalid token, wrong credentials |
| 409 | `EMAIL_EXISTS / PMDC_EXISTS` | duplicates |
| 429 | `RATE_LIMITED` | too many attempts |

## Auth

### POST /api/auth/doctor-register
```json
{ "name": "Dr Ayesha Khan", "email": "ayesha@example.com", "password": "at-least-8-chars",
  "phone": "+92 300 1234567", "pmdcNumber": "12345-P", "hospitalName": "City Hospital",
  "invitationCode": "K7QM-2XWP-9RTC-HN4D" }
```
`201`
```json
{ "success": true, "status": "pending",
  "message": "Application submitted. An administrator will review your credentials; ...",
  "user": { "id": "...", "name": "Dr Ayesha Khan", "email": "ayesha@example.com", "phone": "+923001234567",
            "phoneVerified": false, "role": "doctor", "doctorId": "DOC-1007", "status": "pending",
            "pmdcNumber": "12345-P", "pmdcVerificationStatus": "unverified", "hospitalName": "City Hospital" } }
```
`phone` must include the country code (`+92…`; Pakistan mobiles: `+923XXXXXXXXX`). Any `role`, `status` etc. in the body is ignored.

### POST /api/auth/doctor-login
`200` approved: `{ "success": true, "token": "...", "user": { ..., "status": "approved" } }`
`403` pending: `{ "success": false, "code": "ACCOUNT_PENDING", "status": "pending", "message": "..." }`
`403` rejected: `{ "success": false, "code": "ACCOUNT_REJECTED", "status": "rejected", "reason": "...", "message": "..." }`
`401` wrong email/password (never reveals the status).

### POST /api/auth/admin-login
`{ "email", "password" }` → `{ "success": true, "token": "...", "user": { "id","name","email","role":"admin" } }` (token valid `ADMIN_JWT_EXPIRES_IN`, default 8h).

### POST /api/auth/patient-login — unchanged.

### GET /api/auth/me
Returns the live account (a pending/rejected doctor who holds an old token still gets an answer with their `status`). Use it to validate a stored token on app start.

### POST /api/auth/change-password (approved doctor or admin)
`{ "currentPassword", "newPassword" }` → `{ "success": true, "token": "<fresh token>" }`. Old tokens stop working. Wrong current password is **400** (not 401, so the app does not sign out).

### Forgot password (no e-mail/SMS)
1. `POST /api/auth/forgot-password` `{ "email", "phone" }` → always `200` with the same message (`400` only if `phone` is given but is not a valid international number). `phone` is the doctor's WhatsApp number. The admin sees `passwordResetRequested: true` and `passwordResetPhone`, and the request appears in `GET /api/admin/doctors?status=pending` (the app titles it "Password reset request").
2. Admin: `POST /api/admin/doctors/:id/password-reset-code` → code + WhatsApp link to the number the doctor gave (expires in 1 h). Compare it with the registered `phone` before sending.
3. `POST /api/auth/reset-password` `{ "email", "code", "newPassword" }` → `200`; sign in with the new password.

## Admin (all require an admin token; others get 401/403)

### GET /api/admin/doctors?status=pending|approved|rejected&q=&page=&limit=
Missing `status` = `pending`. Doctors created before this workflow (no stored status) appear under `pending` with `"legacy": true`.
```json
{ "success": true, "status": "pending", "page": 1, "count": 1,
  "counts": { "pending": 3, "approved": 12, "rejected": 1 },
  "doctors": [ { "id": "...", "name": "...", "email": "...", "phone": "+923001234567", "phoneVerified": false,
                 "doctorId": "DOC-1007", "status": "pending", "pmdcNumber": "12345-P",
                 "pmdcVerificationStatus": "unverified", "hospitalName": "City Hospital",
                 "reviewedBy": null, "reviewedAt": null, "reviewNote": null,
                 "passwordResetRequested": false, "legacy": false, "registeredAt": "..." } ] }
```
### GET /api/admin/doctors/:id → `{ "success": true, "doctor": { ... } }`
### POST /api/admin/doctors/:id/approve
`{ "note": "optional", "pmdcChecked": false }` – set `pmdcChecked: true` **only** if you checked the number yourself. `409` if already approved.
### POST /api/admin/doctors/:id/reject
`{ "reason": "required" }` (shown to the doctor). `409` if already rejected. Rejecting an approved doctor withdraws access immediately.
### POST /api/admin/doctors/:id/password-reset-code
`{ "phone": "optional override", "expiresInHours": 1 }` → same shape as invitation creation.

### POST /api/admin/invitations
```json
{ "email": "doctor@example.com", "phone": "+92 300 1234567", "expiresInHours": 24 }
```
`phone` (WhatsApp) and `expiresInHours` (1–168, default 24) are optional. `409` if the email already has an account. A new code for the same email revokes the older active one.
`201` (the **only** response that ever contains the code; `Cache-Control: no-store`)
```json
{ "success": true, "message": "Invitation generated. The code is shown only once; ...",
  "code": "K7QM-2XWP-9RTC-HN4D", "expiresInHours": 24,
  "invitation": { "id": "...", "purpose": "doctor_registration", "intendedEmail": "doctor@example.com",
                  "intendedPhone": "+923001234567", "status": "active", "createdAt": "...", "expiresAt": "..." },
  "whatsapp": { "number": "923001234567",
                "url": "https://wa.me/923001234567?text=Hello!%20You%20have%20been%20invited...",
                "message": "Hello! You have been invited to register as a doctor ..." } }
```
`whatsapp.url` is `null` when no number was supplied → show **Copy code** only.

### GET /api/admin/invitations?status=active|used|revoked|expired&purpose=doctor_registration|password_reset
Metadata only (`id, purpose, intendedEmail, intendedPhone, status, createdAt, expiresAt, usedAt, revokedAt`). Never codes, hashes or links.
### POST /api/admin/invitations/:id/revoke → `{ "reason": "optional" }`; `409` unless the code is still unused.
### GET /api/admin/audit-logs?action=&limit=
Newest first. Actions: `admin.login`, `admin.login_failed`, `invitation.create`, `invitation.revoke`, `password_reset_code.create`, `doctor.register`, `doctor.approve`, `doctor.reject`, `auth.password_changed`, `auth.password_reset_requested`, `auth.password_reset`, `case.publish`, `case.archive`, `case.restore`, `case.delete`.

## Cases (doctor endpoints now require an **approved** doctor)

| Route | Notes |
|---|---|
| `GET /api/cases/doctor` | active cases; `?archived=true` lists archived only |
| `PATCH /api/cases/:caseId` | now also accepts `patientName, age, gender, phone`; clinical fields locked after publish |
| `POST /api/cases/:caseId/archive`, `/restore` | soft delete / undo |
| `DELETE /api/cases/:caseId` | permanent; only for archived cases |
| `GET /api/cases/patient/:caseId` | patient response gains `isNewReport` (true once, on first view of a published report) |

## WhatsApp link rules
`https://wa.me/<digits>?text=<encodeURIComponent(message)>` — number in international format **without** `+`, spaces or punctuation; message URL-encoded. The server builds it; the app only opens it.
