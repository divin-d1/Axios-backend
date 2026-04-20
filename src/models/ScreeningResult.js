const mongoose = require('mongoose');

const screeningResultSchema = new mongoose.Schema({
  // ─── References ───
  job: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true,
  },
  candidate: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Candidate',
    required: true,
  },

  // ─── Scoring (0-100 each) ───
  overallScore: {
    type: Number,
    required: true,
    min: 0,
    max: 100,
  },
  skillMatchScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  experienceScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  projectScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  credibilityScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  companyFitScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },

  // ─── Ranking ───
  rank: {
    type: Number,
    required: true,
    min: 1,
  },
isShortlisted: {
    type: Boolean,
    default: false,
  },

  evaluationMode: {
    type: String,
    enum: ['gemini', 'local-fallback'],
    default: 'gemini',
  },

  // ─── AI Explainability ───
  strengths: [{
    type: String,
  }],
  weaknesses: [{
    type: String,
  }],
  recommendation: {
    type: String,
    enum: ['strongly-recommend', 'recommend', 'consider', 'not-recommended'],
    default: 'consider',
  },
  reasoning: {
    type: String,
    default: '',
  },
  skillAnalysis: {
    type: String,
    default: '',
  },
  experienceAnalysis: {
    type: String,
    default: '',
  },
}, {
  timestamps: true,
});

// Ensure one result per candidate per job
screeningResultSchema.index({ job: 1, candidate: 1 }, { unique: true });
screeningResultSchema.index({ job: 1, rank: 1 });
screeningResultSchema.index({ job: 1, overallScore: -1 });

module.exports = mongoose.model('ScreeningResult', screeningResultSchema);
