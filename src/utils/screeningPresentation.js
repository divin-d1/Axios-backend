const LOCAL_REASONING_PATTERNS = [
  /^\d+\/\d+\s+req(?:\.|$)/i,
  /^\d+(?:\.\d+)?y\s+exp(?:\.|$)/i,
  /^proj\s+(?:fit|thin)(?:\.|$)/i,
  /^\d+\s+gaps(?:\.|$)/i,
  /^Profile mixed\. Needs review\.$/i
];

const LOCAL_STRENGTH_PATTERNS = [
  /^Matched \d+\/\d+ required skills$/i,
  /^Meets \d+\+ years expectation$/i,
  /^Shows relevant project evidence$/i,
  /^Profile data is reasonably complete$/i
];

const LOCAL_WEAKNESS_PATTERNS = [
  /^Missing \d+ required skills$/i,
  /^Below \d+ years target$/i,
  /^Limited project relevance shown$/i,
  /^Profile information is thin$/i
];

const toPlainObject = (value) => (
  value && typeof value.toObject === 'function'
    ? value.toObject({ virtuals: true })
    : value
);

const getCandidateDisplayName = (candidate) => {
  if (!candidate) return 'Unknown';

  const plainCandidate = toPlainObject(candidate);
  const fullName = [plainCandidate?.firstName, plainCandidate?.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  return fullName || plainCandidate?.displayName || plainCandidate?.name || 'Unknown';
};

const getCandidateInitials = (candidate) => {
  if (!candidate) return '?';

  const plainCandidate = toPlainObject(candidate);
  const initials = [plainCandidate?.firstName, plainCandidate?.lastName]
    .filter(Boolean)
    .map((part) => String(part).trim().charAt(0))
    .filter(Boolean)
    .join('')
    .slice(0, 2)
    .toUpperCase();

  if (initials) {
    return initials;
  }

  return getCandidateDisplayName(plainCandidate).charAt(0).toUpperCase() || '?';
};

const inferLegacyEvaluationMode = (screeningResult) => {
  const plainResult = toPlainObject(screeningResult) || {};

  if (
    plainResult.evaluationMode === 'groq' ||
    plainResult.evaluationMode === 'gemini' || // legacy DB records
    plainResult.evaluationMode === 'local-fallback'
  ) {
    // Normalise legacy 'gemini' label to 'groq'
    return plainResult.evaluationMode === 'gemini' ? 'groq' : plainResult.evaluationMode;
  }

  const reasoning = String(plainResult.reasoning || '').trim();
  const strengths = Array.isArray(plainResult.strengths) ? plainResult.strengths : [];
  const weaknesses = Array.isArray(plainResult.weaknesses) ? plainResult.weaknesses : [];

  const looksLikeLocalReasoning = LOCAL_REASONING_PATTERNS.some((pattern) => pattern.test(reasoning));
  const localStrengthCount = strengths.filter((item) => LOCAL_STRENGTH_PATTERNS.some((pattern) => pattern.test(String(item || '').trim()))).length;
  const localWeaknessCount = weaknesses.filter((item) => LOCAL_WEAKNESS_PATTERNS.some((pattern) => pattern.test(String(item || '').trim()))).length;

  if (looksLikeLocalReasoning || localStrengthCount + localWeaknessCount >= 2) {
    return 'local-fallback';
  }

  return 'groq';
};

const serializeCandidate = (candidate) => {
  if (!candidate) {
    return null;
  }

  const plainCandidate = toPlainObject(candidate);
  const displayName = getCandidateDisplayName(plainCandidate);

  return {
    _id: plainCandidate._id,
    firstName: plainCandidate.firstName || '',
    lastName: plainCandidate.lastName || '',
    displayName,
    name: displayName,
    initials: getCandidateInitials(plainCandidate),
    email: plainCandidate.email || '',
    headline: plainCandidate.headline || '',
    location: plainCandidate.location || '',
    source: plainCandidate.source || '',
    totalYearsExperience: plainCandidate.totalYearsExperience || 0,
    skills: plainCandidate.skills || []
  };
};

const serializeScreeningResult = (screeningResult) => {
  const plainResult = toPlainObject(screeningResult) || {};
  const evaluationMode = inferLegacyEvaluationMode(plainResult);

  return {
    _id: plainResult._id,
    job: plainResult.job,
    candidate: serializeCandidate(plainResult.candidate),
    overallScore: plainResult.overallScore || 0,
    matchScore: plainResult.overallScore || 0,
    skillMatchScore: plainResult.skillMatchScore || 0,
    experienceScore: plainResult.experienceScore || 0,
    projectScore: plainResult.projectScore || 0,
    credibilityScore: plainResult.credibilityScore || 0,
    companyFitScore: plainResult.companyFitScore || 0,
    scores: {
      skills: plainResult.skillMatchScore || 0,
      experience: plainResult.experienceScore || 0,
      projects: plainResult.projectScore || 0,
      credibility: plainResult.credibilityScore || 0,
      companyFit: plainResult.companyFitScore || 0
    },
    rank: plainResult.rank || 0,
    isShortlisted: Boolean(plainResult.isShortlisted),
    strengths: plainResult.strengths || [],
    weaknesses: plainResult.weaknesses || [],
    recommendation: plainResult.recommendation || 'consider',
    reasoning: plainResult.reasoning || '',
    skillAnalysis: plainResult.skillAnalysis || '',
    experienceAnalysis: plainResult.experienceAnalysis || '',
    evaluationMode
  };
};

const buildScreeningMeta = (screeningResults, counts = {}) => {
  const normalizedResults = Array.isArray(screeningResults) ? screeningResults : [];
  const evaluationModes = normalizedResults.map((result) => inferLegacyEvaluationMode(result));
  const localFallbackCount = evaluationModes.filter((mode) => mode === 'local-fallback').length;
  const groqCount = evaluationModes.filter((mode) => mode === 'groq').length;

  let screeningMode = null;
  if (normalizedResults.length > 0) {
    if (localFallbackCount > 0 && groqCount > 0) {
      screeningMode = 'hybrid';
    } else if (localFallbackCount > 0) {
      screeningMode = 'local-fallback';
    } else {
      screeningMode = 'groq';
    }
  }

  return {
    usedLocalFallback: localFallbackCount > 0,
    screeningMode,
    totalResults: counts.totalResults ?? normalizedResults.length,
    shortlistedResults: counts.shortlistedResults ?? normalizedResults.filter((result) => Boolean(result.isShortlisted)).length
  };
};

module.exports = {
  getCandidateDisplayName,
  getCandidateInitials,
  inferLegacyEvaluationMode,
  serializeCandidate,
  serializeScreeningResult,
  buildScreeningMeta
};
