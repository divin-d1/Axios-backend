const crypto = require('crypto');
const Groq = require('groq-sdk');
const { buildCandidateAISnapshot, compactText } = require('./screeningHeuristics');

// ─── In-memory caches ────────────────────────────────────────────────────────
const screeningCache = new Map();
const resumeCache = new Map();
const csvMappingCache = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────
const intFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const msFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Circuit-breaker timestamps (per feature)
let csvMappingGroqDisabledUntilMs = 0;
let resumeGroqDisabledUntilMs = 0;
let summaryGroqDisabledUntilMs = 0;

// ─── Groq client ─────────────────────────────────────────────────────────────
const initGroq = () => {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
};

// ─── Model resolution ────────────────────────────────────────────────────────
const VALID_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
];

const resolveModelName = () => {
  const envModel = (process.env.GROQ_MODEL || '').trim();
  if (VALID_MODELS.includes(envModel)) return envModel;
  if (envModel) {
    console.warn(`GROQ_MODEL="${envModel}" is not a recognised model. Defaulting to llama-3.3-70b-versatile.`);
  }
  return 'llama-3.3-70b-versatile';
};

const FALLBACK_MODEL = 'llama3-8b-8192';

// ─── Utilities ────────────────────────────────────────────────────────────────
const hashPayload = (payload) =>
  crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

const cleanJsonText = (text = '') =>
  String(text)
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

const parseGroqJson = (text, fallbackShape = 'object') => {
  const cleanText = cleanJsonText(text);
  try {
    return JSON.parse(cleanText);
  } catch {
    const startToken = fallbackShape === 'array' ? '[' : '{';
    const endToken   = fallbackShape === 'array' ? ']' : '}';
    const startIndex = cleanText.indexOf(startToken);
    const endIndex   = cleanText.lastIndexOf(endToken);
    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      return JSON.parse(cleanText.slice(startIndex, endIndex + 1));
    }
    throw new Error(`Could not parse JSON from Groq response: ${cleanText.slice(0, 200)}`);
  }
};

// ─── Error classification ─────────────────────────────────────────────────────
const isRateLimitError = (error) => {
  if (!error) return false;
  if (Number(error?.status) === 429) return true;
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota');
};

const isTransientError = (error) => {
  if (!error) return false;
  if (Number(error?.status) === 503 || Number(error?.status) === 502) return true;
  const msg = String(error?.message || '').toLowerCase();
  return (
    msg.includes('service unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('try again later')
  );
};

const extractRetryDelayMs = (error) => {
  // Groq surfaces retry-after in the error headers / message
  const match = String(error?.message || '').match(/try again in\s+([0-9.]+)s/i)
    || String(error?.message || '').match(/retry after\s+([0-9.]+)/i);
  if (match) return Math.ceil(Number(match[1]) * 1000);
  return 0;
};

const toRateLimitError = (error) => {
  const err = new Error('Groq rate limit exceeded');
  err.code = 'GROQ_RATE_LIMIT';
  err.retryAfterMs = extractRetryDelayMs(error) || 60000;
  err.originalError = error;
  return err;
};

// ─── Core request with retries ────────────────────────────────────────────────
/**
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, jsonMode?: boolean }} options
 */
const generateWithRetries = async (prompt, options = {}) => {
  const groq = initGroq();
  const maxRetries = intFromEnv('GROQ_MAX_RETRIES', 2);
  const primaryModel = options.model || resolveModelName();
  const maxTokens = options.maxTokens || intFromEnv('GROQ_MAX_OUTPUT_TOKENS', 2048);

  const buildMessages = () => [{ role: 'user', content: prompt }];

  const callModel = async (modelName) => {
    const params = {
      model: modelName,
      messages: buildMessages(),
      max_tokens: maxTokens,
      temperature: 0.1,
    };
    if (options.jsonMode) {
      params.response_format = { type: 'json_object' };
    }
    const completion = await groq.chat.completions.create(params);
    return completion.choices[0]?.message?.content || '';
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await callModel(primaryModel);
    } catch (error) {
      // Transient server errors — exponential backoff
      if (isTransientError(error)) {
        if (attempt === maxRetries) {
          console.warn(`Groq 5xx exhausted retries, trying fallback model ${FALLBACK_MODEL}...`);
          return await callModel(FALLBACK_MODEL);
        }
        const backoffMs = Math.min(5000 * Math.pow(2, attempt), 30000);
        console.warn(`Groq transient error on attempt ${attempt + 1}, retrying in ${backoffMs}ms...`);
        await sleep(backoffMs);
        continue;
      }

      // Rate limit — try fallback model once, then give up
      if (isRateLimitError(error)) {
        const rateLimitErr = toRateLimitError(error);

        if (attempt === 0 && primaryModel !== FALLBACK_MODEL) {
          console.warn(`Groq rate limit on ${primaryModel}, trying fallback ${FALLBACK_MODEL}...`);
          try {
            return await callModel(FALLBACK_MODEL);
          } catch (fallbackError) {
            if (isRateLimitError(fallbackError)) {
              throw toRateLimitError(fallbackError);
            }
            throw fallbackError;
          }
        }

        if (attempt < maxRetries) {
          const waitMs = Math.max(rateLimitErr.retryAfterMs, 5000);
          console.warn(`Groq rate limit, waiting ${waitMs}ms before retry ${attempt + 1}...`);
          await sleep(waitMs);
          continue;
        }

        throw rateLimitErr;
      }

      // Any other error — surface immediately
      throw error;
    }
  }

  throw new Error('Groq request failed after retries');
};

// ─── Shared helpers ───────────────────────────────────────────────────────────
const squeezeText = (text, maxChars) =>
  String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);

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
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8);

  const nameLine = lines.find((l) => l.length <= 60 && !l.includes('@')) || '';
  const nameParts = nameLine.split(/\s+/).filter(Boolean);

  return {
    firstName: nameParts[0] || 'Unknown',
    lastName: nameParts.slice(1).join(' ') || 'Candidate',
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
      portfolio: '',
    },
  };
};

const sanitizeScore = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
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
  recommendation: ['strongly-recommend', 'recommend', 'consider', 'not-recommended'].includes(
    result?.recommendation
  )
    ? result.recommendation
    : 'consider',
});

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parses raw resume text into the official candidate JSON schema.
 */
const parseResume = async (resumeText) => {
  if (String(process.env.GROQ_DISABLE_RESUME_PARSING || '').toLowerCase() === 'true') {
    return buildResumeFallback(resumeText);
  }
  if (Date.now() < resumeGroqDisabledUntilMs) {
    return buildResumeFallback(resumeText);
  }

  const trimmedText = squeezeText(resumeText, intFromEnv('RESUME_PARSE_MAX_CHARS', 4000));
  const fingerprint = trimmedText.slice(0, 300) + trimmedText.length;
  const cacheKey = hashPayload({ type: 'resume', fingerprint });

  if (resumeCache.has(cacheKey)) return resumeCache.get(cacheKey);

  const prompt = `Extract structured candidate profile JSON from the resume text below.
Return ONLY valid JSON — no markdown, no explanation.
Unknown values: "" or [] or 0.
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
${trimmedText}`;

  try {
    const text = await generateWithRetries(prompt, {
      maxTokens: intFromEnv('GROQ_RESUME_MAX_OUTPUT_TOKENS', 1800),
      jsonMode: true,
    });
    const parsed = parseGroqJson(text, 'object');
    resumeCache.set(cacheKey, parsed);
    return parsed;
  } catch (error) {
    if (error?.code === 'GROQ_RATE_LIMIT') {
      const cooldownMs = msFromEnv('GROQ_RESUME_RATE_LIMIT_COOLDOWN_MS', 60 * 60 * 1000);
      resumeGroqDisabledUntilMs = Date.now() + cooldownMs;
    }
    console.error('Groq Resume Parsing Error:', error.message);
    return buildResumeFallback(resumeText);
  }
};

/**
 * Screens candidates against a job description using Groq AI.
 */
const screenCandidates = async (job, candidates, company, localResultsById = new Map()) => {
  const candidateSnapshots = candidates.map((candidate) => {
    const localResult = localResultsById.get(String(candidate._id));
    return buildCandidateAISnapshot(candidate, localResult);
  });

  const cacheKey = hashPayload({
    type: 'screening',
    model: resolveModelName(),
    job: {
      id: String(job?._id || ''),
      title: job?.title || '',
      requiredSkills: job?.requiredSkills || [],
      preferredSkills: job?.preferredSkills || [],
      minExperience: job?.minExperience || 0,
      shortlistSize: job?.shortlistSize || 10,
      strictness: job?.rankingStrictness || 'balanced',
      scoringWeights: job?.scoringWeights || {},
    },
    company: {
      name: company?.name || '',
      industry: company?.industry || [],
      hiringPhilosophy: company?.hiringPhilosophy || 'balanced',
      techStack: company?.techStack || [],
    },
    candidateSnapshots,
  });

  if (screeningCache.has(cacheKey)) return screeningCache.get(cacheKey);

  const prompt = `You are an expert HR assessor with 10 years of experience.
Rank the candidates against the job strictly using the JSON evidence provided.
Ignore name, gender, age. Be concise and accurate.
Return a JSON ARRAY ONLY — no markdown, no backticks, no explanation.
Each element must match this exact shape:
{
  "candidateId": "id",
  "overallScore": 85,
  "skillMatchScore": 90,
  "experienceScore": 80,
  "projectScore": 85,
  "credibilityScore": 80,
  "companyFitScore": 85,
  "strengths": ["max 2 short items"],
  "weaknesses": ["max 2 short items"],
  "reasoning": "max 12 words why this score",
  "recommendation": "strongly-recommend|recommend|consider|not-recommended"
}
Job:
${JSON.stringify({
  title: compactText(job?.title || '', 80),
  requiredSkills: job?.requiredSkills || [],
  preferredSkills: job?.preferredSkills || [],
  minExperience: job?.minExperience || 0,
  shortlistSize: job?.shortlistSize || 10,
  strictness: job?.rankingStrictness || 'balanced',
  weights: job?.scoringWeights || {},
})}
Company:
${JSON.stringify({
  name: compactText(company?.name || '', 40),
  industry: company?.industry || [],
  hiringPhilosophy: company?.hiringPhilosophy || 'balanced',
  techStack: company?.techStack || [],
})}
Candidates:
${JSON.stringify(candidateSnapshots)}`;

  try {
    const text = await generateWithRetries(prompt, {
      maxTokens: intFromEnv('GROQ_SCREENING_MAX_OUTPUT_TOKENS', 1800),
      // JSON mode requires the word "json" in the prompt — it's there via "JSON ARRAY"
      jsonMode: false,
    });
    const parsed = parseGroqJson(text, 'array');
    const normalizedResults = Array.isArray(parsed)
      ? parsed.map((item, index) =>
          normalizeScreeningResponse(item, candidateSnapshots[index]?.id)
        )
      : [];

    screeningCache.set(cacheKey, normalizedResults);
    return normalizedResults;
  } catch (error) {
    console.error('Groq Screening Error:', error.message);
    throw error.code === 'GROQ_RATE_LIMIT'
      ? error
      : new Error('Failed to run AI screening');
  }
};

/**
 * Generates a short personalised summary for a candidate/job match.
 */
const generateCandidateSummary = async (candidate, job) => {
  if (String(process.env.GROQ_DISABLE_SUMMARY || '').toLowerCase() === 'true') {
    return 'Candidate aligns with some core role signals.';
  }
  if (Date.now() < summaryGroqDisabledUntilMs) {
    return 'Candidate aligns with some core role signals.';
  }

  const prompt = `In max 10 words, why does "${compactText(candidate?.headline || 'this candidate', 50)}" fit the role "${compactText(job?.title || 'this job', 50)}"? Reply with the sentence only.`;

  try {
    const text = await generateWithRetries(prompt, {
      maxTokens: intFromEnv('GROQ_SUMMARY_MAX_OUTPUT_TOKENS', 80),
    });
    return compactText(text, 80);
  } catch (error) {
    if (error?.code === 'GROQ_RATE_LIMIT') {
      const cooldownMs = msFromEnv('GROQ_SUMMARY_RATE_LIMIT_COOLDOWN_MS', 60 * 60 * 1000);
      summaryGroqDisabledUntilMs = Date.now() + cooldownMs;
    }
    return 'Candidate aligns with some core role signals.';
  }
};

/**
 * Analyses the structure of an unknown CSV using a small sample,
 * returning a column-mapping config that can be applied locally to large files.
 */
const analyzeCSVStructure = async (sampleRows) => {
  if (String(process.env.GROQ_DISABLE_CSV_MAPPING || '').toLowerCase() === 'true') {
    return null;
  }
  if (Date.now() < csvMappingGroqDisabledUntilMs) {
    return null;
  }

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
    rows: reducedSampleRows,
  });

  if (csvMappingCache.has(cacheKey)) return csvMappingCache.get(cacheKey);

  const prompt = `Map the unknown CSV columns below to the candidate schema fields.
Return ONLY valid JSON — no markdown, no explanation.
{ "mappings": { "firstNameColumn": null, "lastNameColumn": null, "fullNameColumn": null, "emailColumn": null, "locationColumn": null, "headlineColumn": null, "skillsColumn": null, "workHistoryColumn": null, "languagesColumn": null } }
Sample rows:
${JSON.stringify(reducedSampleRows)}`;

  try {
    const text = await generateWithRetries(prompt, {
      maxTokens: intFromEnv('GROQ_CSV_MAX_OUTPUT_TOKENS', 300),
      jsonMode: true,
    });
    const parsed = parseGroqJson(text, 'object');
    csvMappingCache.set(cacheKey, parsed);
    return parsed;
  } catch (error) {
    if (error?.code === 'GROQ_RATE_LIMIT') {
      const cooldownMs = msFromEnv('GROQ_CSV_RATE_LIMIT_COOLDOWN_MS', 60 * 60 * 1000);
      csvMappingGroqDisabledUntilMs = Date.now() + cooldownMs;
    }
    console.error('Groq CSV mapping error:', error.message);
    return null;
  }
};

module.exports = {
  parseResume,
  screenCandidates,
  generateCandidateSummary,
  analyzeCSVStructure,
};
