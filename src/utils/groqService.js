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
  strengths: Array.isArray(result?.strengths)
    ? result.strengths.map((s) => compactText(String(s || ''), 120)).filter(Boolean).slice(0, 3)
    : [],
  weaknesses: Array.isArray(result?.weaknesses)
    ? result.weaknesses.map((w) => compactText(String(w || ''), 120)).filter(Boolean).slice(0, 3)
    : [],
  reasoning: compactText(result?.reasoning || '', 200),
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
 * Screens candidates against a job description using AI.
 * Uses a comprehensive multi-dimensional evaluation prompt.
 */
const screenCandidates = async (job, candidates, company, localResultsById = new Map()) => {
  const candidateSnapshots = candidates.map((candidate) => {
    const localResult = localResultsById.get(String(candidate._id));
    return buildCandidateAISnapshot(candidate, localResult);
  });

  // Build rich job context for the prompt
  const jobContext = {
    title: compactText(job?.title || '', 120),
    description: compactText(job?.description || '', 800),
    department: compactText(job?.department || '', 60),
    requiredSkills: job?.requiredSkills || [],
    preferredSkills: job?.preferredSkills || [],
    responsibilities: (job?.responsibilities || []).map((r) => compactText(r, 150)),
    minExperience: job?.minExperience || 0,
    maxExperience: job?.maxExperience || null,
    educationLevel: job?.educationLevel || 'any',
    employmentType: job?.employmentType || 'full-time',
    location: compactText(job?.location || '', 60),
    salaryRange: job?.salaryRange || null,
    shortlistSize: job?.shortlistSize || 10,
    strictness: job?.rankingStrictness || 'balanced',
    weights: job?.scoringWeights || {},
  };

  // Build rich company context for the prompt
  const companyContext = {
    name: compactText(company?.name || '', 80),
    description: compactText(company?.description || '', 400),
    industry: company?.industry || [],
    specialization: compactText(company?.specialization || '', 100),
    departments: (company?.departments || []).slice(0, 8),
    size: company?.size || 'medium',
    techStack: company?.techStack || [],
    hiringPhilosophy: company?.hiringPhilosophy || 'balanced',
  };

  const cacheKey = hashPayload({
    type: 'screening-v2',
    model: resolveModelName(),
    job: {
      id: String(job?._id || ''),
      title: jobContext.title,
      requiredSkills: jobContext.requiredSkills,
      preferredSkills: jobContext.preferredSkills,
      minExperience: jobContext.minExperience,
      shortlistSize: jobContext.shortlistSize,
      strictness: jobContext.strictness,
      scoringWeights: jobContext.weights,
    },
    company: {
      name: companyContext.name,
      industry: companyContext.industry,
      hiringPhilosophy: companyContext.hiringPhilosophy,
      techStack: companyContext.techStack,
    },
    candidateSnapshots,
  });

  if (screeningCache.has(cacheKey)) return screeningCache.get(cacheKey);

  // ─── Build the comprehensive screening prompt ────────────────────────
  const prompt = `You are a world-class Senior Technical Recruiter and HR Assessment Specialist with over 15 years of hands-on experience in talent acquisition across technology companies ranging from early-stage startups to Fortune 500 enterprises. You have personally screened over 50,000 resumes and conducted more than 10,000 technical interviews. You hold certifications in SHRM-SCP (Society for Human Resource Management — Senior Certified Professional) and AIRS (Advanced Internet Recruitment Strategies). Your specialties include competency-based assessment, behavioural interviewing, skills-gap analysis, and data-driven candidate ranking.

You are about to perform a rigorous, evidence-based screening of a batch of candidates against a specific job opening. Your evaluation must be precise, differentiated, and grounded in the actual data provided for each candidate. You must not guess, hallucinate, or invent information that is not present in the candidate profiles.

═══════════════════════════════════════════════════════════════════════
SECTION 1 — THE JOB OPENING
═══════════════════════════════════════════════════════════════════════

Title: ${jobContext.title}
Department: ${jobContext.department || 'Not specified'}
Employment Type: ${jobContext.employmentType}
Location: ${jobContext.location || 'Not specified'}
Education Requirement: ${jobContext.educationLevel}
Minimum Experience Required: ${jobContext.minExperience} years${jobContext.maxExperience ? ` (max: ${jobContext.maxExperience} years)` : ''}
Ranking Strictness: ${jobContext.strictness}

Job Description:
${jobContext.description || 'No detailed description provided.'}

Required Skills (MUST-HAVE — candidates missing these should be penalized significantly):
${jobContext.requiredSkills.length > 0 ? jobContext.requiredSkills.map((s, i) => `  ${i + 1}. ${s}`).join('\n') : '  None specified — evaluate based on role title relevance.'}

Preferred Skills (NICE-TO-HAVE — bonus points, but not dealbreakers):
${jobContext.preferredSkills.length > 0 ? jobContext.preferredSkills.map((s, i) => `  ${i + 1}. ${s}`).join('\n') : '  None specified.'}

Key Responsibilities:
${jobContext.responsibilities.length > 0 ? jobContext.responsibilities.map((r, i) => `  ${i + 1}. ${r}`).join('\n') : '  Not specified — infer from role title.'}

Scoring Weights (how much each dimension matters to this employer):
  - Skill Match: ${jobContext.weights.skillMatch || 30}%
  - Experience Depth: ${jobContext.weights.experienceDepth || 25}%
  - Project Relevance: ${jobContext.weights.projectRelevance || 20}%
  - Credibility: ${jobContext.weights.credibility || 15}%
  - Company Fit: ${jobContext.weights.companyFit || 10}%

═══════════════════════════════════════════════════════════════════════
SECTION 2 — THE HIRING COMPANY
═══════════════════════════════════════════════════════════════════════

Company: ${companyContext.name}
Industry: ${companyContext.industry.length > 0 ? companyContext.industry.join(', ') : 'Not specified'}
Size: ${companyContext.size}
Specialization: ${companyContext.specialization || 'General'}
Departments: ${companyContext.departments.length > 0 ? companyContext.departments.join(', ') : 'Not specified'}
Hiring Philosophy: ${companyContext.hiringPhilosophy}
${companyContext.description ? `\nCompany Description:\n${companyContext.description}` : ''}

Company Tech Stack:
${companyContext.techStack.length > 0 ? companyContext.techStack.map((t, i) => `  ${i + 1}. ${t}`).join('\n') : '  Not specified.'}

Important: The company's hiring philosophy directly affects how you should weight certain factors:
- "startup-fast": Prioritise hands-on builders with shipping velocity, side projects, and breadth of tools. Value practical output over formal credentials.
- "enterprise-structured": Prioritise formal education, certifications, structured methodologies, and depth over breadth. Value stability and process adherence.
- "research-heavy": Prioritise academic background, publications, deep technical expertise, and analytical rigour.
- "balanced": Evaluate all dimensions equally without bias toward any particular philosophy.

═══════════════════════════════════════════════════════════════════════
SECTION 3 — SCORING METHODOLOGY (YOU MUST FOLLOW THIS EXACTLY)
═══════════════════════════════════════════════════════════════════════

For EACH candidate, you must compute five sub-scores (0–100 each) and then derive an overall score. Each sub-score must be justified by specific evidence from the candidate's profile.

### 3.1 — skillMatchScore (0–100)
This measures how well the candidate's technical skills align with the job requirements.

Scoring rules:
- Start at 0. For each REQUIRED skill the candidate possesses, add (80 / total_required_skills) points.
- For each PREFERRED skill the candidate possesses, add (20 / total_preferred_skills) points.
- If the candidate has a skill listed but with very low experience (< 1 year), give only 50% credit for that skill.
- If the candidate has EXTRA skills highly relevant to the role (even if not listed as required/preferred), add up to 10 bonus points.
- If no required skills were specified in the job, evaluate based on how well the candidate's overall skill set aligns with what the role title typically demands.
- A candidate with ALL required skills and MOST preferred skills should score 85–100.
- A candidate with NO matching skills at all should score 0–15.
- IMPORTANT: Do NOT give the same skillMatchScore to candidates with clearly different skill profiles. Differentiate.

### 3.2 — experienceScore (0–100)
This measures the depth and relevance of the candidate's work experience.

Scoring rules:
- If minExperience > 0: A candidate meeting the minimum gets a base of 60. Each year above minimum adds 5 points (cap at 90). Each year below minimum deducts 10 points from 60.
- If minExperience = 0: Score based on total years: 0y = 20, 1–2y = 40, 3–4y = 55, 5–7y = 70, 8–10y = 80, 10+y = 90.
- Add up to 15 bonus points if recent roles are DIRECTLY relevant to the target role (same job function, same domain).
- Deduct up to 15 points if experience is in completely unrelated fields.
- A senior developer applying for a senior role with matching domain should score 80–95.
- A junior with 1 year in an unrelated field should score 15–30.

### 3.3 — projectScore (0–100)
This measures the relevance and quality of the candidate's project portfolio.

Scoring rules:
- If the candidate has projects listed: Evaluate each project for relevance to the job role, technologies used, and complexity.
- A project using the job's required tech stack is worth 25–35 points (up to 3 projects).
- A project in a related domain adds 10–15 points.
- If NO projects are listed: Score 10–25 based on whether their work experience implies project-like output.
- Extra credit (up to 10 points) for open-source contributions, GitHub activity, or portfolio links.
- NEVER give 0 for projects unless the candidate has literally zero evidence of any practical work.

### 3.4 — credibilityScore (0–100)
This measures how complete, verifiable, and trustworthy the candidate's profile is.

Scoring rules:
- Email present: +10
- Professional headline: +10
- Location specified: +8
- Number of skills listed: +3 per skill (max +25)
- Work experience entries: +10 per entry (max +20)
- Education listed: +10
- Certifications: +8 per certification (max +15)
- Projects listed: +5 per project (max +10)
- Social links (GitHub, LinkedIn, portfolio): +5 per link (max +10)
- A fully filled profile should score 75–100.
- A profile with only name and email should score 15–30.

### 3.5 — companyFitScore (0–100)
This measures how well the candidate fits the specific company context.

Scoring rules:
- Start at 40 (baseline — everyone has some potential fit).
- If the candidate's skills overlap with the company's tech stack, add up to 25 points proportionally.
- If the candidate's experience domain matches the company's industry, add 10–15 points.
- Apply hiring philosophy modifiers:
  - startup-fast: +10 if candidate has 2+ projects or diverse tool experience
  - enterprise-structured: +10 if candidate has formal education or certifications
  - research-heavy: +10 if candidate has academic background or deep specialization
- Location compatibility: +5 if candidate location matches job location or is remote-friendly.
- Cap at 100.

### 3.6 — overallScore Calculation
Compute the weighted average using the employer's scoring weights:
overallScore = (skillMatchScore × skillMatchWeight + experienceScore × experienceWeight + projectScore × projectWeight + credibilityScore × credibilityWeight + companyFitScore × companyFitWeight) / totalWeight

Apply strictness modifiers:
- "strict": Deduct 3 points per missing REQUIRED skill from overall score.
- "flexible": Add 2 bonus points if preferred skills are present.
- "balanced": No additional modifiers.

Round to nearest integer. Clamp between 0 and 100.

═══════════════════════════════════════════════════════════════════════
SECTION 4 — STRENGTHS AND WEAKNESSES GUIDELINES
═══════════════════════════════════════════════════════════════════════

For each candidate, provide exactly 2–3 strengths and 2–3 weaknesses.

STRENGTHS must be specific and evidence-based. Examples of GOOD strengths:
- "6 years of direct React and TypeScript experience matching core requirements"
- "Strong project portfolio with 3 production apps using Next.js and GraphQL"
- "B.S. Computer Science from accredited university plus AWS certification"
- "Current role as Senior Frontend Developer directly aligns with target position"

Examples of BAD strengths (do NOT write these):
- "Frontend Engineer role" (this just restates the job title)
- "Has experience" (too vague)
- "Good candidate" (meaningless)

WEAKNESSES must be specific and actionable. Examples of GOOD weaknesses:
- "Missing 3 of 5 required skills: TypeScript, GraphQL, and Next.js"
- "Only 2 years experience vs. 5-year minimum requirement"
- "No project portfolio or GitHub contributions to verify practical skills"
- "Experience is primarily in backend — limited evidence of frontend work"

Examples of BAD weaknesses (do NOT write these):
- "No skills listed" (if skills ARE listed, this is wrong)
- "Could improve" (too vague)

═══════════════════════════════════════════════════════════════════════
SECTION 5 — REASONING AND RECOMMENDATION
═══════════════════════════════════════════════════════════════════════

"reasoning" must be a concise 10–20 word summary that captures the key differentiator for this candidate. It should tell the recruiter at a glance why this candidate scored the way they did.

Good examples:
- "Strong React/TS match with 8y experience, but missing GraphQL and testing frameworks"
- "Excellent skill coverage and project depth, ideal senior-level candidate for this stack"
- "Junior profile with relevant skills but insufficient experience for senior role requirements"

"recommendation" must be one of:
- "strongly-recommend": overallScore >= 80 AND matches most required skills
- "recommend": overallScore 65–79 OR strong in key dimensions despite some gaps
- "consider": overallScore 45–64 OR mixed signals requiring recruiter judgement
- "not-recommended": overallScore < 45 OR critical skill gaps that cannot be overlooked

═══════════════════════════════════════════════════════════════════════
SECTION 6 — CRITICAL RULES
═══════════════════════════════════════════════════════════════════════

1. DIFFERENTIATE: No two candidates should receive identical scores unless they have genuinely identical profiles. Each candidate has unique strengths — find them and reflect them in scores.
2. USE THE DATA: Base every score on actual evidence from the candidate snapshot. If a candidate lists "React (5y), TypeScript (3y), Next.js (2y)" — that is 3 required skill matches. Score accordingly.
3. SPREAD THE RANGE: Use the full 0–100 range. A perfect candidate scores 90+. A terrible match scores 10–20. Most candidates should fall between 35–85.
4. SKILL MATCH IS KING: If the job lists required skills, the skillMatchScore should be the primary differentiator. A candidate with 5/5 required skills should score dramatically higher than one with 1/5.
5. NEVER GIVE FLAT SCORES: Giving all candidates the same score (e.g., 50 across all dimensions) is WRONG. This means you are not actually evaluating.
6. NEVER HALLUCINATE: If a field is empty or missing, score it low. Do not invent skills or experience that aren't listed.
7. IGNORE PROTECTED CHARACTERISTICS: Do not factor name, gender, ethnicity, or age into any scoring decision.
8. PRESERVE CANDIDATE IDs: The "candidateId" in your output MUST exactly match the "id" field from the candidate input data.

═══════════════════════════════════════════════════════════════════════
SECTION 7 — CANDIDATES TO EVALUATE
═══════════════════════════════════════════════════════════════════════

${JSON.stringify(candidateSnapshots, null, 1)}

═══════════════════════════════════════════════════════════════════════
SECTION 8 — REQUIRED OUTPUT FORMAT
═══════════════════════════════════════════════════════════════════════

Return ONLY a valid JSON array. No markdown. No backticks. No explanation text before or after. No comments.

Each element must match this EXACT shape:
{
  "candidateId": "<exact id from candidate data>",
  "overallScore": <integer 0-100>,
  "skillMatchScore": <integer 0-100>,
  "experienceScore": <integer 0-100>,
  "projectScore": <integer 0-100>,
  "credibilityScore": <integer 0-100>,
  "companyFitScore": <integer 0-100>,
  "strengths": ["specific evidence-based strength 1", "specific evidence-based strength 2"],
  "weaknesses": ["specific evidence-based weakness 1", "specific evidence-based weakness 2"],
  "reasoning": "<10-20 word summary of why this candidate received this score>",
  "recommendation": "strongly-recommend|recommend|consider|not-recommended"
}

Return one element per candidate. The array must contain exactly ${candidateSnapshots.length} elements, one for each candidate provided above.`;

  try {
    // Scale max tokens based on number of candidates (each needs ~200 tokens for output)
    const baseTokens = intFromEnv('GROQ_SCREENING_MAX_OUTPUT_TOKENS', 1800);
    const scaledTokens = Math.min(8000, Math.max(baseTokens, candidateSnapshots.length * 250));

    const text = await generateWithRetries(prompt, {
      maxTokens: scaledTokens,
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
    console.error('AI Screening Error:', error.message);
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
