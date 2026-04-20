const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'for',
  'from',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with'
]);

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));

const roundScore = (value) => Math.round((Number(value) || 0) * 10) / 10;

const normalizePhrase = (value = '') => String(value)
  .toLowerCase()
  .replace(/[^a-z0-9+#]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const normalizeCompact = (value = '') => normalizePhrase(value).replace(/\s+/g, '');

const toArray = (value) => Array.isArray(value) ? value : [];

const unique = (values) => [...new Set(values.filter(Boolean))];

const compactText = (value, maxLength = 140) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
};

const buildSearchText = (parts) => ` ${parts.map(normalizePhrase).filter(Boolean).join(' ')} `;

const getSkillEntries = (candidate) => toArray(candidate.skills).map((skill) => {
  if (typeof skill === 'string') {
    return { name: skill, yearsOfExperience: 0 };
  }

  return {
    name: skill?.name || '',
    yearsOfExperience: Number(skill?.yearsOfExperience) || 0
  };
}).filter((skill) => skill.name);

const getExperienceEntries = (candidate) => toArray(candidate.experience).map((experience) => ({
  company: experience?.company || '',
  role: experience?.role || '',
  startDate: experience?.startDate || '',
  endDate: experience?.endDate || '',
  description: compactText(experience?.description || '', 160),
  technologies: unique(toArray(experience?.technologies).map((technology) => compactText(technology, 40))),
  isCurrent: Boolean(experience?.isCurrent)
}));

const getProjectEntries = (candidate) => toArray(candidate.projects).map((project) => ({
  name: project?.name || '',
  role: project?.role || '',
  description: compactText(project?.description || '', 160),
  technologies: unique(toArray(project?.technologies).map((technology) => compactText(technology, 40)))
}));

const parseDateLike = (value, fallbackToCurrent = false) => {
  if (!value) return null;

  const text = String(value).trim();
  if (!text) return null;
  if (/present|current/i.test(text)) {
    return fallbackToCurrent ? new Date() : null;
  }

  const match = text.match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2] || 1);
  if (!year || month < 1 || month > 12) return null;

  return new Date(year, month - 1, 1);
};

const estimateExperienceYears = (candidate) => {
  const skillYears = Math.max(0, ...getSkillEntries(candidate).map((skill) => skill.yearsOfExperience || 0));

  let totalMonths = 0;
  for (const experience of getExperienceEntries(candidate)) {
    const startDate = parseDateLike(experience.startDate);
    const endDate = parseDateLike(experience.endDate, true) || (experience.isCurrent ? new Date() : null);

    if (!startDate || !endDate || endDate <= startDate) {
      continue;
    }

    const months = Math.max(
      1,
      (endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth())
    );

    totalMonths += months;
  }

  const datedExperienceYears = totalMonths > 0 ? totalMonths / 12 : 0;
  return roundScore(Math.max(skillYears, datedExperienceYears));
};

const extractJobKeywords = (job) => {
  const parts = [
    job?.title,
    ...(job?.requiredSkills || []),
    ...(job?.preferredSkills || []),
    ...(job?.responsibilities || [])
  ];

  return unique(
    parts
      .flatMap((value) => normalizePhrase(value).split(' '))
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  ).slice(0, 24);
};

const buildCandidateSignals = (candidate) => {
  const skills = getSkillEntries(candidate);
  const experiences = getExperienceEntries(candidate);
  const projects = getProjectEntries(candidate);

  const searchableParts = [
    candidate?.headline || '',
    candidate?.bio || '',
    candidate?.location || '',
    ...skills.map((skill) => skill.name),
    ...experiences.flatMap((experience) => [
      experience.role,
      experience.company,
      experience.description,
      ...experience.technologies
    ]),
    ...projects.flatMap((project) => [
      project.name,
      project.role,
      project.description,
      ...project.technologies
    ]),
    ...toArray(candidate?.certifications).map((certification) => certification?.name || ''),
    ...toArray(candidate?.education).map((education) => `${education?.degree || ''} ${education?.fieldOfStudy || ''}`.trim())
  ];

  const searchText = buildSearchText(searchableParts);
  const compactSet = new Set(
    searchableParts
      .map((part) => normalizeCompact(part))
      .filter(Boolean)
  );

  return { skills, experiences, projects, searchText, compactSet };
};

const matchesTerm = (term, searchText, compactSet) => {
  const phrase = normalizePhrase(term);
  if (!phrase) return false;

  if (searchText.includes(` ${phrase} `)) {
    return true;
  }

  return compactSet.has(normalizeCompact(term));
};

const scoreRecommendation = (overallScore) => {
  if (overallScore >= 82) return 'strongly-recommend';
  if (overallScore >= 68) return 'recommend';
  if (overallScore >= 48) return 'consider';
  return 'not-recommended';
};

const buildReasoning = (matchedRequiredSkills, requiredCount, estimatedYears, projectScore, missingRequiredSkills) => {
  const parts = [];

  if (requiredCount > 0) {
    parts.push(`${matchedRequiredSkills.length}/${requiredCount} req`);
  }

  if (estimatedYears > 0) {
    parts.push(`${Math.round(estimatedYears)}y exp`);
  }

  if (projectScore >= 60) {
    parts.push('proj fit');
  } else if (projectScore <= 25) {
    parts.push('proj thin');
  }

  if (missingRequiredSkills.length > 0) {
    parts.push(`${missingRequiredSkills.length} gaps`);
  }

  const text = parts.slice(0, 3).join('. ').trim();
  return text ? `${text}.` : 'Profile mixed. Needs review.';
};

const buildStrengths = (matchedRequiredSkills, requiredCount, estimatedYears, minExperience, projectScore, credibilityScore) => {
  const strengths = [];

  if (requiredCount > 0 && matchedRequiredSkills.length > 0) {
    strengths.push(`Matched ${matchedRequiredSkills.length}/${requiredCount} required skills`);
  }

  if (minExperience > 0 && estimatedYears >= minExperience) {
    strengths.push(`Meets ${minExperience}+ years expectation`);
  }

  if (projectScore >= 60) {
    strengths.push('Shows relevant project evidence');
  }

  if (credibilityScore >= 70) {
    strengths.push('Profile data is reasonably complete');
  }

  return strengths.slice(0, 3);
};

const buildWeaknesses = (missingRequiredSkills, minExperience, estimatedYears, projectScore, credibilityScore) => {
  const weaknesses = [];

  if (missingRequiredSkills.length > 0) {
    weaknesses.push(`Missing ${missingRequiredSkills.length} required skills`);
  }

  if (minExperience > 0 && estimatedYears < minExperience) {
    weaknesses.push(`Below ${minExperience} years target`);
  }

  if (projectScore <= 25) {
    weaknesses.push('Limited project relevance shown');
  }

  if (credibilityScore <= 45) {
    weaknesses.push('Profile information is thin');
  }

  return weaknesses.slice(0, 3);
};

const buildLocalScreeningResult = (job, candidate, company) => {
  const requiredSkills = unique(toArray(job?.requiredSkills).map((skill) => skill?.trim()).filter(Boolean));
  const preferredSkills = unique(toArray(job?.preferredSkills).map((skill) => skill?.trim()).filter(Boolean));
  const minExperience = Number(job?.minExperience) || 0;
  const strictness = String(job?.rankingStrictness || 'balanced').toLowerCase();
  const { skills, experiences, projects, searchText, compactSet } = buildCandidateSignals(candidate);

  const matchedRequiredSkills = requiredSkills.filter((skill) => matchesTerm(skill, searchText, compactSet));
  const matchedPreferredSkills = preferredSkills.filter((skill) => matchesTerm(skill, searchText, compactSet));
  const missingRequiredSkills = requiredSkills.filter((skill) => !matchedRequiredSkills.includes(skill));

  const requiredRatio = requiredSkills.length > 0 ? matchedRequiredSkills.length / requiredSkills.length : 1;
  const preferredRatio = preferredSkills.length > 0 ? matchedPreferredSkills.length / preferredSkills.length : 0;
  const estimatedYears = estimateExperienceYears(candidate);

  let skillMatchScore = (requiredRatio * 80) + (preferredRatio * 20);
  if (strictness === 'strict' && requiredSkills.length > 0) {
    skillMatchScore -= ((requiredSkills.length - matchedRequiredSkills.length) / requiredSkills.length) * 18;
  }
  if (strictness === 'flexible') {
    skillMatchScore += Math.min(6, projects.length * 2);
  }
  skillMatchScore = clamp(skillMatchScore);

  let experienceScore;
  if (minExperience > 0) {
    experienceScore = Math.min(100, (estimatedYears / minExperience) * 75);
    if (estimatedYears >= minExperience) {
      experienceScore += 15;
    }
  } else {
    experienceScore = Math.min(100, 45 + (estimatedYears * 8));
  }
  if (experiences.length === 0 && estimatedYears === 0) {
    experienceScore = Math.min(experienceScore, 20);
  }
  experienceScore = clamp(experienceScore);

  const projectSearchText = buildSearchText(
    projects.flatMap((project) => [project.name, project.role, project.description, ...project.technologies])
  );
  const projectCompactSet = new Set(
    projects.flatMap((project) => [project.name, project.role, project.description, ...project.technologies])
      .map((value) => normalizeCompact(value))
      .filter(Boolean)
  );
  const jobKeywords = extractJobKeywords(job);
  const projectHits = jobKeywords.filter((keyword) => matchesTerm(keyword, projectSearchText, projectCompactSet)).length;
  let projectScore = jobKeywords.length > 0
    ? (projectHits / jobKeywords.length) * 100
    : (projects.length > 0 ? 70 : 35);
  if (projects.length === 0) {
    projectScore = Math.min(projectScore, 20);
  }
  projectScore = clamp(projectScore);

  const socialLinkCount = Object.values(candidate?.socialLinks || {}).filter(Boolean).length;
  const credibilityScore = clamp(
    (candidate?.email ? 12 : 0) +
    (candidate?.headline ? 10 : 0) +
    (candidate?.location ? 8 : 0) +
    Math.min(25, skills.length * 5) +
    Math.min(20, experiences.length * 10) +
    Math.min(10, projects.length * 5) +
    (toArray(candidate?.education).length > 0 ? 8 : 0) +
    (toArray(candidate?.certifications).length > 0 ? 7 : 0) +
    Math.min(10, socialLinkCount * 4)
  );

  const companyTechStack = unique(toArray(company?.techStack).map((technology) => technology?.trim()).filter(Boolean));
  const companyTechMatches = companyTechStack.filter((technology) => matchesTerm(technology, searchText, compactSet)).length;
  let companyFitScore = 45;
  if (companyTechStack.length > 0) {
    companyFitScore += (companyTechMatches / companyTechStack.length) * 25;
  }

  const hiringPhilosophy = String(company?.hiringPhilosophy || '').toLowerCase();
  if (hiringPhilosophy === 'startup-fast' && (projects.length >= 2 || experiences.length >= 2)) {
    companyFitScore += 12;
  }
  if (hiringPhilosophy === 'enterprise-structured' && (toArray(candidate?.education).length > 0 || toArray(candidate?.certifications).length > 0)) {
    companyFitScore += 12;
  }

  const availabilityType = normalizePhrase(candidate?.availability?.type || '');
  const employmentType = normalizePhrase(job?.employmentType || '');
  if (availabilityType && employmentType) {
    companyFitScore += availabilityType.includes(employmentType) || employmentType.includes(availabilityType) ? 10 : -8;
  }
  companyFitScore = clamp(companyFitScore);

  const weights = job?.scoringWeights || {};
  const totalWeight = (
    Number(weights.skillMatch) ||
    0
  ) + (
    Number(weights.experienceDepth) ||
    0
  ) + (
    Number(weights.projectRelevance) ||
    0
  ) + (
    Number(weights.credibility) ||
    0
  ) + (
    Number(weights.companyFit) ||
    0
  ) || 100;

  let overallScore = (
    (skillMatchScore * (Number(weights.skillMatch) || 30)) +
    (experienceScore * (Number(weights.experienceDepth) || 25)) +
    (projectScore * (Number(weights.projectRelevance) || 20)) +
    (credibilityScore * (Number(weights.credibility) || 15)) +
    (companyFitScore * (Number(weights.companyFit) || 10))
  ) / totalWeight;

  if (strictness === 'strict' && missingRequiredSkills.length > 0) {
    overallScore -= Math.min(20, missingRequiredSkills.length * 5);
  }
  if (strictness === 'flexible' && matchedPreferredSkills.length > 0) {
    overallScore += Math.min(5, matchedPreferredSkills.length * 1.5);
  }

  overallScore = clamp(overallScore);

  return {
    candidateId: candidate._id,
    overallScore: roundScore(overallScore),
    skillMatchScore: roundScore(skillMatchScore),
    experienceScore: roundScore(experienceScore),
    projectScore: roundScore(projectScore),
    credibilityScore: roundScore(credibilityScore),
    companyFitScore: roundScore(companyFitScore),
    strengths: buildStrengths(matchedRequiredSkills, requiredSkills.length, estimatedYears, minExperience, projectScore, credibilityScore),
    weaknesses: buildWeaknesses(missingRequiredSkills, minExperience, estimatedYears, projectScore, credibilityScore),
    recommendation: scoreRecommendation(overallScore),
    reasoning: buildReasoning(matchedRequiredSkills, requiredSkills.length, estimatedYears, projectScore, missingRequiredSkills),
    skillAnalysis: matchedRequiredSkills.length > 0 ? `Matched skills: ${matchedRequiredSkills.join(', ')}` : 'Matched skills: none',
    experienceAnalysis: estimatedYears > 0 ? `Estimated experience: ${estimatedYears} years` : 'Estimated experience: limited evidence',
    _localMeta: {
      estimatedYears,
      matchedRequiredSkills,
      matchedPreferredSkills,
      missingRequiredSkills,
      companyTechMatches,
      projectHits
    }
  };
};

const buildCandidateAISnapshot = (candidate, localResult) => {
  const skills = unique(getSkillEntries(candidate).map((skill) => skill.name)).slice(0, 10);
  const recentRoles = getExperienceEntries(candidate)
    .slice(0, 3)
    .map((experience) => compactText(`${experience.role} ${experience.company}`.trim(), 60))
    .filter(Boolean);
  const projectSignals = getProjectEntries(candidate)
    .slice(0, 2)
    .map((project) => compactText(
      [project.name, project.role, project.description, ...project.technologies].filter(Boolean).join(' | '),
      110
    ))
    .filter(Boolean);

  return {
    id: String(candidate._id),
    headline: compactText(candidate?.headline || '', 80),
    years: localResult?._localMeta?.estimatedYears || 0,
    localScore: roundScore(localResult?.overallScore || 0),
    matchedRequired: toArray(localResult?._localMeta?.matchedRequiredSkills).slice(0, 8),
    missingRequired: toArray(localResult?._localMeta?.missingRequiredSkills).slice(0, 5),
    skills,
    recentRoles,
    projectSignals,
    credibility: roundScore(localResult?.credibilityScore || 0)
  };
};

module.exports = {
  buildLocalScreeningResult,
  buildCandidateAISnapshot,
  compactText
};
