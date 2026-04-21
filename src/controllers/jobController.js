const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const ScreeningResult = require('../models/ScreeningResult');

// @desc    Create a new job (scoped to user's company)
// @route   POST /api/jobs
const createJob = async (req, res, next) => {
  try {
    // Force job to belong to user's company — ignore any company ID from client
    const job = await Job.create({
      ...req.body,
      company: req.user.company,
    });
    res.status(201).json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
};

// @desc    Get jobs for user's company only
// @route   GET /api/jobs
const getJobs = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { company: req.user.company };
    
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

// @desc    Get single job (only if it belongs to user's company)
// @route   GET /api/jobs/:id
const getJob = async (req, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, company: req.user.company }).populate('company');
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

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

// @desc    Update job (only if it belongs to user's company)
// @route   PUT /api/jobs/:id
const updateJob = async (req, res, next) => {
  try {
    // Prevent changing company ownership
    delete req.body.company;
    
    const job = await Job.findOneAndUpdate(
      { _id: req.params.id, company: req.user.company },
      req.body,
      { new: true, runValidators: true }
    );
    if (!job) {
      return res.status(404).json({ error: 'Job not found or access denied' });
    }
    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete job (only if it belongs to user's company)
// @route   DELETE /api/jobs/:id
const deleteJob = async (req, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, company: req.user.company });
    if (!job) {
      return res.status(404).json({ error: 'Job not found or access denied' });
    }

    const candidates = await Candidate.find({ job: job._id }).select('_id');
    const candidateIds = candidates.map((candidate) => candidate._id);

    await ScreeningResult.deleteMany({
      $or: [
        { job: job._id },
        { candidate: { $in: candidateIds } },
      ],
    });
    await Candidate.deleteMany({ job: job._id });
    await Job.findByIdAndDelete(job._id);

    res.json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

module.exports = { createJob, getJobs, getJob, updateJob, deleteJob };
