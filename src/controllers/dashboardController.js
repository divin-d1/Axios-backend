const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const Company = require('../models/Company');
const ScreeningResult = require('../models/ScreeningResult');
const { serializeScreeningResult } = require('../utils/screeningPresentation');

// @desc    Get dashboard statistics (scoped to user's company)
// @route   GET /api/dashboard
const getDashboardStats = async (req, res, next) => {
  try {
    const companyId = req.user.company;

    if (!companyId) {
      return res.json({
        success: true,
        data: {
          overview: { totalJobs: 0, totalCandidates: 0, totalScreenings: 0, activeJobs: 0, completedJobs: 0 },
          recentJobs: [],
          recentScreenings: [],
        },
      });
    }

    const jobFilter = { company: companyId };

    // Get company job IDs for candidate/screening scoping
    const companyJobs = await Job.find(jobFilter).select('_id');
    const jobIds = companyJobs.map(j => j._id);

    const [
      totalJobs,
      totalCandidates,
      totalScreenings,
      activeJobs,
      completedJobs,
      recentJobs,
      recentScreenings,
    ] = await Promise.all([
      Job.countDocuments(jobFilter),
      Candidate.countDocuments({ job: { $in: jobIds } }),
      ScreeningResult.countDocuments({ job: { $in: jobIds } }),
      Job.countDocuments({ ...jobFilter, status: { $in: ['open', 'screening'] } }),
      Job.countDocuments({ ...jobFilter, status: 'completed' }),
      Job.find(jobFilter)
        .populate('company', 'name')
        .sort({ createdAt: -1 })
        .limit(5)
        .select('title status totalApplicants createdAt screenedAt shortlistSize'),
      ScreeningResult.find({ job: { $in: jobIds }, isShortlisted: true })
        .populate('candidate', 'firstName lastName email')
        .populate({ path: 'job', select: 'title' })
        .sort({ createdAt: -1 })
        .limit(10),
    ]);

    const serializedRecentScreenings = recentScreenings.map((result) => serializeScreeningResult(result));

    res.json({
      success: true,
      data: {
        overview: {
          totalJobs,
          totalCandidates,
          totalScreenings,
          activeJobs,
          completedJobs,
        },
        recentJobs,
        recentScreenings: serializedRecentScreenings,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getDashboardStats };
