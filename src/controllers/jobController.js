const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const ScreeningResult = require('../models/ScreeningResult');

// @desc    Create a new job
// @route   POST /api/jobs
const createJob = async (req, res, next) => {
  try {
    const job = await Job.create(req.body);
    res.status(201).json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all jobs with optional filters
// @route   GET /api/jobs
const getJobs = async (req, res, next) => {
  try {
    const { company, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    
    if (company) filter.company = company;
    if (status) filter.status = status;

    const jobs = await Job.find(filter)
      .populate('company', 'name industry logo')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Job.countDocuments(filter);

    res.json({
      success: true,
      count: jobs.length,
      total,
      pages: Math.ceil(total / limit),
      data: jobs,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single job with stats
// @route   GET /api/jobs/:id
const getJob = async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).populate('company');
    if (!job) {
      res.status(404);
      throw new Error('Job not found');
    }

    // Get candidate count
    const candidateCount = await Candidate.countDocuments({ job: job._id });
    const screeningCount = await ScreeningResult.countDocuments({ job: job._id });

    res.json({
      success: true,
      data: {
        ...job.toObject(),
        candidateCount,
        screeningCount,
        isScreened: screeningCount > 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update job
// @route   PUT /api/jobs/:id
const updateJob = async (req, res, next) => {
  try {
    const job = await Job.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!job) {
      res.status(404);
      throw new Error('Job not found');
    }
    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete job and related data
// @route   DELETE /api/jobs/:id
const deleteJob = async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404);
      throw new Error('Job not found');
    }

    // Delete related candidates and screening results
    await Candidate.deleteMany({ job: job._id });
    await ScreeningResult.deleteMany({ job: job._id });
    await Job.findByIdAndDelete(job._id);

    res.json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

module.exports = { createJob, getJobs, getJob, updateJob, deleteJob };
