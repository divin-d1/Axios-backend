const Candidate = require('../models/Candidate');
const ScreeningResult = require('../models/ScreeningResult');
const Job = require('../models/Job');
const Company = require('../models/Company');
const { sendBatchEmails, generateShortlistEmail, generateAcknowledgmentEmail } = require('../utils/emailService');

// @desc    Send emails to shortlisted candidates
// @route   POST /api/emails/shortlist/:jobId
const sendShortlistEmails = async (req, res, next) => {
  try {
    const { nextSteps, candidateIds } = req.body;
    const jobId = req.params.jobId;

    const job = await Job.findById(jobId).populate('company');
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Verify job belongs to user's company
    if (String(job.company._id || job.company) !== String(req.user.company)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get shortlisted results
    const filter = { job: jobId, isShortlisted: true };
    if (candidateIds && candidateIds.length > 0) {
      filter.candidate = { $in: candidateIds };
    }

    const results = await ScreeningResult.find(filter).populate('candidate', 'name email');

    if (results.length === 0) {
      res.status(400);
      throw new Error('No shortlisted candidates found');
    }

    // Build email list
    const recipients = results
      .filter(r => r.candidate && r.candidate.email)
      .map(r => {
        const emailContent = generateShortlistEmail({
          candidateName: r.candidate.name,
          jobTitle: job.title,
          companyName: job.company.name,
          rank: r.rank,
          score: r.overallScore,
          nextSteps: nextSteps || 'We will contact you shortly with further details about the next steps.',
        });
        return {
          email: r.candidate.email,
          name: r.candidate.name,
          ...emailContent,
        };
      });

    if (recipients.length === 0) {
      res.status(400);
      throw new Error('No valid email addresses found for shortlisted candidates');
    }

    const emailResults = await sendBatchEmails(recipients);

    // Mark candidates as emailed
    for (const detail of emailResults.details) {
      if (detail.success) {
        await Candidate.updateOne(
          { email: detail.email, job: jobId },
          { emailSent: true, emailSentAt: new Date() }
        );
      }
    }

    res.json({
      success: true,
      message: `Emails sent: ${emailResults.sent}/${emailResults.total}`,
      data: emailResults,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Send custom email to specific candidates
// @route   POST /api/emails/custom
const sendCustomEmails = async (req, res, next) => {
  try {
    const { candidateIds, subject, htmlContent } = req.body;

    if (!candidateIds || !candidateIds.length || !subject || !htmlContent) {
      res.status(400);
      throw new Error('candidateIds, subject, and htmlContent are required');
    }

    const candidates = await Candidate.find({ _id: { $in: candidateIds } });
    
    const recipients = candidates
      .filter(c => c.email)
      .map(c => ({
        email: c.email,
        name: c.name,
        subject,
        html: htmlContent.replace(/\{\{name\}\}/g, c.name),
      }));

    const emailResults = await sendBatchEmails(recipients);

    res.json({
      success: true,
      message: `Emails sent: ${emailResults.sent}/${emailResults.total}`,
      data: emailResults,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Preview email template
// @route   POST /api/emails/preview
const previewEmail = async (req, res, next) => {
  try {
    const { type, jobId } = req.body;
    const job = await Job.findById(jobId).populate('company');
    
    if (!job) {
      res.status(404);
      throw new Error('Job not found');
    }

    let emailContent;
    if (type === 'shortlist') {
      emailContent = generateShortlistEmail({
        candidateName: 'John Doe',
        jobTitle: job.title,
        companyName: job.company.name,
        rank: 1,
        score: 92,
        nextSteps: 'We will schedule an interview with you soon.',
      });
    } else {
      emailContent = generateAcknowledgmentEmail({
        candidateName: 'John Doe',
        jobTitle: job.title,
        companyName: job.company.name,
      });
    }

    res.json({ success: true, data: emailContent });
  } catch (error) {
    next(error);
  }
};

module.exports = { sendShortlistEmails, sendCustomEmails, previewEmail };
