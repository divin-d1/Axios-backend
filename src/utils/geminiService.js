// Swapped to OpenRouter using native fetch to bypass Gemini strict limits
const initGemini = () => {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('API key is not configured in environment variables');
  }
  return apiKey;
};

const getModel = () => {
  const apiKey = initGemini();
  
  return {
    generateContent: async (prompt) => {
      // Determine if we should hit OpenRouter or fallback to raw Google (Based on key prefix)
      // OpenRouter keys start with sk-or-
      const isOpenRouter = apiKey.startsWith('sk-or-');
      const url = isOpenRouter ? 'https://openrouter.ai/api/v1/chat/completions' : `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
      
      const headers = isOpenRouter ? {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://axios-recruitment.com',
        'X-Title': 'Axios AI Recruitment',
      } : { 'Content-Type': 'application/json' };

      let textOutput = null;
      
      const openRouterModels = [
        'google/gemini-2.0-flash-lite-preview-02-05:free',
        'google/gemini-2.0-flash-thinking-exp:free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'google/gemini-2.5-flash'
      ];

      if (isOpenRouter) {
        let success = false;
        let lastError = null;
        for (const targetModel of openRouterModels) {
          const body = {
            model: targetModel,
            messages: [{ role: 'user', content: prompt }]
          };
          const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
          });
          const data = await response.json();
          if (response.ok && data.choices?.[0]?.message?.content) {
            textOutput = data.choices[0].message.content;
            success = true;
            break;
          } else {
            lastError = data.error?.message;
          }
        }
        if (!success) throw new Error(lastError || 'All OpenRouter fallbacks failed');
      } else {
        const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Google AI Generation Failed');
        textOutput = data.candidates[0].content.parts[0].text;
      }

      // Mock the official Google SDK response structure
      return { response: { text: () => textOutput } };
    }
  };
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

/**
 * Analyzes the structure of an unknown CSV using a small sample,
 * returning a mapping configuration that can be safely applied to 10k+ rows locally.
 */
const analyzeCSVStructure = async (sampleRows) => {
  const model = getModel();
  try {
    const prompt = `
You are an intelligent data-mapping assistant.
I have a CSV file with applicants, but the column names and formats are unknown. 
Here are the first few rows (as JSON):

${JSON.stringify(sampleRows, null, 2)}

Given our required Candidate Schema below, analyze the CSV data and determine the best mapping.
Candidate Schema requirement:
- firstName (string)
- lastName (string)
- email (string)
- headline (string)
- location (string)
- skills (array of strings)

Return ONLY a valid JSON object showing mapping configuration. Use the exact JSON structure below, filling in the "csv_column_name" where applicable. If a direct column doesn't exist, leave it null. If a column contains the full name, put it in "fullNameColumn". 

{
  "mappings": {
    "firstNameColumn": "csv_column_name",
    "lastNameColumn": "csv_column_name",
    "fullNameColumn": "csv_column_name",
    "emailColumn": "csv_column_name",
    "locationColumn": "csv_column_name",
    "headlineColumn": "csv_column_name",
    "skillsColumn": "csv_column_name",
    "projectsColumn": "csv_column_name",
    "educationColumn": "csv_column_name",
    "languagesColumn": "csv_column_name",
    "certificationsColumn": "csv_column_name",
    "workHistoryColumn": "csv_column_name"
  }
}
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
