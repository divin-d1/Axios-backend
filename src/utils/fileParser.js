const csvParser = require('csv-parser');
const XLSX = require('xlsx');
const { Readable } = require('stream');

const parseCSV = (fileBuffer) => {
  return new Promise((resolve, reject) => {
    const results = [];
    const stream = Readable.from(fileBuffer);
    
    stream
      .pipe(csvParser())
      .on('data', (row) => {
        const candidate = normalizeCandidateRow(row);
        if (candidate.firstName && candidate.lastName) {
          results.push(candidate);
        }
      })
      .on('end', () => resolve(results))
      .on('error', (error) => reject(new Error(`CSV parsing error: ${error.message}`)));
  });
};

const parseExcel = (fileBuffer) => {
  try {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(worksheet);
    
    return rawData
      .map(row => normalizeCandidateRow(row))
      .filter(c => c.firstName && c.lastName);
  } catch (error) {
    throw new Error(`Excel parsing error: ${error.message}`);
  }
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
 * Normalizes flat spreadsheet data into the nested Umurava Hackathon Spec
 */
const normalizeCandidateRow = (row) => {
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

  // Safe name splitting
  const rawName = findValue('name', 'fullname', 'full_name', 'candidatename');
  let first = findValue('firstname', 'first_name');
  let last = findValue('lastname', 'last_name');

  if (!first && !last && rawName) {
    const parts = rawName.split(' ');
    first = parts[0];
    last = parts.slice(1).join(' ') || '.';
  }

  const rawSkills = parseList(findValue('skills', 'technicalskills', 'tools'));
  const skillsObjects = rawSkills.map(skill => ({
    name: skill,
    level: 'Intermediate',
    yearsOfExperience: 0
  }));

  const experienceRole = findValue('jobtitle', 'currentrole', 'position', 'title');
  const experienceArray = experienceRole ? [{
    company: findValue('company', 'employer', 'organization', 'currentcompany'),
    role: experienceRole,
    startDate: findValue('startdate', 'start_date', 'joined'),
    endDate: findValue('enddate', 'end_date') || 'Present',
    description: findValue('responsibilities', 'duties'),
    technologies: parseList(findValue('technologies', 'stack')),
    isCurrent: !findValue('enddate', 'end_date')
  }] : [];

  return {
    firstName: first || 'Unknown',
    lastName: last || 'Unknown',
    email: findValue('email', 'emailaddress'),
    headline: findValue('headline', 'title', 'jobtitle') || 'Candidate',
    bio: findValue('bio', 'summary', 'about'),
    location: findValue('location', 'city', 'address', 'country') || 'Not specified',
    
    skills: skillsObjects,
    languages: parseList(findValue('languages', 'spokenlanguages')).map(l => ({
      name: l,
      proficiency: 'Conversational'
    })),
    
    experience: experienceArray,
    
    education: findValue('education', 'degree', 'qualification') ? [{
      institution: findValue('university', 'school', 'college', 'institution'),
      degree: findValue('degree', 'education', 'qualification'),
      fieldOfStudy: findValue('field', 'major', 'study'),
      startYear: 2018, // defaults
      endYear: parseInt(findValue('graduationyear', 'gradyear', 'year')) || 2022
    }] : [],
    
    certifications: [],
    projects: [],
    
    availability: {
      status: 'Open to Opportunities',
      type: 'Full-time',
      startDate: ''
    },
    
    socialLinks: {
      linkedin: findValue('linkedin', 'linkedinurl'),
      github: findValue('github', 'githuburl'),
      portfolio: findValue('portfolio', 'website')
    }
  };
};

module.exports = { parseCSV, parseExcel, parsePDF, normalizeCandidateRow };
