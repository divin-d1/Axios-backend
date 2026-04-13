const Candidate = require('../models/Candidate');
const Job = require('../models/Job');
const ScreeningResult = require('../models/ScreeningResult');
const { parseCSV, parseExcel, parsePDF } = require('../utils/fileParser');
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

    const candidate = await Candidate.create(req.body);
    await Job.findByIdAndUpdate(candidate.job, { $inc: { totalApplicants: 1 } });

    res.status(201).json({ success: true, data: candidate });
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

    const candidates = candidateData.map(c => ({
      ...c,
      job: job._id,
      source: ext === 'csv' ? 'csv-upload' : 'excel-upload',
    }));

    const created = await Candidate.insertMany(candidates, { ordered: false });
    await Job.findByIdAndUpdate(job._id, { $inc: { totalApplicants: created.length } });

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

    const candidate = await Candidate.create({
      ...parsedData,
      job: job._id,
      source: 'resume-upload',
      resumeFile: cloudinaryResult.secure_url,
      rawResumeText: resumeText.substring(0, 5000),
    });

    await Job.findByIdAndUpdate(job._id, { $inc: { totalApplicants: 1 } });

    res.status(201).json({
      success: true,
      message: 'Resume parsed and candidate created successfully',
      data: candidate,
    });
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

    await ScreeningResult.deleteMany({ candidate: candidate._id });
    await Candidate.findByIdAndDelete(candidate._id);
    await Job.findByIdAndUpdate(candidate.job, { $inc: { totalApplicants: -1 } });

    res.json({ success: true, data: {} });
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
