const mongoose = require('mongoose');
const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const Company = require('../models/Company');
const ScreeningResult = require('../models/ScreeningResult');
const { screenCandidates } = require('../utils/geminiService');
const { buildLocalScreeningResult } = require('../utils/screeningHeuristics');

const getLatestCandidateMutation = (candidates) => candidates.reduce((latest, candidate) => {
  const candidateTimestamp = new Date(candidate.updatedAt || candidate.createdAt || 0).getTime();
  return Math.max(latest, candidateTimestamp);
}, 0);

const getGeminiPoolSize = (shortlistSize, totalCandidates) => {
  const multiplier = Math.max(1, Number(process.env.GEMINI_AI_POOL_MULTIPLIER || 2));
  const minPool = Math.max(shortlistSize, Number(process.env.GEMINI_AI_POOL_MIN || 12));
  const maxPool = Math.max(shortlistSize, Number(process.env.GEMINI_AI_POOL_MAX || 36));
  const desiredPool = Math.ceil(shortlistSize * multiplier);

  return Math.min(totalCandidates, Math.max(minPool, Math.min(maxPool, desiredPool)));
};

const stripInternalFields = (result) => {
  const { _localMeta, ...cleanResult } = result;
  return cleanResult;
};

const mergeScreeningResult = (fallbackResult, aiResult) => ({
  ...fallbackResult,
  ...aiResult,
  candidateId: fallbackResult.candidateId,
  strengths: Array.isArray(aiResult?.strengths) && aiResult.strengths.length > 0 ? aiResult.strengths : fallbackResult.strengths,
  weaknesses: Array.isArray(aiResult?.weaknesses) && aiResult.weaknesses.length > 0 ? aiResult.weaknesses : fallbackResult.weaknesses,
  reasoning: aiResult?.reasoning || fallbackResult.reasoning,
  recommendation: aiResult?.recommendation || fallbackResult.recommendation,
  skillAnalysis: fallbackResult.skillAnalysis,
  experienceAnalysis: fallbackResult.experienceAnalysis
});

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

    const forceRescreen = req.query.force === 'true' || req.body?.force === true;
    const existingResults = await ScreeningResult.find({ job: job._id }).sort({ rank: 1 });
    const latestCandidateMutation = getLatestCandidateMutation(candidates);
    const screenedAt = job.screenedAt ? new Date(job.screenedAt) : null;
    const jobUpdatedAt = new Date(job.updatedAt || 0);

    const canReuseExistingResults = Boolean(
      !forceRescreen &&
      screenedAt &&
      job.status === 'completed' &&
      existingResults.length === candidates.length &&
      latestCandidateMutation <= screenedAt.getTime() &&
      jobUpdatedAt.getTime() <= screenedAt.getTime()
    );

    if (canReuseExistingResults) {
      return res.json({
        success: true,
        message: `Existing screening reused. ${existingResults.length} candidates already scored with no job or candidate changes detected.`,
        data: {
          totalEvaluated: existingResults.length,
          shortlistSize: job.shortlistSize,
          reusedExisting: true,
          results: existingResults,
        },
      });
    }

    // Update job status to screening
    job.status = 'screening';
    await job.save();

    // Clear previous screening results for this job
    await ScreeningResult.deleteMany({ job: job._id });

    const localResults = candidates.map((candidate) => buildLocalScreeningResult(job, candidate, company));
    const localResultsById = new Map(localResults.map((result) => [String(result.candidateId), result]));
    const candidateById = new Map(candidates.map((candidate) => [String(candidate._id), candidate]));

    const rankedLocalResults = [...localResults].sort((a, b) => (
      b.overallScore - a.overallScore ||
      b.skillMatchScore - a.skillMatchScore ||
      b.experienceScore - a.experienceScore
    ));

    const geminiPoolSize = getGeminiPoolSize(job.shortlistSize, rankedLocalResults.length);
    const geminiCandidates = rankedLocalResults
      .slice(0, geminiPoolSize)
      .map((result) => candidateById.get(String(result.candidateId)))
      .filter(Boolean);

    console.log(`Local scoring complete. Total candidates: ${candidates.length}. Gemini refinement pool: ${geminiCandidates.length}.`);

    const BATCH_SIZE = Math.max(1, Number(process.env.GEMINI_SCREENING_BATCH_SIZE || 8));
    const BATCH_DELAY_MS = Math.max(0, Number(process.env.GEMINI_SCREENING_BATCH_DELAY_MS || 8000));
    const finalResultsById = new Map(localResultsById);
    let geminiQuotaFallback = false;
    let geminiEvaluatedCandidates = 0;

    for (let i = 0; i < geminiCandidates.length; i += BATCH_SIZE) {
      const batch = geminiCandidates.slice(i, i + BATCH_SIZE);

      try {
        console.log(`Sending AI Batch ${Math.floor(i / BATCH_SIZE) + 1} to native Gemini SDK...`);
        const aiResults = await screenCandidates(job, batch, company, localResultsById);

        aiResults.forEach((aiResult) => {
          const candidateId = String(aiResult.candidateId);
          const fallbackResult = finalResultsById.get(candidateId);

          if (!fallbackResult) {
            return;
          }

          finalResultsById.set(candidateId, mergeScreeningResult(fallbackResult, aiResult));
        });

        geminiEvaluatedCandidates += batch.length;

        if (i + BATCH_SIZE < geminiCandidates.length && BATCH_DELAY_MS > 0) {
          console.log(`Batch complete. Cooling down API connection for ${BATCH_DELAY_MS}ms to prevent 429 errors...`);
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      } catch (error) {
        console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} screening error:`, error.message);

        if (error.code === 'GEMINI_QUOTA_EXCEEDED') {
          geminiQuotaFallback = true;
          console.warn('Gemini quota exhausted. Remaining candidates will keep local heuristic scores for this run.');
          break;
        }
      }
    }

    const allResults = Array.from(finalResultsById.values()).map(stripInternalFields);

    // Sort all results by overall score descending
    allResults.sort((a, b) => (
      b.overallScore - a.overallScore ||
      b.skillMatchScore - a.skillMatchScore ||
      b.experienceScore - a.experienceScore
    ));

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const screeningDocs = allResults.map((result, index) => {
        const rank = index + 1;

        return {
          job: job._id,
          candidate: result.candidateId,
          overallScore: Math.round(result.overallScore) || 0,
          skillMatchScore: Math.round(result.skillMatchScore) || 0,
          experienceScore: Math.round(result.experienceScore) || 0,
          projectScore: Math.round(result.projectScore) || 0,
          credibilityScore: Math.round(result.credibilityScore) || 0,
          companyFitScore: Math.round(result.companyFitScore) || 0,
          rank,
          isShortlisted: rank <= job.shortlistSize,
          strengths: result.strengths || [],
          weaknesses: result.weaknesses || [],
          recommendation: result.recommendation || 'consider',
          reasoning: result.reasoning || '',
          skillAnalysis: result.skillAnalysis || '',
          experienceAnalysis: result.experienceAnalysis || '',
        };
      });

      const screeningResults = await ScreeningResult.insertMany(screeningDocs, { session });

      // Update job status to completed
      job.status = 'completed';
      job.screenedAt = new Date();
      await job.save({ session });

      await session.commitTransaction();
      session.endSession();

      const quotaMessage = geminiQuotaFallback
        ? ' Gemini quota ran out during this run, so remaining candidates used the local fallback scorer.'
        : '';

      res.json({
        success: true,
        message: `Screening completed. ${screeningResults.length} candidates evaluated, top ${job.shortlistSize} shortlisted.${quotaMessage}`,
        data: {
          totalEvaluated: screeningResults.length,
          shortlistSize: job.shortlistSize,
          geminiEvaluatedCandidates,
          geminiPoolSize,
          usedLocalFallback: geminiQuotaFallback,
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
