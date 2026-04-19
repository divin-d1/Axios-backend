const { GoogleGenerativeAI } = require('@google/generative-ai');

const initGemini = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
};

const getModel = () => {
  const genAI = initGemini();
  return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
};

/**
 * Parses raw resume text into the official Umurava Hackathon JSON schema
 */
const parseResume = async (resumeText) => {
  const model = getModel();

  const prompt = `
    Extract the following structured candidate profile information from the given resume text.
    Return ONLY a raw JSON object string with NO markdown formatting, NO backticks, starting exactly with '{' and ending with '}'.
    If information is missing, use an empty string "" for strings, empty array [] for lists, and 0 for numbers.
    Follow this EXACT schema structure strictly:

    {
      "firstName": "First name of candidate",
      "lastName": "Last name of candidate",
      "email": "candidate email",
      "headline": "A short professional summary based on their experience (e.g. 'Backend Engineer - Node.js')",
      "bio": "A longer professional biography or summary if present",
      "location": "City, Country or standard location",
      "skills": [
        { "name": "Skill Name", "level": "Beginner|Intermediate|Advanced|Expert", "yearsOfExperience": 0 }
      ],
      "languages": [
        { "name": "Language", "proficiency": "Basic|Conversational|Fluent|Native" }
      ],
      "experience": [
        {
          "company": "Company Name",
          "role": "Job Title",
          "startDate": "YYYY-MM",
          "endDate": "YYYY-MM or Present",
          "description": "Key responsibilities and achievements",
          "technologies": ["Tech 1", "Tech 2"],
          "isCurrent": true/false
        }
      ],
      "education": [
        {
          "institution": "University/School",
          "degree": "Degree Type",
          "fieldOfStudy": "Major/Field",
          "startYear": 2020,
          "endYear": 2024
        }
      ],
      "certifications": [
        { "name": "Cert Name", "issuer": "Issuer", "issueDate": "YYYY-MM" }
      ],
      "projects": [
        {
          "name": "Project Name",
          "description": "What they did",
          "technologies": ["Tech 1"],
          "role": "Their role",
          "link": "URL",
          "startDate": "YYYY-MM",
          "endDate": "YYYY-MM"
        }
      ],
      "availability": {
        "status": "Open to Opportunities",
        "type": "Full-time"
      },
      "socialLinks": {
        "linkedin": "url",
        "github": "url",
        "portfolio": "url"
      }
    }

    Resume Text:
    """
    ${resumeText}
    """
  `;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    
    // Clean potential markdown artifacts
    let cleanJson = text;
    if (text.startsWith('```json')) cleanJson = text.replace(/```json\n/g, '').replace(/```/g, '');
    else if (text.startsWith('```')) cleanJson = text.replace(/```/g, '');

    return JSON.parse(cleanJson);
  } catch (error) {
    console.error('Gemini API Parsing Error:', error);
    // Return a graceful fallback conforming to the exact schema
    return {
      firstName: "Unknown",
      lastName: "Candidate",
      email: "",
      headline: "Resume Processing Error",
      location: "",
      skills: [],
      languages: [],
      experience: [],
      education: [],
      certifications: [],
      projects: [],
      availability: { status: "Available", type: "Full-time" },
      socialLinks: {}
    };
  }
};

/**
 * Screens candidates against a job description
 */
const screenCandidates = async (job, candidates, company) => {
  const model = getModel();

  const prompt = `
    Role: AI Recruiter. 
    Evaluate candidates vs job. Mitigate bias: ignore name/gender/age. Focus on skills/experience.

    JOB: ${job.title}
    REQ SKILLS: ${job.requiredSkills.join(', ')}
    PREF SKILLS: ${job.preferredSkills.join(', ')}
    MIN YRS: ${job.minExperience}
    STRICTNESS: ${job.rankingStrictness} (Strict=penalize missing. Flexible=reward potential).
    COMPANY: ${company.name} | ${company.industry} | ${company.hiringPhilosophy}

    WEIGHTS (%):
    Skill:${job.scoringWeights.skillMatch} | Exp:${job.scoringWeights.experienceDepth} | Proj:${job.scoringWeights.projectRelevance} | Cred:${job.scoringWeights.credibility} | Fit:${job.scoringWeights.companyFit}

    TARGET SIZE: ${job.shortlistSize} 

    CANDIDATES:
    ${JSON.stringify(candidates.map(c => ({
      id: c._id, 
      headline: c.headline,
      experience: c.experience,
      skills: c.skills,
      projects: c.projects
    })))}

    OUTPUT STRICT JSON ARRAY ONLY:
    [{
      "candidateId": "id",
      "overallScore": 85.5,
      "skillMatchScore": 90,
      "experienceScore": 80,
      "projectScore": 85,
      "credibilityScore": 75,
      "companyFitScore": 90,
      "rank": 1,
      "strengths": ["short strength1"],
      "weaknesses": ["short gap1"],
      "reasoning": "CAVEMAN SPEAK. 10 words max. Telegraphic style. Drop filler. e.g: 'Strong React. No CI/CD. Fit culture.'"
    }]
    Sort overallScore desc. Max length: ${job.shortlistSize}. No markdown. No backticks.
  `;

  try {
    const result = await model.generateContent(prompt);
    let text = result.response.text().trim();
    if (text.startsWith('```json')) text = text.replace(/```json\n/g, '').replace(/```/g, '');
    else if (text.startsWith('```')) text = text.replace(/```/g, '');
    
    return JSON.parse(text);
  } catch (error) {
    console.error('Gemini Screening Error:', error);
    throw new Error('Failed to run AI screening');
  }
};

/**
 * Generate a personalized summary for a specific candidate match
 */
const generateCandidateSummary = async (candidate, job) => {
  const model = getModel();
  const prompt = `Caveman mode: why ${candidate.headline} match ${job.title}. Telegraphic style. Max 10 words. Drop filler.`;
  
  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    return "Candidate aligns with certain core operational profiles.";
  }
};

/**
 * Analyzes the structure of an unknown CSV using a small sample,
 * returning a mapping configuration that can be safely applied to 10k+ rows locally.
 */
const analyzeCSVStructure = async (sampleRows) => {
  const model = getModel();
  try {
    const prompt = `
Role: AI data-mapper. Map unknown CSV structure to strict Candidate Schema.
Sample: ${JSON.stringify(sampleRows)}

Return STRICT JSON mapping ONLY:
{ "mappings": { "firstNameColumn": "csv_col", "lastNameColumn": "csv_col", "fullNameColumn": "csv_col", "emailColumn": "csv_col", "locationColumn": "csv_col", "headlineColumn": "csv_col", "skillsColumn": "csv_col", "workHistoryColumn": "csv_col" } }
If col missing, null. Full name -> fullNameColumn. No markdown.
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const cleanText = text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(cleanText);
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
