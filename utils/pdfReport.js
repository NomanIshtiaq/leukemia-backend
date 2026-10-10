const PDFDocument = require('pdfkit');
const { CBC_REFERENCE, SYMPTOM_LABELS } = require('./riskEngine');

const COLORS = {
  primary: '#12355b',
  text: '#1f2933',
  muted: '#6b7280',
  line: '#d9dee5',
  band: '#f3f5f8',
  High: '#b42318',
  Moderate: '#b54708',
  Low: '#067647',
};

const MARGIN = 50;

const formatDate = (date) =>
  new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const capitalize = (s = '') => s.charAt(0).toUpperCase() + s.slice(1);

const contentWidth = (doc) => doc.page.width - MARGIN * 2;

const ensureSpace = (doc, needed) => {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom - 30) {
    doc.addPage();
  }
};

const sectionTitle = (doc, title) => {
  ensureSpace(doc, 70);
  doc.moveDown(0.9);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.primary).text(title.toUpperCase(), MARGIN, doc.y);
  const y = doc.y + 3;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + contentWidth(doc), y).lineWidth(0.8).strokeColor(COLORS.line).stroke();
  doc.y = y + 10;
  doc.x = MARGIN;
};

const infoGrid = (doc, items) => {
  const colWidth = contentWidth(doc) / 2;
  for (let i = 0; i < items.length; i += 2) {
    ensureSpace(doc, 34);
    const y = doc.y;
    items.slice(i, i + 2).forEach(([label, value], idx) => {
      const x = MARGIN + idx * colWidth;
      doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted)
        .text(label.toUpperCase(), x, y, { width: colWidth - 12, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
        .text(String(value), x, y + 11, { width: colWidth - 12, lineBreak: false });
    });
    doc.y = y + 32;
  }
  doc.x = MARGIN;
};

const drawHeader = (doc, patientCase) => {
  doc.rect(0, 0, doc.page.width, 78).fill(COLORS.primary);
  doc.font('Helvetica-Bold').fontSize(17).fillColor('#ffffff')
    .text('Leukemia Screening Report', MARGIN, 24, { lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor('#c9d6e8')
    .text('AI-assisted multi-modal analysis', MARGIN, 47, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff')
    .text(patientCase.caseId, MARGIN, 28, { width: contentWidth(doc), align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor('#c9d6e8')
    .text(`Issued ${formatDate(new Date())}`, MARGIN, 47, { width: contentWidth(doc), align: 'right', lineBreak: false });
  doc.y = 100;
  doc.x = MARGIN;
};

const cbcFlag = (value, ref) => {
  if (typeof value !== 'number') return { text: '-', color: COLORS.muted };
  if (value < ref.low) return { text: 'LOW', color: COLORS.High };
  if (value > ref.high) return { text: 'HIGH', color: COLORS.High };
  return { text: 'Normal', color: COLORS.Low };
};

const drawCbcTable = (doc, cbc = {}) => {
  const cols = [
    { title: 'Parameter', x: MARGIN + 8, width: 190 },
    { title: 'Result', x: MARGIN + 205, width: 80 },
    { title: 'Reference range', x: MARGIN + 290, width: 120 },
    { title: 'Flag', x: MARGIN + 420, width: 70 },
  ];

  ensureSpace(doc, 24 + Object.keys(CBC_REFERENCE).length * 22);

  let y = doc.y;
  doc.rect(MARGIN, y, contentWidth(doc), 20).fill(COLORS.band);
  cols.forEach((c) => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.muted)
      .text(c.title.toUpperCase(), c.x, y + 6, { width: c.width, lineBreak: false });
  });
  y += 20;

  ['wbc', 'rbc', 'hemoglobin', 'platelets'].forEach((key) => {
    const ref = CBC_REFERENCE[key];
    const value = cbc[key];
    const flag = cbcFlag(value, ref);
    const label = `${capitalize(ref.label.replace('count', 'Count'))}`;

    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.text)
      .text(label, cols[0].x, y + 6, { width: cols[0].width, lineBreak: false });
    doc.text(typeof value === 'number' ? `${value} ${ref.unit}` : 'Not provided', cols[1].x, y + 6, { width: 120, lineBreak: false });
    doc.fillColor(COLORS.muted)
      .text(`${ref.low} - ${ref.high}`, cols[2].x + 40, y + 6, { width: cols[2].width, lineBreak: false });
    doc.font('Helvetica-Bold').fillColor(flag.color)
      .text(flag.text, cols[3].x, y + 6, { width: cols[3].width, lineBreak: false });

    y += 22;
    doc.moveTo(MARGIN, y).lineTo(MARGIN + contentWidth(doc), y).lineWidth(0.5).strokeColor(COLORS.line).stroke();
  });

  doc.y = y + 4;
  doc.x = MARGIN;
};

const drawRiskBadge = (doc, level = 'Low') => {
  ensureSpace(doc, 40);
  const y = doc.y + 4;
  doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted)
    .text('OVERALL RISK ASSESSMENT', MARGIN, y, { lineBreak: false });
  const color = COLORS[level] || COLORS.muted;
  doc.roundedRect(MARGIN, y + 12, 130, 24, 4).fill(color);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff')
    .text(`${level.toUpperCase()} RISK`, MARGIN, y + 19, { width: 130, align: 'center', lineBreak: false });
  doc.y = y + 48;
  doc.x = MARGIN;
};

const drawFooters = (doc, patientCase) => {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - 36;
    doc.moveTo(MARGIN, y - 8).lineTo(doc.page.width - MARGIN, y - 8).lineWidth(0.5).strokeColor(COLORS.line).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
      .text(`Case ${patientCase.caseId}  |  Confidential medical record`, MARGIN, y, { lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN, y, {
      width: contentWidth(doc),
      align: 'right',
      lineBreak: false,
    });

    doc.page.margins.bottom = bottom;
  }
};

const generateReport = (patientCase, stream) => {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `Leukemia Screening Report - ${patientCase.caseId}`,
      Author: 'Leukemia Detection System',
      Subject: 'AI-assisted screening report',
    },
  });

  doc.pipe(stream);

  const ai = patientCase.aiResults || {};
  const doctor = patientCase.doctorId && patientCase.doctorId.name ? patientCase.doctorId : null;

  drawHeader(doc, patientCase);

  sectionTitle(doc, 'Patient information');
  infoGrid(doc, [
    ['Patient name', patientCase.patientName],
    ['Case ID', patientCase.caseId],
    ['Age', `${patientCase.age} years`],
    ['Gender', capitalize(patientCase.gender)],
    ['Contact', patientCase.phone],
    ['Consulting doctor', doctor ? doctor.name : 'Not assigned'],
    ['Record created', formatDate(patientCase.createdAt)],
    ['Case status', capitalize(patientCase.status)],
  ]);

  sectionTitle(doc, 'Clinical symptoms');
  const symptoms = patientCase.symptoms || {};
  infoGrid(
    doc,
    Object.keys(SYMPTOM_LABELS).map((key) => [
      capitalize(SYMPTOM_LABELS[key]),
      symptoms[key] ? 'Present' : 'Not reported',
    ])
  );

  sectionTitle(doc, 'Complete blood count');
  drawCbcTable(doc, patientCase.cbcData || {});

  sectionTitle(doc, 'AI analysis');
  infoGrid(doc, [
    ['Symptom risk score', typeof ai.symptomRisk === 'number' ? `${ai.symptomRisk} / 100` : 'N/A'],
    ['CBC risk score', typeof ai.cbcRisk === 'number' ? `${ai.cbcRisk} / 100` : 'N/A'],
    ['Smear image class', ai.imageClass || 'N/A'],
    ['Image confidence', typeof ai.imageConfidence === 'number' ? `${ai.imageConfidence}%` : 'N/A'],
  ]);
  if (ai.overallRisk) drawRiskBadge(doc, ai.overallRisk);

  if (ai.xaiSummary) {
    sectionTitle(doc, 'Explainability summary');
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.text)
      .text(ai.xaiSummary, MARGIN, doc.y, { width: contentWidth(doc), lineGap: 3, align: 'left' });
  }

  sectionTitle(doc, "Doctor's notes");
  doc.font('Helvetica').fontSize(10).fillColor(patientCase.doctorNotes ? COLORS.text : COLORS.muted)
    .text(patientCase.doctorNotes || 'No clinical notes have been recorded for this case.', MARGIN, doc.y, {
      width: contentWidth(doc),
      lineGap: 3,
    });

  ensureSpace(doc, 60);
  doc.moveDown(1.5);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLORS.muted).text(
    'This report is generated by an automated decision-support system and does not constitute a diagnosis. ' +
      'Findings must be reviewed and confirmed by a qualified haematologist before any clinical action is taken.',
    MARGIN,
    doc.y,
    { width: contentWidth(doc), lineGap: 2 }
  );

  drawFooters(doc, patientCase);
  doc.end();
};

module.exports = { generateReport };
