const mongoose = require('mongoose');

const symptomField = { type: Boolean, default: false };
const cbcField = { type: Number, min: [0, 'CBC values cannot be negative'] };

const patientCaseSchema = new mongoose.Schema(
  {
    caseId: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    patientName: {
      type: String,
      required: [true, 'Patient name is required'],
      trim: true,
      maxlength: 120,
    },
    age: {
      type: Number,
      required: [true, 'Age is required'],
      min: 0,
      max: 120,
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other'],
      required: [true, 'Gender is required'],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    symptoms: {
      fatigue: symptomField,
      fever: symptomField,
      weightLoss: symptomField,
      frequentInfections: symptomField,
      easyBruising: symptomField,
      bonePain: symptomField,
      nightSweats: symptomField,
    },
    cbcData: {
      wbc: cbcField,
      rbc: cbcField,
      hemoglobin: cbcField,
      platelets: cbcField,
    },
    imageUrl: {
      type: String,
      trim: true,
    },
    aiResults: {
      symptomRisk: { type: Number, min: 0, max: 100 },
      cbcRisk: { type: Number, min: 0, max: 100 },
      imageClass: { type: String, trim: true },
      imageConfidence: { type: Number, min: 0, max: 100 },
      overallRisk: { type: String, enum: ['Low', 'Moderate', 'High'] },
      xaiSummary: { type: String },
    },
    doctorNotes: {
      type: String,
      trim: true,
      maxlength: 5000,
    },
    status: {
      type: String,
      enum: ['pending', 'completed'],
      default: 'pending',
    },
    pdfReportUrl: {
      type: String,
      trim: true,
    },
    publishedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

patientCaseSchema.index({ doctorId: 1, createdAt: -1 });

patientCaseSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('PatientCase', patientCaseSchema);
