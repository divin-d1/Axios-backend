const Candidate = require('../models/Candidate');
const Job = require('../models/Job');
const { parseCSV, parseExcel, parsePDF } = require('../utils/fileParser');
const { parseResume } = require('../utils/geminiService');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');
const path = require('path');

// @desc    Add single candidate manually
// @route   POST /api/candidates
const addCandidate = async (req, res, next) => {
  try {
    const candidate = await Candidate.create(req.body);

    // Update job applicant count
    await Job.findByIdAndUpdate(candidate.job, { $inc: { totalApplicants: 1 } });

    res.status(201).json({ success: true, data: candidate });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk upload candidates via CSV/Excel
// @route   POST /api/candidates/upload/:jobId
const bulkUploadCandidates = async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload a CSV or Excel file');
    }

    const jobId = req.params.jobId;
    const job = await Job.findById(jobId);
    if (!job) {
      res.status(404);
      throw new Error('Job not found');
    }

    const fileBuffer = req.file.buffer;
    const ext = req.file.originalname.split('.').pop().toLowerCase();

    let candidateData;
    if (ext === 'csv') {
      candidateData = await parseCSV(fileBuffer);
    } else if (ext === 'xlsx' || ext === 'xls') {
      candidateData = parseExcel(fileBuffer);
    } else {
      res.status(400);
      throw new Error('Unsupported file format. Use CSV or Excel.');
    }

    if (!candidateData.length) {
      res.status(400);
      throw new Error('No valid candidate data found in the file');
    }

    // Add job reference and source to each candidate
    const candidates = candidateData.map(c => ({
      ...c,
      job: jobId,
      source: ext === '.csv' ? 'csv-upload' : 'excel-upload',
    }));

    const created = await Candidate.insertMany(candidates, { ordered: false });

    // Update job applicant count
    await Job.findByIdAndUpdate(jobId, { $inc: { totalApplicants: created.length } });

    res.status(201).json({
      success: true,
      message: `Successfully imported ${created.length} candidates`,
      count: created.length,
      data: created,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Upload resume PDF and parse with AI
// @route   POST /api/candidates/resume/:jobId
const uploadResume = async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload a PDF resume');
    }

    const jobId = req.params.jobId;
    const job = await Job.findById(jobId);
    if (!job) {
      res.status(404);
      throw new Error('Job not found');
    }

    const fileBuffer = req.file.buffer;

    // Extract text from PDF buffer
    let resumeText;
    try {
      resumeText = await parsePDF(fileBuffer);
    } catch (err) {
      res.status(400);
      throw new Error('Could not parse PDF. Ensure it is a valid text-based PDF.');
    }

    if (!resumeText || resumeText.trim().length < 50) {
      res.status(400);
      throw new Error('Could not extract sufficient text from the PDF. Please ensure it is not a scanned image.');
    }

    // Upload to Cloudinary via stream
    const uploadToCloudinary = () => {
      return new Promise((resolve, reject) => {
        const cld_upload_stream = cloudinary.uploader.upload_stream(
          { folder: 'axios_resumes', resource_type: 'auto' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        streamifier.createReadStream(fileBuffer).pipe(cld_upload_stream);
      });
    };

    const cloudinaryResult = await uploadToCloudinary();

    // Parse resume with Gemini AI
    const parsedData = await parseResume(resumeText);

    // Create candidate with parsed data
    const candidate = await Candidate.create({
      ...parsedData,
      job: jobId,
      source: 'resume-upload',
      resumeFile: cloudinaryResult.secure_url,
      rawResumeText: resumeText.substring(0, 5000), // Store first 5000 chars
    });

    // Update job applicant count
    await Job.findByIdAndUpdate(jobId, { $inc: { totalApplicants: 1 } });

    res.status(201).json({
      success: true,
      message: 'Resume parsed and candidate created successfully',
      data: candidate,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get candidates for a job
// @route   GET /api/candidates/job/:jobId
const getCandidatesByJob = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const filter = { job: req.params.jobId };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { skills: { $regex: search, $options: 'i' } },
      ];
    }

    const candidates = await Candidate.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Candidate.countDocuments(filter);

    res.json({
      success: true,
      count: candidates.length,
      total,
      data: candidates,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all candidates across all jobs
// @route   GET /api/candidates
const getAllCandidates = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const candidates = await Candidate.find(filter)
      .populate('job', 'title status')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Candidate.countDocuments(filter);

    res.json({
      success: true,
      count: candidates.length,
      total,
      data: candidates,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single candidate
// @route   GET /api/candidates/:id
const getCandidate = async (req, res, next) => {
  try {
    const candidate = await Candidate.findById(req.params.id).populate('job', 'title company');
    if (!candidate) {
      res.status(404);
      throw new Error('Candidate not found');
    }
    res.json({ success: true, data: candidate });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete candidate
// @route   DELETE /api/candidates/:id
const deleteCandidate = async (req, res, next) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) {
      res.status(404);
      throw new Error('Candidate not found');
    }

    await ScreeningResult.deleteMany({ candidate: candidate._id });
    await Candidate.findByIdAndDelete(candidate._id);
    await Job.findByIdAndUpdate(candidate.job, { $inc: { totalApplicants: -1 } });

    res.json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

const ScreeningResult = require('../models/ScreeningResult');

module.exports = {
  addCandidate,
  bulkUploadCandidates,
  uploadResume,
  getCandidatesByJob,
  getAllCandidates,
  getCandidate,
  deleteCandidate,
};
