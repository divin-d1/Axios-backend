const mongoose = require('mongoose');

const candidateSchema = new mongoose.Schema({
  // 3.1 Basic Information
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String },
  headline: { type: String },
  bio: { type: String },
  location: { type: String },

  // 3.2 Skills & Languages
  skills: [{
    name: { type: String, required: true },
    level: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced', 'Expert'], default: 'Intermediate' },
    yearsOfExperience: { type: Number, default: 0 }
  }],
  languages: [{
    name: { type: String },
    proficiency: { type: String, enum: ['Basic', 'Conversational', 'Fluent', 'Native'], default: 'Conversational' }
  }],

  // 3.3 Work Experience
  experience: [{
    company: { type: String },
    role: { type: String },
    startDate: { type: String }, // Format: YYYY-MM
    endDate: { type: String },   // Format: YYYY-MM or Present
    description: { type: String },
    technologies: [{ type: String }],
    isCurrent: { type: Boolean, default: false }
  }],

  // 3.4 Education
  education: [{
    institution: { type: String },
    degree: { type: String },
    fieldOfStudy: { type: String },
    startYear: { type: Number },
    endYear: { type: Number }
  }],

  // 3.5 Certifications
  certifications: [{
    name: { type: String },
    issuer: { type: String },
    issueDate: { type: String } // Format: YYYY-MM
  }],

  // 3.6 Projects
  projects: [{
    name: { type: String },
    description: { type: String },
    technologies: [{ type: String }],
    role: { type: String },
    link: { type: String },
    startDate: { type: String },
    endDate: { type: String }
  }],

  // 3.7 Availability
  availability: {
    status: { type: String, default: 'Available' },
    type: { type: String, default: 'Full-time' },
    startDate: { type: String } // Format: YYYY-MM-DD
  },

  // 3.8 Social Links
  socialLinks: {
    linkedin: { type: String },
    github: { type: String },
    portfolio: { type: String },
    other: { type: String }
  },

  // Platform Meta fields
  job: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: false
  },
  resumeFile: {
    type: String, // Cloudinary URL
  },
  rawResumeText: {
    type: String, // For AI context
  },
  source: {
    type: String,
    enum: ['manual', 'csv-upload', 'excel-upload', 'resume-upload', 'platform'],
    default: 'platform'
  }
}, { timestamps: true });

// Virtual for backward-compatibility on existing UI components
candidateSchema.virtual('name').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual for legacy backward compatibility metric
candidateSchema.virtual('totalYearsExperience').get(function() {
  let maxExp = 0;
  if (this.skills && this.skills.length > 0) {
    maxExp = Math.max(...this.skills.map(s => s.yearsOfExperience || 0));
  }
  return maxExp;
});

// Ensure virtuals are included in JSON responses
candidateSchema.set('toJSON', { virtuals: true });
candidateSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Candidate', candidateSchema);
