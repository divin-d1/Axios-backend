const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { buildCandidateAISnapshot, compactText } = require('./screeningHeuristics');

const screeningCache = new Map();
const resumeCache = new Map();
const csvMappingCache = new Map();

const intFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const initGemini = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
};

const getModel = (generationConfig = {}) => {
  const genAI = initGemini();
  return genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: {
      temperature: 0.1,
      candidateCount: 1,
      maxOutputTokens: intFromEnv('GEMINI_MAX_OUTPUT_TOKENS', 2048),
      ...generationConfig
    }
  });
};

const hashPayload = (payload) => crypto
  .createHash('sha256')
  .update(JSON.stringify(payload))
  .digest('hex');

const cleanJsonText = (text = '') => String(text)
  .trim()
  .replace(/^```json\s*/i, '')
  .replace(/^```\s*/i, '')
  .replace(/\s*```$/i, '')
  .trim();

const parseGeminiJson = (text, fallbackShape = 'object') => {
  const cleanText = cleanJsonText(text);

  try {
    return JSON.parse(cleanText);
  } catch (error) {
    const startToken = fallbackShape === 'array' ? '[' : '{';
    const endToken = fallbackShape === 'array' ? ']' : '}';
    const startIndex = cleanText.indexOf(startToken);
    const endIndex = cleanText.lastIndexOf(endToken);

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      return JSON.parse(cleanText.slice(startIndex, endIndex + 1));
    }

    throw error;
  }
};

const extractRetryDelayMs = (error) => {
  const retryInfo = (error?.errorDetails || []).find((detail) => String(detail?.['@type'] || '').includes('RetryInfo'));
  const retryDelay = retryInfo?.retryDelay;
  if (retryDelay) {
    const seconds = Number(String(retryDelay).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  const match = String(error?.message || '').match(/retry in\s+([0-9.]+)s/i);
  if (match) {
    return Math.ceil(Number(match[1]) * 1000);
  }

  return 0;
};

const hasDailyQuotaViolation = (error) => {
  const quotaFailure = (error?.errorDetails || []).find((detail) => String(detail?.['@type'] || '').includes('QuotaFailure'));
  const violations = quotaFailure?.violations || [];
  return violations.some((violation) => String(violation?.quotaId || '').toLowerCase().includes('perday'));
};

const isQuotaExceededError = (error) => {
  if (!error) return false;

  if (Number(error?.status) === 429) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('quota exceeded') ||
    message.includes('too many requests') ||
    message.includes('rate limit')
  );
};

const toQuotaError = (error) => {
  const quotaError = new Error(hasDailyQuotaViolation(error)
    ? 'Gemini daily quota exhausted'
    : 'Gemini request quota exceeded');

  quotaError.code = 'GEMINI_QUOTA_EXCEEDED';
  quotaError.retryAfterMs = extractRetryDelayMs(error);
  quotaError.dailyLimitExceeded = hasDailyQuotaViolation(error);
  quotaError.originalError = error;

  return quotaError;
};

const generateContentWithRetries = async (model, prompt) => {
  const maxRetries = intFromEnv('GEMINI_MAX_RETRIES', 2);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await model.generateContent(prompt);
    } catch (error) {
      if (!isQuotaExceededError(error)) {
        throw error;
      }

      const quotaError = toQuotaError(error);
      if (quotaError.dailyLimitExceeded || attempt === maxRetries) {
        throw quotaError;
      }

      const retryAfterMs = Math.max(quotaError.retryAfterMs || 30000, 3000);
      await sleep(retryAfterMs + (attempt * 1000));
    }
  }

  throw new Error('Gemini request failed after retries');
};

const squeezeText = (text, maxChars) => String(text || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxChars);

const extractEmail = (text) => {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : '';
};

const extractSocialLink = (text, host) => {
  const regex = new RegExp(`https?:\\/\\/[^\\s]*${host}[^\\s]*`, 'i');
  const match = String(text || '').match(regex);
  return match ? match[0] : '';
};

const buildResumeFallback = (resumeText) => {
  const lines = String(resumeText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);

  const nameLine = lines.find((line) => line.length <= 60 && !line.includes('@')) || '';
  const nameParts = nameLine.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || 'Unknown';
  const lastName = nameParts.slice(1).join(' ') || 'Candidate';

  return {
    firstName,
    lastName,
    email: extractEmail(resumeText),
    headline: compactText(lines[1] || 'Resume Processing Error', 80),
    bio: '',
    location: '',
    skills: [],
    languages: [],
    experience: [],
    education: [],
    certifications: [],
    projects: [],
    availability: { status: 'Available', type: 'Full-time' },
    socialLinks: {
      linkedin: extractSocialLink(resumeText, 'linkedin.com'),
      github: extractSocialLink(resumeText, 'github.com'),
      portfolio: ''
    }
  };
};

const sanitizeScore = (value, fallback = 0) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numericValue * 10) / 10));
};

const normalizeScreeningResponse = (result, fallbackCandidateId) => ({
  candidateId: result?.candidateId || fallbackCandidateId,
  overallScore: sanitizeScore(result?.overallScore, 0),
  skillMatchScore: sanitizeScore(result?.skillMatchScore, 0),
  experienceScore: sanitizeScore(result?.experienceScore, 0),
  projectScore: sanitizeScore(result?.projectScore, 0),
  credibilityScore: sanitizeScore(result?.credibilityScore, 0),
  companyFitScore: sanitizeScore(result?.companyFitScore, 0),
  strengths: Array.isArray(result?.strengths) ? result.strengths.slice(0, 3) : [],
  weaknesses: Array.isArray(result?.weaknesses) ? result.weaknesses.slice(0, 3) : [],
  reasoning: compactText(result?.reasoning || '', 120),
  recommendation: ['strongly-recommend', 'recommend', 'consider', 'not-recommended'].includes(result?.recommendation)
    ? result.recommendation
    : 'consider'
});

/**
 * Parses raw resume text into the official Umurava Hackathon JSON schema
 */
const parseResume = async (resumeText) => {
  const model = getModel({
    responseMimeType: 'application/json',
    maxOutputTokens: intFromEnv('GEMINI_RESUME_MAX_OUTPUT_TOKENS', 1800)
  });

  const trimmedResumeText = squeezeText(resumeText, intFromEnv('RESUME_PARSE_MAX_CHARS', 12000));
  const cacheKey = hashPayload({ type: 'resume', trimmedResumeText });

  if (resumeCache.has(cacheKey)) {
    return resumeCache.get(cacheKey);
  }

  const prompt = `
Extract structured candidate profile JSON from resume text.
Return JSON only. No markdown. Unknown values: "" or [] or 0.
Schema:
{
  "firstName": "",
  "lastName": "",
  "email": "",
  "headline": "",
  "bio": "",
  "location": "",
  "skills": [{ "name": "", "level": "Beginner|Intermediate|Advanced|Expert", "yearsOfExperience": 0 }],
  "languages": [{ "name": "", "proficiency": "Basic|Conversational|Fluent|Native" }],
  "experience": [{ "company": "", "role": "", "startDate": "YYYY-MM", "endDate": "YYYY-MM or Present", "description": "", "technologies": [""], "isCurrent": false }],
  "education": [{ "institution": "", "degree": "", "fieldOfStudy": "", "startYear": 0, "endYear": 0 }],
  "certifications": [{ "name": "", "issuer": "", "issueDate": "YYYY-MM" }],
  "projects": [{ "name": "", "description": "", "technologies": [""], "role": "", "link": "", "startDate": "YYYY-MM", "endDate": "YYYY-MM" }],
  "availability": { "status": "", "type": "" },
  "socialLinks": { "linkedin": "", "github": "", "portfolio": "" }
}
Resume:
${trimmedResumeText}
`;

  try {
    const result = await generateContentWithRetries(model, prompt);
    const parsed = parseGeminiJson(result.response.text(), 'object');
    resumeCache.set(cacheKey, parsed);
    return parsed;
  } catch (error) {
    console.error('Gemini API Parsing Error:', error);
    return buildResumeFallback(resumeText);
  }
};

/**
 * Screens candidates against a job description
 */
const screenCandidates = async (job, candidates, company, localResultsById = new Map()) => {
  const model = getModel({
    responseMimeType: 'application/json',
    maxOutputTokens: intFromEnv('GEMINI_SCREENING_MAX_OUTPUT_TOKENS', 1800)
  });

  const candidateSnapshots = candidates.map((candidate) => {
    const localResult = localResultsById.get(String(candidate._id));
    return buildCandidateAISnapshot(candidate, localResult);
  });

  const cacheKey = hashPayload({
    type: 'screening',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    job: {
      id: String(job?._id || ''),
      title: job?.title || '',
      requiredSkills: job?.requiredSkills || [],
      preferredSkills: job?.preferredSkills || [],
      minExperience: job?.minExperience || 0,
      shortlistSize: job?.shortlistSize || 10,
      strictness: job?.rankingStrictness || 'balanced',
      scoringWeights: job?.scoringWeights || {}
    },
    company: {
      name: company?.name || '',
      industry: company?.industry || [],
      hiringPhilosophy: company?.hiringPhilosophy || 'balanced',
      techStack: company?.techStack || []
    },
    candidateSnapshots
  });

  if (screeningCache.has(cacheKey)) {
    return screeningCache.get(cacheKey);
  }

  const prompt = `
Rank recruiter candidates. Ignore name, gender, age.
Use only evidence in the JSON provided.
Return JSON array only. No markdown. No backticks.
One object per candidate with:
candidateId, overallScore, skillMatchScore, experienceScore, projectScore, credibilityScore, companyFitScore, strengths, weaknesses, reasoning, recommendation.
Rules:
- scores 0..100
- strengths max 2 items
- weaknesses max 2 items
- reasoning max 12 words, caveman style
- recommendation one of strongly-recommend, recommend, consider, not-recommended
Job:
${JSON.stringify({
  title: compactText(job?.title || '', 80),
  requiredSkills: job?.requiredSkills || [],
  preferredSkills: job?.preferredSkills || [],
  minExperience: job?.minExperience || 0,
  shortlistSize: job?.shortlistSize || 10,
  strictness: job?.rankingStrictness || 'balanced',
  weights: job?.scoringWeights || {}
})}
Company:
${JSON.stringify({
  name: compactText(company?.name || '', 40),
  industry: company?.industry || [],
  hiringPhilosophy: company?.hiringPhilosophy || 'balanced',
  techStack: company?.techStack || []
})}
Candidates:
${JSON.stringify(candidateSnapshots)}
`;

  try {
    const result = await generateContentWithRetries(model, prompt);
    const parsed = parseGeminiJson(result.response.text(), 'array');
    const normalizedResults = Array.isArray(parsed)
      ? parsed.map((item, index) => normalizeScreeningResponse(item, candidateSnapshots[index]?.id))
      : [];

    screeningCache.set(cacheKey, normalizedResults);
    return normalizedResults;
  } catch (error) {
    console.error('Gemini Screening Error:', error);
    throw error.code === 'GEMINI_QUOTA_EXCEEDED'
      ? error
      : new Error('Failed to run AI screening');
  }
};

/**
 * Generate a personalized summary for a specific candidate match
 */
const generateCandidateSummary = async (candidate, job) => {
  const model = getModel({
    maxOutputTokens: intFromEnv('GEMINI_SUMMARY_MAX_OUTPUT_TOKENS', 80)
  });

  const prompt = `Caveman mode. Why ${compactText(candidate?.headline || 'candidate', 50)} fit ${compactText(job?.title || 'job', 50)}? Max 10 words.`;

  try {
    const result = await generateContentWithRetries(model, prompt);
    return compactText(result.response.text(), 80);
  } catch (error) {
    return 'Candidate aligns with some core role signals.';
  }
};

/**
 * Analyzes the structure of an unknown CSV using a small sample,
 * returning a mapping configuration that can be safely applied to 10k+ rows locally.
 */
const analyzeCSVStructure = async (sampleRows) => {
  const model = getModel({
    responseMimeType: 'application/json',
    maxOutputTokens: intFromEnv('GEMINI_CSV_MAX_OUTPUT_TOKENS', 300)
  });

  const reducedSampleRows = (sampleRows || []).slice(0, 2).map((row) => {
    const reduced = {};

    for (const key of Object.keys(row || {}).slice(0, 20)) {
      reduced[key] = compactText(String(row[key] || ''), 80);
    }

    return reduced;
  });

  const cacheKey = hashPayload({
    type: 'csv-mapping',
    headers: reducedSampleRows.map((row) => Object.keys(row)),
    rows: reducedSampleRows
  });

  if (csvMappingCache.has(cacheKey)) {
    return csvMappingCache.get(cacheKey);
  }

  try {
    const prompt = `
Map unknown CSV columns to candidate schema.
Return JSON only:
{ "mappings": { "firstNameColumn": null, "lastNameColumn": null, "fullNameColumn": null, "emailColumn": null, "locationColumn": null, "headlineColumn": null, "skillsColumn": null, "workHistoryColumn": null, "languagesColumn": null } }
Sample rows:
${JSON.stringify(reducedSampleRows)}
`;

    const result = await generateContentWithRetries(model, prompt);
    const parsed = parseGeminiJson(result.response.text(), 'object');
    csvMappingCache.set(cacheKey, parsed);
    return parsed;
  } catch (error) {
    console.error('Gemini CSV mapping error:', error);
    return null;
  }
};

module.exports = {
  initGemini,
  parseResume,
  screenCandidates,
  generateCandidateSummary,
  analyzeCSVStructure
};
