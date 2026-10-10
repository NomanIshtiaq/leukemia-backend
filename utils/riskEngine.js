/*
 * Rule-based stand-in for the real ML services (symptom model, CBC model and
 * the blood-smear CNN). The public surface -- analyse() -- is what the
 * controllers depend on, so the internals can be swapped for HTTP calls to the
 * inference service without touching the routes.
 */

const SYMPTOM_WEIGHTS = {
  fatigue: 10,
  fever: 12,
  weightLoss: 16,
  frequentInfections: 16,
  easyBruising: 18,
  bonePain: 14,
  nightSweats: 14,
};

const SYMPTOM_LABELS = {
  fatigue: 'persistent fatigue',
  fever: 'fever',
  weightLoss: 'unexplained weight loss',
  frequentInfections: 'frequent infections',
  easyBruising: 'easy bruising or bleeding',
  bonePain: 'bone pain',
  nightSweats: 'night sweats',
};

const CBC_REFERENCE = {
  wbc: { label: 'WBC count', unit: 'x10^3/uL', low: 4.0, high: 11.0, weight: 0.35 },
  hemoglobin: { label: 'hemoglobin', unit: 'g/dL', low: 12.0, high: 17.5, weight: 0.25 },
  platelets: { label: 'platelet count', unit: 'x10^3/uL', low: 150, high: 450, weight: 0.25 },
  rbc: { label: 'RBC count', unit: 'x10^6/uL', low: 4.2, high: 5.9, weight: 0.15 },
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round = (n) => Math.round(n);

const hasValue = (v) => typeof v === 'number' && Number.isFinite(v);

// Cheap deterministic hash so the same image reference always yields the same
// mock classification.
const hashToUnit = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
};

const scoreSymptoms = (symptoms = {}) => {
  const present = Object.keys(SYMPTOM_WEIGHTS).filter((key) => symptoms[key] === true);
  const score = present.reduce((sum, key) => sum + SYMPTOM_WEIGHTS[key], 0);
  return { score, present };
};

const scoreCbc = (cbc = {}) => {
  let weighted = 0;
  let weightUsed = 0;
  const abnormal = [];

  Object.entries(CBC_REFERENCE).forEach(([key, ref]) => {
    const value = cbc[key];
    if (!hasValue(value)) return;

    let severity = 0;
    let direction = null;

    if (value < ref.low) {
      severity = clamp((ref.low - value) / (ref.low * 0.5), 0, 1);
      direction = 'low';
    } else if (value > ref.high) {
      severity = clamp((value - ref.high) / ref.high, 0, 1);
      direction = 'high';
    }

    weighted += severity * ref.weight;
    weightUsed += ref.weight;

    if (direction) {
      abnormal.push({ key, label: ref.label, value, unit: ref.unit, direction });
    }
  });

  if (weightUsed === 0) return { score: null, abnormal };
  return { score: round((weighted / weightUsed) * 100), abnormal };
};

const classifyImage = (imageUrl, priorScore) => {
  if (!imageUrl) {
    return { imageClass: 'Not provided', imageConfidence: 0, blastProbability: null };
  }

  const jitter = (hashToUnit(imageUrl) - 0.5) * 0.2;
  const blastProbability = clamp(priorScore / 100 + jitter, 0.02, 0.98);
  const suspected = blastProbability >= 0.5;
  const confidence = suspected ? blastProbability : 1 - blastProbability;

  return {
    imageClass: suspected ? 'Blast Cells Suspected' : 'Normal',
    imageConfidence: round(clamp(confidence, 0.55, 0.99) * 100),
    blastProbability,
  };
};

const levelFor = (score) => {
  if (score >= 65) return 'High';
  if (score >= 35) return 'Moderate';
  return 'Low';
};

const buildSummary = ({ symptoms, cbc, image, overallRisk, overallScore }) => {
  const lines = [];

  if (symptoms.present.length) {
    const names = symptoms.present.map((k) => SYMPTOM_LABELS[k]).join(', ');
    lines.push(
      `Reported symptoms (${names}) raised the symptom risk to ${symptoms.score}/100, ` +
        'with easy bruising, weight loss and recurrent infections carrying the most weight.'
    );
  } else {
    lines.push('No leukemia-associated symptoms were reported, which keeps the symptom risk low.');
  }

  if (cbc.score === null) {
    lines.push('No CBC values were supplied, so blood count analysis was not included in the score.');
  } else if (cbc.abnormal.length) {
    const items = cbc.abnormal
      .map((a) => `${a.label} ${a.direction} (${a.value} ${a.unit})`)
      .join('; ');
    lines.push(`CBC findings outside the reference range: ${items}. Blood count risk is ${cbc.score}/100.`);
  } else {
    lines.push(`All supplied CBC parameters are within reference limits (blood count risk ${cbc.score}/100).`);
  }

  if (image.blastProbability === null) {
    lines.push('No peripheral smear image was provided; the imaging component was skipped.');
  } else if (image.imageClass === 'Normal') {
    lines.push(
      `The smear image was classified as normal with ${image.imageConfidence}% confidence; ` +
        'no dominant blast-like morphology was highlighted.'
    );
  } else {
    lines.push(
      `The smear image was classified as ${image.imageClass.toLowerCase()} ` +
        `(${image.imageConfidence}% confidence), with attention concentrated on large nuclei and reduced cytoplasm.`
    );
  }

  lines.push(
    `Combining the available modalities gives an overall risk of ${overallRisk.toLowerCase()} (${overallScore}/100). ` +
      'This output is decision support only and must be confirmed by a haematologist, ' +
      'including bone marrow evaluation where indicated.'
  );

  return lines.join(' ');
};

const MODALITY_WEIGHTS = { symptoms: 0.25, cbc: 0.4, image: 0.35 };

const analyse = ({ symptoms, cbcData, imageUrl } = {}) => {
  const symptomResult = scoreSymptoms(symptoms);
  const cbcResult = scoreCbc(cbcData);

  const hasCbc = cbcResult.score !== null;
  const priorScore = hasCbc
    ? 0.6 * cbcResult.score + 0.4 * symptomResult.score
    : symptomResult.score;

  const image = classifyImage(imageUrl, priorScore);

  const parts = [{ weight: MODALITY_WEIGHTS.symptoms, score: symptomResult.score }];
  if (hasCbc) parts.push({ weight: MODALITY_WEIGHTS.cbc, score: cbcResult.score });
  if (image.blastProbability !== null) {
    parts.push({ weight: MODALITY_WEIGHTS.image, score: image.blastProbability * 100 });
  }

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const overallScore = round(parts.reduce((s, p) => s + p.score * p.weight, 0) / totalWeight);
  const overallRisk = levelFor(overallScore);

  return {
    symptomRisk: symptomResult.score,
    cbcRisk: hasCbc ? cbcResult.score : 0,
    imageClass: image.imageClass,
    imageConfidence: image.imageConfidence,
    overallRisk,
    xaiSummary: buildSummary({
      symptoms: symptomResult,
      cbc: cbcResult,
      image,
      overallRisk,
      overallScore,
    }),
  };
};

module.exports = { analyse, CBC_REFERENCE, SYMPTOM_LABELS };
