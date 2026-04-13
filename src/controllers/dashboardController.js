const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const Company = require('../models/Company');
const ScreeningResult = require('../models/ScreeningResult');

// @desc    Get dashboard statistics
// @route   GET /api/dashboard
const getDashboardStats = async (req, res, next) => {
  try {
    const { companyId } = req.query;
    const jobFilter = companyId ? { company: companyId } : {};

    const [
      totalCompanies,
      totalJobs,
      totalCandidates,
      totalScreenings,
      activeJobs,
      completedJobs,
      recentJobs,
      recentScreenings,
    ] = await Promise.all([
      Company.countDocuments(),
      Job.countDocuments(jobFilter),
      Candidate.countDocuments(),
      ScreeningResult.countDocuments(),
      Job.countDocuments({ ...jobFilter, status: { $in: ['open', 'screening'] } }),
      Job.countDocuments({ ...jobFilter, status: 'completed' }),
      Job.find(jobFilter)
        .populate('company', 'name')
        .sort({ createdAt: -1 })
        .limit(5)
        .select('title status totalApplicants createdAt screenedAt shortlistSize'),
      ScreeningResult.find({ isShortlisted: true })
        .populate('candidate', 'name email')
        .populate({ path: 'job', select: 'title', populate: { path: 'company', select: 'name' } })
        .sort({ createdAt: -1 })
        .limit(10),
    ]);

    // Source distribution
    const sourceDistribution = await Candidate.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]);

    // Score distribution for completed screenings
    const scoreDistribution = await ScreeningResult.aggregate([
      {
        $bucket: {
          groupBy: '$overallScore',
          boundaries: [0, 20, 40, 60, 80, 101],
          default: 'Other',
          output: { count: { $sum: 1 } },
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        overview: {
          totalCompanies,
          totalJobs,
          totalCandidates,
          totalScreenings,
          activeJobs,
          completedJobs,
        },
        recentJobs,
        recentScreenings,
        sourceDistribution,
        scoreDistribution,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getDashboardStats };
