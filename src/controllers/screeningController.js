const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const Company = require('../models/Company');
const ScreeningResult = require('../models/ScreeningResult');
const { screenCandidates } = require('../utils/geminiService');

// @desc    Trigger AI screening for a job
// @route   POST /api/screening/:jobId
const triggerScreening = async (req, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.jobId, company: req.user.company });
    if (!job) {
      return res.status(404).json({ error: 'Job not found or access denied' });
    }

    // Get company context
    const company = await Company.findById(job.company);
    if (!company) {
      res.status(404);
      throw new Error('Company not found. Please set up company profile first.');
    }

    // Get all candidates for this job
    const candidates = await Candidate.find({ job: job._id });
    if (candidates.length === 0) {
      res.status(400);
      throw new Error('No candidates found for this job. Please add candidates first.');
    }

    // Update job status to screening
    job.status = 'screening';
    await job.save();

    // Clear previous screening results for this job
    await ScreeningResult.deleteMany({ job: job._id });

    // Process candidates in batches for large numbers
    const BATCH_SIZE = 20;
    let allResults = [];

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      
      try {
        const aiResults = await screenCandidates(job, batch, company);
        allResults = allResults.concat(aiResults);
      } catch (error) {
        console.error(`Batch ${i / BATCH_SIZE + 1} screening error:`, error.message);
        // Continue with next batch even if one fails
      }
    }

    if (allResults.length === 0) {
      job.status = 'open';
      await job.save();
      res.status(500);
      throw new Error('AI screening failed to produce results. Please check your Gemini API key and try again.');
    }

    // Sort all results by overall score descending
    allResults.sort((a, b) => b.overallScore - a.overallScore);

    // Save screening results to database
    const screeningResults = [];
    for (let i = 0; i < allResults.length; i++) {
      const result = allResults[i];
      const rank = i + 1;
      const isShortlisted = rank <= job.shortlistSize;

      try {
        const screeningResult = await ScreeningResult.create({
          job: job._id,
          candidate: result.candidateId,
          overallScore: Math.round(result.overallScore) || 0,
          skillMatchScore: Math.round(result.skillMatchScore) || 0,
          experienceScore: Math.round(result.experienceScore) || 0,
          projectScore: Math.round(result.projectScore) || 0,
          credibilityScore: Math.round(result.credibilityScore) || 0,
          companyFitScore: Math.round(result.companyFitScore) || 0,
          rank,
          isShortlisted,
          strengths: result.strengths || [],
          weaknesses: result.weaknesses || [],
          recommendation: result.recommendation || 'consider',
          reasoning: result.reasoning || '',
          skillAnalysis: result.skillAnalysis || '',
          experienceAnalysis: result.experienceAnalysis || '',
        });
        screeningResults.push(screeningResult);
      } catch (error) {
        console.error(`Error saving result for candidate ${result.candidateId}:`, error.message);
      }
    }

    // Update job status to completed
    job.status = 'completed';
    job.screenedAt = new Date();
    await job.save();

    res.json({
      success: true,
      message: `Screening completed. ${screeningResults.length} candidates evaluated, top ${job.shortlistSize} shortlisted.`,
      data: {
        totalEvaluated: screeningResults.length,
        shortlistSize: job.shortlistSize,
        results: screeningResults,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get screening results for a job
// @route   GET /api/screening/:jobId
const getScreeningResults = async (req, res, next) => {
  try {
    const { shortlistOnly } = req.query;
    const filter = { job: req.params.jobId };
    
    if (shortlistOnly === 'true') {
      filter.isShortlisted = true;
    }

    // Verify job belongs to user's company
    const job = await Job.findOne({ _id: req.params.jobId, company: req.user.company });
    if (!job) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const results = await ScreeningResult.find(filter)
      .populate('candidate', 'name email phone skills totalYearsExperience source location')
      .sort({ rank: 1 });

    const job = await Job.findById(req.params.jobId).populate('company', 'name');

    res.json({
      success: true,
      count: results.length,
      job: job ? { title: job.title, company: job.company?.name, shortlistSize: job.shortlistSize } : null,
      data: results,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single screening result detail
// @route   GET /api/screening/result/:id
const getScreeningResultDetail = async (req, res, next) => {
  try {
    const result = await ScreeningResult.findById(req.params.id)
      .populate('candidate')
      .populate({
        path: 'job',
        populate: { path: 'company', select: 'name' }
      });

    if (!result) {
      res.status(404);
      throw new Error('Screening result not found');
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

module.exports = { triggerScreening, getScreeningResults, getScreeningResultDetail };
