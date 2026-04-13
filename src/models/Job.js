const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Company reference is required'],
  },
  title: {
    type: String,
    required: [true, 'Job title is required'],
    trim: true,
    maxlength: [150, 'Job title cannot exceed 150 characters'],
  },
  description: {
    type: String,
    required: [true, 'Job description is required'],
    trim: true,
  },
  requiredSkills: [{
    type: String,
    trim: true,
  }],
  preferredSkills: [{
    type: String,
    trim: true,
  }],
  minExperience: {
    type: Number,
    default: 0,
    min: [0, 'Experience cannot be negative'],
  },
  maxExperience: {
    type: Number,
    default: null,
  },
  responsibilities: [{
    type: String,
    trim: true,
  }],
  educationLevel: {
    type: String,
    enum: ['any', 'high-school', 'bachelors', 'masters', 'phd'],
    default: 'any',
  },
  employmentType: {
    type: String,
    enum: ['full-time', 'part-time', 'contract', 'internship', 'freelance'],
    default: 'full-time',
  },
  location: {
    type: String,
    trim: true,
    default: 'Remote',
  },
  salaryRange: {
    min: { type: Number, default: null },
    max: { type: Number, default: null },
    currency: { type: String, default: 'USD' },
  },

  // ─── Ranking Configuration (Key Innovation) ───
  shortlistSize: {
    type: Number,
    default: 10,
    min: [1, 'Shortlist size must be at least 1'],
    max: [100, 'Shortlist size cannot exceed 100'],
  },
  rankingStrictness: {
    type: String,
    enum: ['strict', 'balanced', 'flexible'],
    default: 'balanced',
  },

  // ─── Scoring Weights (customizable per job) ───
  scoringWeights: {
    skillMatch: { type: Number, default: 30, min: 0, max: 100 },
    experienceDepth: { type: Number, default: 25, min: 0, max: 100 },
    projectRelevance: { type: Number, default: 20, min: 0, max: 100 },
    credibility: { type: Number, default: 15, min: 0, max: 100 },
    companyFit: { type: Number, default: 10, min: 0, max: 100 },
  },

  // ─── Status Tracking ───
  status: {
    type: String,
    enum: ['draft', 'open', 'screening', 'completed', 'archived'],
    default: 'draft',
  },
  totalApplicants: {
    type: Number,
    default: 0,
  },
  screenedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

// Index for efficient querying
jobSchema.index({ company: 1, status: 1 });
jobSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Job', jobSchema);
