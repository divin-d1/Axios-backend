const mongoose = require('mongoose');
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

    // ----------------------------------------------------
    // NATIVE PRE-FILTERING (Lazy Evaluation Strategy)
    // ----------------------------------------------------
    // We completely bypass the Gemini API for candidates who don't have ANY
    // overlapping keywords natively to save massive API token costs.
    const requiredKeywords = job.requiredSkills.map(s => s.toLowerCase());
    
    const viableCandidates = [];
    const automaticallyRejectedResults = [];

    candidates.forEach(candidate => {
      // Squash candidate info into a searchable string block
      const candidateString = `
        ${candidate.headline} 
        ${candidate.skills.map(s => s.name || s).join(' ')} 
        ${JSON.stringify(candidate.experience)}
      `.toLowerCase();

      // Check if they share at least 20% of required keywords natively
      let matchedCount = 0;
      requiredKeywords.forEach(keyword => {
        if (candidateString.includes(keyword)) matchedCount++;
      });
      
      const threshold = Math.max(1, Math.floor(requiredKeywords.length * 0.2));

      if (matchedCount >= threshold || requiredKeywords.length === 0) {
        viableCandidates.push(candidate);
      } else {
        automaticallyRejectedResults.push({
          candidateId: candidate._id,
          overallScore: 10,
          skillMatchScore: 5,
          experienceScore: 10,
          projectScore: 10,
          credibilityScore: 10,
          companyFitScore: 10,
          strengths: [],
          weaknesses: ['Failed native fast-filter keywords'],
          reasoning: 'Auto-rejected by native pre-filter: Does not possess minimum expected keyword footprint.'
        });
      }
    });

    console.log(`Pre-filter complete. Viable: ${viableCandidates.length}, Auto-Rejected natively: ${automaticallyRejectedResults.length}`);

    // Process ONLY viable candidates in batches for large numbers
    const BATCH_SIZE = 20;
    let allResults = [...automaticallyRejectedResults];

    for (let i = 0; i < viableCandidates.length; i += BATCH_SIZE) {
      const batch = viableCandidates.slice(i, i + BATCH_SIZE);
      
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

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Save screening results to database
      const screeningResults = [];
      for (let i = 0; i < allResults.length; i++) {
        const result = allResults[i];
        const rank = i + 1;
        const isShortlisted = rank <= job.shortlistSize;

        const screeningResultArray = await ScreeningResult.create([{
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
        }], { session });
        
        screeningResults.push(screeningResultArray[0]);
      }

      // Update job status to completed
      job.status = 'completed';
      job.screenedAt = new Date();
      await job.save({ session });

      await session.commitTransaction();
      session.endSession();

      res.json({
        success: true,
        message: `Screening completed. ${screeningResults.length} candidates evaluated, top ${job.shortlistSize} shortlisted.`,
        data: {
          totalEvaluated: screeningResults.length,
          shortlistSize: job.shortlistSize,
          results: screeningResults,
        },
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
    const job = await Job.findOne({ _id: req.params.jobId, company: req.user.company }).populate('company', 'name');
    if (!job) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const results = await ScreeningResult.find(filter)
      .populate('candidate', 'name email phone skills totalYearsExperience source location')
      .sort({ rank: 1 });

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
      return res.status(404).json({ error: 'Screening result not found' });
    }

    // Verify the job belongs to user's company
    const jobCompanyId = result.job?.company?._id || result.job?.company;
    if (String(jobCompanyId) !== String(req.user.company)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

module.exports = { triggerScreening, getScreeningResults, getScreeningResultDetail };
