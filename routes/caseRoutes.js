const crypto = require('crypto');
const express = require('express');
const PatientCase = require('../models/PatientCase');
const { protect, authorize, requireApprovedDoctor } = require('../middleware/authMiddleware');
const { recordAudit } = require('../utils/audit');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { normalizePhone, requireString, escapeRegex } = require('../utils/helpers');
const { analyse } = require('../utils/riskEngine');
const { generateReport } = require('../utils/pdfReport');

const router = express.Router();

const SYMPTOM_KEYS = [
  'fatigue',
  'fever',
  'weightLoss',
  'frequentInfections',
  'easyBruising',
  'bonePain',
  'nightSweats',
];
const CBC_KEYS = ['wbc', 'rbc', 'hemoglobin', 'platelets'];
const AI_KEYS = [
  'symptomRisk',
  'cbcRisk',
  'imageClass',
  'imageConfidence',
  'overallRisk',
  'xaiSummary',
];
const GENDERS = ['male', 'female', 'other'];
const STATUSES = ['pending', 'completed'];

const pickSymptoms = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return SYMPTOM_KEYS.reduce((acc, key) => {
    acc[key] = source[key] === true || source[key] === 'true';
    return acc;
  }, {});
};

const pickCbc = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return CBC_KEYS.reduce((acc, key) => {
    const raw = source[key];
    if (raw === undefined || raw === null || raw === '') return acc;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new ApiError(400, `cbcData.${key} must be a non-negative number`);
    }
    acc[key] = value;
    return acc;
  }, {});
};

const pickImageUrl = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseAge = (value) => {
  const age = Number(value);
  if (!Number.isFinite(age) || age < 0 || age > 120) {
    throw new ApiError(400, 'Age must be a number between 0 and 120');
  }
  return age;
};

const parseGender = (value) => {
  const gender = String(value || '').toLowerCase();
  if (!GENDERS.includes(gender)) {
    throw new ApiError(400, `Gender must be one of: ${GENDERS.join(', ')}`);
  }
  return gender;
};

const generateCaseId = async () => {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    const candidate = `LK-${year}-${suffix}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await PatientCase.exists({ caseId: candidate }))) return candidate;
  }
  throw new ApiError(500, 'Could not allocate a unique case ID, please retry');
};

const ownsCase = (user, patientCase) => {
  if (user.role === 'doctor') {
    const owner = patientCase.doctorId._id || patientCase.doctorId;
    return String(owner) === String(user.id);
  }
  return user.role === 'patient' && patientCase.caseId === user.caseId;
};

router.post(
  '/mock-predict',
  protect,
  authorize('doctor'),
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    const symptoms = pickSymptoms(req.body.symptoms);
    const cbcData = pickCbc(req.body.cbcData);
    const imageUrl = pickImageUrl(req.body.imageUrl);

    const results = analyse({ symptoms, cbcData, imageUrl });

    res.json({
      success: true,
      results,
      generatedAt: new Date().toISOString(),
    });
  })
);

router.post(
  '/create',
  protect,
  authorize('doctor'),
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    const patientName = requireString(req.body.patientName, 'Patient name');
    const phone = normalizePhone(requireString(req.body.phone, 'Phone number'));

    const age = Number(req.body.age);
    if (!Number.isFinite(age) || age < 0 || age > 120) {
      throw new ApiError(400, 'Age must be a number between 0 and 120');
    }

    const gender = String(req.body.gender || '').toLowerCase();
    if (!GENDERS.includes(gender)) {
      throw new ApiError(400, `Gender must be one of: ${GENDERS.join(', ')}`);
    }

    let caseId;
    if (typeof req.body.caseId === 'string' && req.body.caseId.trim()) {
      caseId = req.body.caseId.trim().toUpperCase();
      if (await PatientCase.exists({ caseId })) {
        throw new ApiError(409, 'A case with this ID already exists');
      }
    } else {
      caseId = await generateCaseId();
    }

    const symptoms = pickSymptoms(req.body.symptoms);
    const cbcData = pickCbc(req.body.cbcData);
    const imageUrl = pickImageUrl(req.body.imageUrl);

    // Reuse results sent by the client (e.g. from a prior /mock-predict call)
    // so the saved record matches what the doctor reviewed on screen.
    // An object (even an empty one) is stored as sent, which lets a client open
    // a case before any analysis has run. Without it the server scores the case.
    const supplied = req.body.aiResults;
    const aiResults =
      supplied && typeof supplied === 'object'
        ? AI_KEYS.reduce((acc, key) => {
            if (supplied[key] !== undefined && supplied[key] !== null) acc[key] = supplied[key];
            return acc;
          }, {})
        : analyse({ symptoms, cbcData, imageUrl });

    const status = STATUSES.includes(req.body.status) ? req.body.status : 'completed';

    const patientCase = await PatientCase.create({
      caseId,
      patientName,
      age,
      gender,
      phone,
      doctorId: req.user.id,
      symptoms,
      cbcData,
      imageUrl,
      aiResults,
      doctorNotes: typeof req.body.doctorNotes === 'string' ? req.body.doctorNotes : undefined,
      status,
    });

    res.status(201).json({
      success: true,
      message: 'Patient case saved',
      case: patientCase,
    });
  })
);

router.get(
  '/doctor',
  protect,
  authorize('doctor'),
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    // Archived cases are hidden by default; ?archived=true lists only those.
    const filter = {
      doctorId: req.user.id,
      archivedAt: req.query.archived === 'true' ? { $ne: null } : null,
    };

    if (STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }

    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const pattern = new RegExp(escapeRegex(req.query.q.trim()), 'i');
      filter.$or = [{ patientName: pattern }, { caseId: pattern }];
    }

    const cases = await PatientCase.find(filter).sort({ createdAt: -1 });

    res.json({ success: true, count: cases.length, cases });
  })
);

router.get(
  '/patient/:caseId',
  protect,
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId.toUpperCase();
    const patientCase = await PatientCase.findOne({ caseId }).populate('doctorId', 'name email phone');

    if (!patientCase) throw new ApiError(404, 'Case not found');
    if (!ownsCase(req.user, patientCase)) {
      throw new ApiError(403, 'You do not have access to this case');
    }
    if (req.user.role === 'patient' && patientCase.archivedAt) {
      throw new ApiError(404, 'Case not found');
    }

    // Patients only see clinical data once the doctor has published the report.
    if (req.user.role === 'patient' && patientCase.status !== 'completed') {
      return res.json({
        success: true,
        case: {
          caseId: patientCase.caseId,
          patientName: patientCase.patientName,
          status: patientCase.status,
          createdAt: patientCase.createdAt,
        },
      });
    }

    // First time this patient opens the published report: flag it once so the
    // app can show a "your report is ready" notice. The conditional update means
    // simultaneous requests cannot both claim it.
    let isNewReport = false;
    if (req.user.role === 'patient' && !patientCase.patientViewedAt) {
      const marked = await PatientCase.updateOne(
        { _id: patientCase._id, patientViewedAt: null },
        { $set: { patientViewedAt: new Date() } }
      );
      isNewReport = marked.modifiedCount === 1;
    }

    return res.json({
      success: true,
      case: patientCase,
      ...(req.user.role === 'patient' ? { isNewReport } : {}),
    });
  })
);

router.patch(
  '/:caseId',
  protect,
  authorize('doctor'),
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId.toUpperCase();
    const patientCase = await PatientCase.findOne({ caseId });

    if (!patientCase) throw new ApiError(404, 'Case not found');
    if (!ownsCase(req.user, patientCase)) {
      throw new ApiError(403, 'You do not have access to this case');
    }
    if (patientCase.archivedAt) {
      throw new ApiError(409, 'This case is archived. Restore it before editing.');
    }

    const body = req.body || {};

    // A published report's clinical content is locked; the patient's own
    // details (name, age, gender, phone) can still be corrected.
    const CLINICAL_KEYS = ['symptoms', 'cbcData', 'imageUrl', 'aiResults', 'doctorNotes', 'status'];
    if (patientCase.status === 'completed' && CLINICAL_KEYS.some((key) => body[key] !== undefined)) {
      throw new ApiError(409, 'This report has been published and can no longer be edited');
    }

    if (body.patientName !== undefined) {
      patientCase.patientName = requireString(body.patientName, 'Patient name');
    }
    if (body.age !== undefined) patientCase.age = parseAge(body.age);
    if (body.gender !== undefined) patientCase.gender = parseGender(body.gender);
    if (body.phone !== undefined) {
      patientCase.phone = normalizePhone(requireString(body.phone, 'Phone number'));
    }

    if (body.symptoms !== undefined) patientCase.symptoms = pickSymptoms(body.symptoms);
    if (body.cbcData !== undefined) patientCase.cbcData = pickCbc(body.cbcData);
    if (body.imageUrl !== undefined) patientCase.imageUrl = pickImageUrl(body.imageUrl);

    // null clears a result, a value replaces it, an omitted key is left alone.
    if (body.aiResults && typeof body.aiResults === 'object') {
      AI_KEYS.forEach((key) => {
        const value = body.aiResults[key];
        if (value === undefined) return;
        patientCase.set(`aiResults.${key}`, value === null ? undefined : value);
      });
    }

    if (typeof body.doctorNotes === 'string') patientCase.doctorNotes = body.doctorNotes.trim();

    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) {
        throw new ApiError(400, `Status must be one of: ${STATUSES.join(', ')}`);
      }
      if (body.status === 'completed') {
        const r = patientCase.aiResults || {};
        const complete =
          r.symptomRisk != null &&
          r.cbcRisk != null &&
          r.imageClass &&
          r.overallRisk &&
          r.xaiSummary;
        if (!complete) {
          throw new ApiError(400, 'Complete the symptom, CBC and smear image analyses before publishing');
        }
        patientCase.status = 'completed';
        patientCase.publishedAt = new Date();
      }
    }

    const publishing = patientCase.isModified('status') && patientCase.status === 'completed';
    await patientCase.save();
    if (publishing) {
      await recordAudit(req, 'case.publish', { targetType: 'case', targetId: patientCase.caseId });
    }

    res.json({ success: true, message: 'Case updated', case: patientCase });
  })
);

// Soft delete: hides the case from lists and from the patient portal.
router.post(
  '/:caseId/archive',
  protect,
  authorize('doctor'),
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId.toUpperCase();
    const patientCase = await PatientCase.findOne({ caseId });
    if (!patientCase) throw new ApiError(404, 'Case not found');
    if (!ownsCase(req.user, patientCase)) {
      throw new ApiError(403, 'You do not have access to this case');
    }

    const archived = await PatientCase.findOneAndUpdate(
      { _id: patientCase._id, archivedAt: null },
      { $set: { archivedAt: new Date() } },
      { new: true }
    );
    if (!archived) throw new ApiError(409, 'This case is already archived');

    await recordAudit(req, 'case.archive', { targetType: 'case', targetId: caseId });
    res.json({ success: true, message: 'Case archived', case: archived });
  })
);

router.post(
  '/:caseId/restore',
  protect,
  authorize('doctor'),
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId.toUpperCase();
    const patientCase = await PatientCase.findOne({ caseId });
    if (!patientCase) throw new ApiError(404, 'Case not found');
    if (!ownsCase(req.user, patientCase)) {
      throw new ApiError(403, 'You do not have access to this case');
    }

    const restored = await PatientCase.findOneAndUpdate(
      { _id: patientCase._id, archivedAt: { $ne: null } },
      { $unset: { archivedAt: 1 } },
      { new: true }
    );
    if (!restored) throw new ApiError(409, 'This case is not archived');

    await recordAudit(req, 'case.restore', { targetType: 'case', targetId: caseId });
    res.json({ success: true, message: 'Case restored', case: restored });
  })
);

// Permanent deletion is only possible for a case that was archived first.
router.delete(
  '/:caseId',
  protect,
  authorize('doctor'),
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId.toUpperCase();
    const patientCase = await PatientCase.findOne({ caseId });
    if (!patientCase) throw new ApiError(404, 'Case not found');
    if (!ownsCase(req.user, patientCase)) {
      throw new ApiError(403, 'You do not have access to this case');
    }
    if (!patientCase.archivedAt) {
      throw new ApiError(409, 'Archive the case first; only archived cases can be deleted permanently');
    }

    await PatientCase.deleteOne({ _id: patientCase._id, archivedAt: { $ne: null } });
    await recordAudit(req, 'case.delete', { targetType: 'case', targetId: caseId });
    res.json({ success: true, message: 'Case deleted permanently' });
  })
);

router.get(
  '/pdf/:caseId',
  protect,
  requireApprovedDoctor,
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId.toUpperCase();
    const patientCase = await PatientCase.findOne({ caseId }).populate('doctorId', 'name email phone');

    if (!patientCase) throw new ApiError(404, 'Case not found');
    if (!ownsCase(req.user, patientCase)) {
      throw new ApiError(403, 'You do not have access to this case');
    }

    if (req.user.role === 'patient' && patientCase.archivedAt) {
      throw new ApiError(404, 'Case not found');
    }
    if (req.user.role === 'patient' && patientCase.status !== 'completed') {
      throw new ApiError(403, 'Your report has not been published yet');
    }

    const reportPath = `/api/cases/pdf/${patientCase.caseId}`;
    if (patientCase.pdfReportUrl !== reportPath) {
      await PatientCase.updateOne({ _id: patientCase._id }, { pdfReportUrl: reportPath });
    }

    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="leukemia-report-${patientCase.caseId}.pdf"`
    );

    generateReport(patientCase, res);
  })
);

module.exports = router;
