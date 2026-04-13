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
    You are an AI Recruitment Intelligence Engine for the Umurava platform. 
    Evaluate these candidates against the job requirements using the specified scoring weights.
    You must mitigate bias: ignore gender, race, age, and name. Focus purely on demonstrated skills and experience.

    JOB ROLE: ${job.title}
    DESCRIPTION: ${job.description}
    REQUIRED SKILLS: ${job.requiredSkills.join(', ')}
    PREFERRED SKILLS: ${job.preferredSkills.join(', ')}
    MINIMUM EXPERIENCE (YRS): ${job.minExperience}
    
    STRICTNESS LEVEL: ${job.rankingStrictness} 
    (If strict: heavily penalize missing requirements. If flexible: reward potential and transferrable skills).

    COMPANY CONTEXT:
    Name: ${company.name}
    Industry: ${company.industry}
    Hiring Philosophy: ${company.hiringPhilosophy}

    SCORING WEIGHTS (Must add to 100%):
    - Skill Match: ${job.scoringWeights.skillMatch}%
    - Experience Depth: ${job.scoringWeights.experienceDepth}%
    - Project Relevance: ${job.scoringWeights.projectRelevance}%
    - Credibility: ${job.scoringWeights.credibility}%
    - Company Fit: ${job.scoringWeights.companyFit}%

    TARGET SHORTLIST SIZE: ${job.shortlistSize} 

    CANDIDATES TO EVALUATE:
    ${JSON.stringify(candidates.map(c => ({
      id: c._id, 
      headline: c.headline,
      experience: c.experience,
      skills: c.skills,
      projects: c.projects
    })), null, 2)}

    OUTPUT INSTRUCTIONS:
    Return pure JSON, strictly formatted as an array of objects matching this exact structure:
    [
      {
        "candidateId": "matching candidate id",
        "overallScore": 85.5,
        "skillMatchScore": 90,
        "experienceScore": 80,
        "projectScore": 85,
        "credibilityScore": 75,
        "companyFitScore": 90,
        "rank": 1,
        "strengths": ["Strength 1", "Strength 2"],
        "weaknesses": ["Gap 1", "Gap 2"],
        "reasoning": "A comprehensive 3-5 sentence justification explaining how they map to the job requirements and company philosophy."
      }
    ]
    Sort the output array by 'overallScore' descending. Ensure sizes matches up to the SHORTLIST SIZE limit at maximum.
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
  const prompt = `Give a 3-sentence recruiter summary for why ${candidate.headline} is a match for ${job.title}.`;
  
  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    return "Candidate aligns with certain core operational profiles.";
  }
};

module.exports = {
  initGemini,
  parseResume,
  screenCandidates,
  generateCandidateSummary,
};
