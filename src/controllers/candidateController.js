const mongoose = require('mongoose');
const Candidate = require('../models/Candidate');
const Job = require('../models/Job');
const ScreeningResult = require('../models/ScreeningResult');
const { parseCSV, parseExcel, parsePDF, parseCSVRaw, parseExcelRaw, applyAIMappingPattern, normalizeCandidateRow } = require('../utils/fileParser');
const { parseResume } = require('../utils/geminiService');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');
const path = require('path');

/**
 * Helper: verify a jobId belongs to the user's company
 */
const verifyJobOwnership = async (jobId, userCompanyId) => {
  const job = await Job.findOne({ _id: jobId, company: userCompanyId });
  return job;
};

// @desc    Add single candidate manually (only to user's own job)
// @route   POST /api/candidates
const addCandidate = async (req, res, next) => {
  try {
    const job = await verifyJobOwnership(req.body.job, req.user.company);
    if (!job) {
      return res.status(403).json({ error: 'Access denied — job does not belong to your company' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const candidateArray = await Candidate.create([{ ...req.body, job: job._id }], { session });
      const candidate = candidateArray[0];

      await Job.findByIdAndUpdate(job._id, { $inc: { totalApplicants: 1 } }, { session });

      await session.commitTransaction();
      session.endSession();

      res.status(201).json({ success: true, data: candidate });
    } catch (transactionError) {
      await session.abortTransaction();
      session.endSession();
      throw transactionError;
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk upload candidates (only to user's own job)
// @route   POST /api/candidates/upload/:jobId
const bulkUploadCandidates = async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload a CSV or Excel file');
    }

    const job = await verifyJobOwnership(req.params.jobId, req.user.company);
    if (!job) {
      return res.status(403).json({ error: 'Access denied — job does not belong to your company' });
    }

    const fileBuffer = req.file.buffer;
    const ext = req.file.originalname.split('.').pop().toLowerCase();

    // 1. First extract RAW flat JSON from the spreadsheet
    let rawData = [];
    if (ext === 'csv') {
      rawData = await parseCSVRaw(fileBuffer);  // Add this exported util
    } else if (ext === 'xlsx' || ext === 'xls') {
      rawData = parseExcelRaw(fileBuffer);      // Add this exported util
    } else {
      res.status(400);
      throw new Error('Unsupported file format. Use CSV or Excel.');
    }

    if (!rawData.length) {
      res.status(400);
      throw new Error('No data found in the file');
    }

    // 2. Intelligently map CSV structure using Gemini AI
    const { analyzeCSVStructure } = require('../utils/geminiService');
    let aiMappings = null;
    try {
      if (rawData.length > 0) {
        console.log("Analyzing unknown CSV structure using Gemini AI...");
        const mappingResult = await analyzeCSVStructure(rawData.slice(0, 2));
        if (mappingResult && mappingResult.mappings) {
          aiMappings = mappingResult.mappings;
          console.log("Gemini AI successfully extracted dynamic schema mappings.");
        }
      }
    } catch (err) {
      console.warn("Gemini CSV Analysis failed or rate-limited. Falling back to semantic fuzzy-parser.");
    }
    
    let candidateData = rawData.map(row => normalizeCandidateRow(row, aiMappings)).filter(c => c.firstName && c.lastName);

    if (!candidateData.length) {
      res.status(400);
      throw new Error('No valid candidates could be mapped from the file structure.');
    }

    const candidates = candidateData.map(c => ({
      ...c,
      job: job._id,
      source: ext === 'csv' ? 'csv-upload' : 'excel-upload',
    }));

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const created = await Candidate.insertMany(candidates, { session });
      await Job.findByIdAndUpdate(job._id, { $inc: { totalApplicants: created.length } }, { session });
      
      await session.commitTransaction();
      session.endSession();

      res.status(201).json({
        success: true,
        message: `Successfully imported ${created.length} candidates. Complete transaction successful!`,
        count: created.length,
        data: created,
      });
    } catch (transactionError) {
      await session.abortTransaction();
      session.endSession();
      throw new Error(`Upload transaction failed and rolled back safely. Database unaltered. Error: ${transactionError.message}`);
    }

  } catch (error) {
    next(error);
  }
};

// @desc    Upload resume PDF (only to user's own job)
// @route   POST /api/candidates/resume/:jobId
const uploadResume = async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload a PDF resume');
    }

    const job = await verifyJobOwnership(req.params.jobId, req.user.company);
    if (!job) {
      return res.status(403).json({ error: 'Access denied — job does not belong to your company' });
    }

    const fileBuffer = req.file.buffer;

    let resumeText;
    try {
      resumeText = await parsePDF(fileBuffer);
    } catch (err) {
      res.status(400);
      throw new Error('Could not parse PDF. Ensure it is a valid text-based PDF.');
    }

    if (!resumeText || resumeText.trim().length < 50) {
      res.status(400);
      throw new Error('Could not extract sufficient text from the PDF.');
    }

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
    const parsedData = await parseResume(resumeText);

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const candidateArray = await Candidate.create([{
        ...parsedData,
        job: job._id,
        source: 'resume-upload',
        resumeFile: cloudinaryResult.secure_url,
        rawResumeText: resumeText.substring(0, 5000),
      }], { session });
      
      const candidate = candidateArray[0];

      await Job.findByIdAndUpdate(job._id, { $inc: { totalApplicants: 1 } }, { session });

      await session.commitTransaction();
      session.endSession();

      res.status(201).json({
        success: true,
        message: 'Resume parsed and candidate created successfully',
        data: candidate,
      });
    } catch (transactionError) {
      await session.abortTransaction();
      session.endSession();
      throw transactionError;
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Get candidates for a job (scoped to user's company)
// @route   GET /api/candidates/job/:jobId
const getCandidatesByJob = async (req, res, next) => {
  try {
    const job = await verifyJobOwnership(req.params.jobId, req.user.company);
    if (!job) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { page = 1, limit = 50, search } = req.query;
    const filter = { job: job._id };

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

    res.json({ success: true, count: candidates.length, total, data: candidates });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all candidates across user's company jobs only
// @route   GET /api/candidates
const getAllCandidates = async (req, res, next) => {
  try {
    // First get all job IDs belonging to user's company
    const companyJobs = await Job.find({ company: req.user.company }).select('_id');
    const jobIds = companyJobs.map(j => j._id);

    const { page = 1, limit = 50, search } = req.query;
    const filter = { job: { $in: jobIds } };

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

    res.json({ success: true, count: candidates.length, total, data: candidates });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single candidate (verify belongs to user's company job)
// @route   GET /api/candidates/:id
const getCandidate = async (req, res, next) => {
  try {
    const candidate = await Candidate.findById(req.params.id).populate('job', 'title company');
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    // Verify this candidate's job belongs to user's company
    const job = await Job.findOne({ _id: candidate.job, company: req.user.company });
    if (!job) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ success: true, data: candidate });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete candidate (verify belongs to user's company)
// @route   DELETE /api/candidates/:id
const deleteCandidate = async (req, res, next) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    const job = await Job.findOne({ _id: candidate.job, company: req.user.company });
    if (!job) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await ScreeningResult.deleteMany({ candidate: candidate._id }, { session });
      await Candidate.findByIdAndDelete(candidate._id, { session });
      await Job.findByIdAndUpdate(candidate.job, { $inc: { totalApplicants: -1 } }, { session });

      await session.commitTransaction();
      session.endSession();

      res.json({ success: true, data: {} });
    } catch (transactionError) {
      await session.abortTransaction();
      session.endSession();
      throw transactionError;
    }
  } catch (error) {
    next(error);
  }
};

module.exports = {
  addCandidate,
  bulkUploadCandidates,
  uploadResume,
  getCandidatesByJob,
  getAllCandidates,
  getCandidate,
  deleteCandidate,
};
