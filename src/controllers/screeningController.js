const mongoose = require('mongoose');
const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const Company = require('../models/Company');
const ScreeningResult = require('../models/ScreeningResult');
const { screenCandidates } = require('../utils/geminiService');
const { buildLocalScreeningResult } = require('../utils/screeningHeuristics');
const { buildScreeningMeta, serializeScreeningResult } = require('../utils/screeningPresentation');

const getLatestCandidateMutation = (candidates) => candidates.reduce((latest, candidate) => {
  const candidateTimestamp = new Date(candidate.updatedAt || candidate.createdAt || 0).getTime();
  return Math.max(latest, candidateTimestamp);
}, 0);

const getGeminiPoolSize = (shortlistSize, totalCandidates) => {
  const mode = String(process.env.GEMINI_SCREENING_REFINE_POOL_MODE || 'shortlist-only').toLowerCase();
  if (mode === 'shortlist-only') {
    return Math.min(totalCandidates, Math.max(1, Number(shortlistSize) || 1));
  }

  const multiplier = Math.max(1, Number(process.env.GEMINI_AI_POOL_MULTIPLIER || 2));
  const minPool = Math.max(shortlistSize, Number(process.env.GEMINI_AI_POOL_MIN || 12));
  const maxPool = Math.max(shortlistSize, Number(process.env.GEMINI_AI_POOL_MAX || 36));
  const desiredPool = Math.ceil(shortlistSize * multiplier);

  return Math.min(totalCandidates, Math.max(minPool, Math.min(maxPool, desiredPool)));
};

const companyScreeningLocks = new Map();
const acquireCompanyScreeningLock = (companyId) => {
  const key = String(companyId || '');
  if (!key) return true;

  const now = Date.now();
  const ttlMs = Math.max(5 * 1000, Number(process.env.SCREENING_LOCK_TTL_MS || 10 * 60 * 1000));
  const existing = companyScreeningLocks.get(key);

  if (existing && existing.expiresAt > now) {
    return false;
  }

  companyScreeningLocks.set(key, { expiresAt: now + ttlMs });
  return true;
};

const releaseCompanyScreeningLock = (companyId) => {
  const key = String(companyId || '');
  if (!key) return;
  companyScreeningLocks.delete(key);
};

const stripInternalFields = (result) => {
  const { _localMeta, ...cleanResult } = result;
  return cleanResult;
};

const mergeScreeningResult = (fallbackResult, aiResult) => ({
  ...fallbackResult,
  ...aiResult,
  candidateId: fallbackResult.candidateId,
  evaluationMode: 'gemini',
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
  let lockCompanyId = null;
  let lockAcquired = false;

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
    const existingResults = await ScreeningResult.find({ job: job._id })
      .populate('candidate', 'firstName lastName email headline location source skills')
      .sort({ rank: 1 });
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
      const reusedResults = existingResults.map((result) => serializeScreeningResult(result));
      const reusedMeta = buildScreeningMeta(existingResults, {
        totalResults: existingResults.length,
        shortlistedResults: existingResults.filter((result) => result.isShortlisted).length
      });

      return res.json({
        success: true,
        message: `Existing screening reused. ${existingResults.length} candidates already scored with no job or candidate changes detected.`,
        data: {
          totalEvaluated: existingResults.length,
          shortlistSize: job.shortlistSize,
          reusedExisting: true,
          results: reusedResults,
          meta: reusedMeta,
        },
      });
    }

    lockCompanyId = company._id;
    lockAcquired = acquireCompanyScreeningLock(lockCompanyId);
    if (!lockAcquired) {
      return res.status(409).json({
        error: 'A screening run is already in progress for your company. Please wait 1–2 minutes and retry.'
      });
    }

    // Update job status to screening
    job.status = 'screening';
    await job.save();

    // Clear previous screening results for this job
    await ScreeningResult.deleteMany({ job: job._id });

    // Build candidate map for reference
    const candidateById = new Map(candidates.map((candidate) => [String(candidate._id), candidate]));

    const BATCH_SIZE = Math.max(1, Number(process.env.GEMINI_SCREENING_BATCH_SIZE || 8));
    const BATCH_DELAY_MS = Math.max(0, Number(process.env.GEMINI_SCREENING_BATCH_DELAY_MS || 3000));
    const finalResultsById = new Map();
    let geminiQuotaFallback = false;
    let geminiEvaluatedCandidates = 0;

    // ── Step 1: Try Gemini FIRST on ALL candidates ──────────────────────────
    console.log(`Starting AI screening for ${candidates.length} candidates...`);

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);

      try {
        console.log(`Sending AI Batch ${Math.floor(i / BATCH_SIZE) + 1} to Gemini...`);
        const aiResults = await screenCandidates(job, batch, company, new Map());

        aiResults.forEach((aiResult) => {
          finalResultsById.set(String(aiResult.candidateId), {
            ...aiResult,
            evaluationMode: 'gemini'
          });
        });

        geminiEvaluatedCandidates += batch.length;

        if (i + BATCH_SIZE < candidates.length && BATCH_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      } catch (error) {
        console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} AI error:`, error.message);

        if (error.code === 'GEMINI_QUOTA_EXCEEDED') {
          geminiQuotaFallback = true;
          console.warn('Gemini quota exhausted. Falling back to local heuristics for remaining candidates.');
          // Fall back remaining candidates that weren't processed
          batch.forEach((candidate) => {
            if (!finalResultsById.has(String(candidate._id))) {
              const localResult = buildLocalScreeningResult(job, candidate, company);
              finalResultsById.set(String(candidate._id), {
                ...localResult,
                evaluationMode: 'local-fallback'
              });
            }
          });
          // Process remaining batches with local scoring
          for (let j = i + BATCH_SIZE; j < candidates.length; j += BATCH_SIZE) {
            const remainingBatch = candidates.slice(j, j + BATCH_SIZE);
            remainingBatch.forEach((candidate) => {
              const localResult = buildLocalScreeningResult(job, candidate, company);
              finalResultsById.set(String(candidate._id), {
                ...localResult,
                evaluationMode: 'local-fallback'
              });
            });
          }
          break;
        }

        // For non-quota errors (404, 503 exhausted), fall back this batch to local
        console.warn(`AI failed for batch, using local fallback for ${batch.length} candidates.`);
        batch.forEach((candidate) => {
          if (!finalResultsById.has(String(candidate._id))) {
            const localResult = buildLocalScreeningResult(job, candidate, company);
            finalResultsById.set(String(candidate._id), {
              ...localResult,
              evaluationMode: 'local-fallback'
            });
          }
        });
        geminiQuotaFallback = true;
      }
    }

    // ── Step 2: Ensure every candidate has a result (safety net) ────────────
    candidates.forEach((candidate) => {
      if (!finalResultsById.has(String(candidate._id))) {
        const localResult = buildLocalScreeningResult(job, candidate, company);
        finalResultsById.set(String(candidate._id), {
          ...localResult,
          evaluationMode: 'local-fallback'
        });
      }
    });

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
          evaluationMode: result.evaluationMode || 'local-fallback',
        };
      });

      const screeningResults = await ScreeningResult.insertMany(screeningDocs, { session });

      // Update job status to completed
      job.status = 'completed';
      job.screenedAt = new Date();
      await job.save({ session });

      await session.commitTransaction();
      session.endSession();

      const screeningMeta = buildScreeningMeta(screeningResults, {
        totalResults: screeningResults.length,
        shortlistedResults: screeningResults.filter((result) => result.isShortlisted).length
      });

      const quotaMessage = geminiQuotaFallback
        ? ' Gemini quota ran out during this run, so remaining candidates used the local fallback scorer.'
        : '';

      releaseCompanyScreeningLock(lockCompanyId);
      lockAcquired = false;

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
          meta: screeningMeta,
        },
      });
    } catch (transactionError) {
      await session.abortTransaction();
      session.endSession();
      throw transactionError;
    }
  } catch (error) {
    next(error);
  } finally {
    if (lockAcquired && lockCompanyId) {
      releaseCompanyScreeningLock(lockCompanyId);
    }
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

    const [results, allResults] = await Promise.all([
      ScreeningResult.find(filter)
        .populate('candidate', 'firstName lastName email headline location source skills')
        .sort({ rank: 1 }),
      ScreeningResult.find({ job: req.params.jobId })
        .select('evaluationMode reasoning strengths weaknesses isShortlisted')
    ]);

    const serializedResults = results.map((result) => serializeScreeningResult(result));
    const meta = buildScreeningMeta(results, {
      totalResults: allResults.length,
      shortlistedResults: allResults.filter((result) => result.isShortlisted).length
    });
    const jobSummary = {
      _id: job._id,
      title: job.title,
      company: job.company?.name || '',
      shortlistSize: job.shortlistSize
    };

    res.json({
      success: true,
      data: {
        job: jobSummary,
        results: serializedResults,
        meta,
      },
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
