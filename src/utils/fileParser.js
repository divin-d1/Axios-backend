const csvParser = require('csv-parser');
const XLSX = require('xlsx');
const { Readable } = require('stream');

const parseCSVRaw = (fileBuffer) => {
  return new Promise((resolve, reject) => {
    const results = [];
    const stream = Readable.from(fileBuffer);
    
    stream
      .pipe(csvParser())
      .on('data', (row) => results.push(row))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(new Error(`CSV parsing error: ${error.message}`)));
  });
};

const parseCSV = async (fileBuffer) => {
  const raw = await parseCSVRaw(fileBuffer);
  return raw.map(r => normalizeCandidateRow(r)).filter(c => c.firstName && c.lastName);
};

const parseExcelRaw = (fileBuffer) => {
  try {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(worksheet);
  } catch (error) {
    throw new Error(`Excel parsing error: ${error.message}`);
  }
};

const parseExcel = (fileBuffer) => {
  const raw = parseExcelRaw(fileBuffer);
  return raw.map(r => normalizeCandidateRow(r)).filter(c => c.firstName && c.lastName);
};

const parsePDF = async (fileBuffer) => {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(fileBuffer);
    return data.text;
  } catch (error) {
    throw new Error(`PDF parsing error: ${error.message}`);
  }
};

/**
 * Normalizes flat spreadsheet data into the nested Umurava Hackathon Candidate Schema.
 * Handles both standard column names AND the hackathon test CSV format:
 *   id, full_name, email, phone, location, linkedin, github, years_of_experience,
 *   summary, current_title, education_degree, education_institution, graduation_year,
 *   skills, work_history, projects, certifications, languages_spoken, availability,
 *   preferred_work_mode, expected_salary_usd, open_to_relocation, portfolio_url, cover_note
 */
const normalizeCandidateRow = (row, aiMappings = null) => {
  const getMapped = (key) => aiMappings && aiMappings[key] && row[aiMappings[key]] ? String(row[aiMappings[key]]).trim() : '';

  const findValue = (...keys) => {
    for (const key of keys) {
      const found = Object.keys(row).find(k => 
        k.toLowerCase().trim().replace(/[_\s-]/g, '') === key.toLowerCase().replace(/[_\s-]/g, '')
      );
      if (found && row[found]) return String(row[found]).trim();
    }
    return '';
  };

  const parseList = (value) => {
    if (!value) return [];
    return value.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
  };

  // --- Name splitting (Using AI Mappings first, then fuzzy fallback) ---
  const rawName = getMapped('fullNameColumn') || findValue('name', 'fullname', 'full_name', 'candidatename', 'applicantname', 'full name', 'applicant');
  let first = getMapped('firstNameColumn') || findValue('firstname', 'first_name', 'first name', 'fname', 'givenname');
  let last = getMapped('lastNameColumn') || findValue('lastname', 'last_name', 'last name', 'lname', 'surname', 'familyname');

  if (!first && !last && rawName) {
    const parts = rawName.split(' ');
    first = parts[0];
    last = parts.slice(1).join(' ') || '.';
  }

  // --- Skills ---
  const rawSkills = parseList(getMapped('skillsColumn') || findValue('skills', 'technicalskills', 'tools', 'corecompetencies', 'competencies', 'technologies', 'stack'));
  const yearsExp = parseInt(findValue('yearsofexperience', 'years_of_experience', 'experience', 'totalexperience', 'yearsexp')) || 0;
  const skillsObjects = rawSkills.map(skill => ({
    name: skill,
    level: yearsExp >= 10 ? 'Expert' : yearsExp >= 5 ? 'Advanced' : yearsExp >= 2 ? 'Intermediate' : 'Beginner',
    yearsOfExperience: yearsExp
  }));

  // --- Work History ---
  // Hackathon CSV: "Role at Company (YYYY-YYYY) | Role at Company (YYYY-YYYY)"
  const workHistoryRaw = findValue('workhistory', 'work_history', 'employment', 'experience', 'jobhistory', 'work experience');
  let experienceArray = [];
  if (workHistoryRaw) {
    const entries = workHistoryRaw.split(/\s*\|\s*/);
    experienceArray = entries.map(entry => {
      // "Software Developer at Slack (2023-2024)"
      const match = entry.match(/^(.+?)\s+at\s+(.+?)\s*\((\d{4})-(\d{4})\)\s*$/);
      if (match) {
        return {
          company: match[2].trim(),
          role: match[1].trim(),
          startDate: `${match[3]}-01`,
          endDate: parseInt(match[4]) >= new Date().getFullYear() ? 'Present' : `${match[4]}-12`,
          description: '',
          technologies: [],
          isCurrent: parseInt(match[4]) >= new Date().getFullYear()
        };
      }
      return { company: '', role: entry.trim(), startDate: '', endDate: '', description: '', technologies: [], isCurrent: false };
    }).filter(e => e.role);
  } else {
    const experienceRole = findValue('jobtitle', 'currentrole', 'position', 'title', 'currenttitle', 'current_title');
    if (experienceRole) {
      experienceArray = [{
        company: findValue('company', 'employer', 'organization', 'currentcompany'),
        role: experienceRole,
        startDate: findValue('startdate', 'start_date', 'joined'),
        endDate: findValue('enddate', 'end_date') || 'Present',
        description: findValue('responsibilities', 'duties'),
        technologies: parseList(findValue('technologies', 'stack')),
        isCurrent: !findValue('enddate', 'end_date')
      }];
    }
  }

  // --- Projects ---
  // Hackathon CSV: "Project description 1 || Project description 2"
  const projectsRaw = findValue('projects', 'project');
  let projectsArray = [];
  if (projectsRaw) {
    const entries = projectsRaw.split(/\s*\|\|\s*/);
    projectsArray = entries.map((desc, i) => ({
      name: `Project ${i + 1}`,
      description: desc.trim(),
      technologies: [],
      role: 'Developer',
      link: '',
      startDate: '',
      endDate: ''
    }));
  }

  // --- Certifications ---
  const certsRaw = findValue('certifications', 'certs', 'certificates');
  let certsArray = [];
  if (certsRaw) {
    certsArray = parseList(certsRaw).map(c => ({
      name: c,
      issuer: '',
      issueDate: ''
    }));
  }

  // --- Languages ---
  const langRaw = findValue('languages', 'spokenlanguages', 'languagesspoken', 'languages_spoken');
  const languagesArray = parseList(langRaw).map(l => ({
    name: l,
    proficiency: 'Conversational'
  }));

  // --- Education ---
  const degree = findValue('degree', 'education', 'qualification', 'educationdegree', 'education_degree');
  const institution = findValue('university', 'school', 'college', 'institution', 'educationinstitution', 'education_institution');
  const gradYear = parseInt(findValue('graduationyear', 'gradyear', 'year', 'graduation_year')) || 2022;
  let educationArray = [];
  if (degree || institution) {
    educationArray = [{
      institution: institution || 'Unknown',
      degree: degree || 'Unknown',
      fieldOfStudy: findValue('field', 'major', 'study', 'fieldofstudy') || '',
      startYear: gradYear - 4,
      endYear: gradYear
    }];
  }

  // --- Availability ---
  const availRaw = findValue('availability', 'noticePeriod', 'notice');
  const workMode = findValue('preferredworkmode', 'preferred_work_mode', 'workmode');

  return {
    firstName: first || 'Unknown',
    lastName: last || 'Unknown',
    email: findValue('email', 'emailaddress', 'e-mail', 'contact', 'contactemail', 'mail'),
    headline: findValue('headline', 'currenttitle', 'current_title', 'title', 'jobtitle', 'summary', 'role', 'currentrole', 'profession', 'position'),
    bio: findValue('bio', 'summary', 'about', 'covernote', 'cover_note', 'profile', 'objective'),
    location: findValue('location', 'city', 'address', 'country', 'region', 'state'),
    
    skills: skillsObjects,
    languages: languagesArray,
    
    experience: experienceArray,
    
    education: educationArray,
    
    certifications: certsArray,
    projects: projectsArray,
    
    availability: {
      status: availRaw ? 'Open to Opportunities' : 'Available',
      type: workMode || 'Full-time',
      startDate: ''
    },
    
    socialLinks: {
      linkedin: findValue('linkedin', 'linkedinurl'),
      github: findValue('github', 'githuburl'),
      portfolio: findValue('portfolio', 'website', 'portfoliourl', 'portfolio_url')
    }
  };
};

/**
 * Applies the Gemini AI mapping JSON to a raw CSV row.
 */
const applyAIMappingPattern = (row, mapping) => {
  const getValue = (colName) => colName && row[colName] ? String(row[colName]).trim() : '';

  // Fallback to normalized extraction if AI mapping is missing key fields
  if (!mapping.firstNameColumn && !mapping.fullNameColumn) {
    return normalizeCandidateRow(row);
  }

  let firstName = getValue(mapping.firstNameColumn);
  let lastName = getValue(mapping.lastNameColumn);
  
  if (!firstName && !lastName && mapping.fullNameColumn) {
    const fullName = getValue(mapping.fullNameColumn);
    const parts = fullName.split(' ');
    firstName = parts[0] || 'Unknown';
    lastName = parts.slice(1).join(' ') || '.';
  }

  // Same strategy for skills, etc. We use the existing logic but read from the exact column mapped by AI
  const parseList = (value) => value ? value.split(/[,;|]/).map(s => s.trim()).filter(Boolean) : [];
  
  const rawSkills = parseList(getValue(mapping.skillsColumn));
  const skillsObjects = rawSkills.map(skill => ({
    name: skill,
    level: 'Intermediate',
    yearsOfExperience: 0
  }));

  let experienceArray = [];
  const workHistory = getValue(mapping.workHistoryColumn);
  if (workHistory) {
      // Just fallback to the strong regex parser we built in normalizeCandidateRow 
      // but feeding it the specific AI-detected column value
      const mockRow = { workhistory: workHistory, jobtitle: getValue(mapping.headlineColumn) };
      const normalized = normalizeCandidateRow(mockRow);
      experienceArray = normalized.experience;
  }

  return {
    firstName: firstName || 'Unknown',
    lastName: lastName || 'Unknown',
    email: getValue(mapping.emailColumn) || 'no-email@example.com',
    headline: getValue(mapping.headlineColumn) || 'Candidate',
    location: getValue(mapping.locationColumn) || 'Not specified',
    bio: '',
    skills: skillsObjects,
    experience: experienceArray,
    languages: parseList(getValue(mapping.languagesColumn)).map(l => ({ name: l, proficiency: 'Conversational' })),
    education: [],
    certifications: [],
    projects: [],
    availability: { status: 'Open to Opportunities', type: 'Full-time', startDate: '' },
    socialLinks: {}
  };
};

module.exports = { parseCSV, parseExcel, parseCSVRaw, parseExcelRaw, parsePDF, normalizeCandidateRow, applyAIMappingPattern };

