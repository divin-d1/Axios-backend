const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true,
    maxlength: [100, 'Company name cannot exceed 100 characters'],
  },
  industry: [{
    type: String,
    required: [true, 'At least one industry sector is required'],
    trim: true,
  }],
  departments: [{
    type: String,
    trim: true,
  }],
  specialization: {
    type: String,
    trim: true,
    default: '',
  },
  size: {
    type: String,
    enum: ['startup', 'small', 'medium', 'large', 'enterprise'],
    default: 'medium',
  },
  techStack: [{
    type: String,
    trim: true,
  }],
  hiringPhilosophy: {
    type: String,
    enum: ['startup-fast', 'enterprise-structured', 'research-heavy', 'balanced'],
    default: 'balanced',
  },
  email: {
    type: String,
    required: [true, 'Company email is required'],
    trim: true,
    lowercase: true,
  },
  website: {
    type: String,
    trim: true,
    default: '',
  },
  description: {
    type: String,
    trim: true,
    default: '',
  },
  logo: {
    type: String,
    default: '',
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Company', companySchema);
