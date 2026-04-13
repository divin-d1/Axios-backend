const nodemailer = require('nodemailer');

/**
 * Create email transporter from environment config
 */
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

/**
 * Send a single email
 * @param {Object} options - Email options
 * @returns {Promise<Object>} Send result
 */
const sendEmail = async ({ to, subject, html, text }) => {
  const transporter = createTransporter();
  
  const mailOptions = {
    from: `"${process.env.EMAIL_FROM_NAME || 'Axios Recruitment'}" <${process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text: text || subject,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`Email send error to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Send batch emails to multiple candidates
 * @param {Array} recipients - Array of { email, name, subject, html }
 * @returns {Promise<Object>} Batch results
 */
const sendBatchEmails = async (recipients) => {
  const results = {
    total: recipients.length,
    sent: 0,
    failed: 0,
    details: [],
  };

  // Process emails sequentially to avoid rate limiting
  for (const recipient of recipients) {
    const result = await sendEmail({
      to: recipient.email,
      subject: recipient.subject,
      html: recipient.html,
    });

    if (result.success) {
      results.sent++;
    } else {
      results.failed++;
    }

    results.details.push({
      email: recipient.email,
      name: recipient.name,
      ...result,
    });

    // Small delay between emails to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return results;
};

/**
 * Generate shortlist notification email HTML
 */
const generateShortlistEmail = ({ candidateName, jobTitle, companyName, rank, score, nextSteps }) => {
  return {
    subject: `Application Update: ${jobTitle} at ${companyName}`,
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">🎉 Congratulations!</h1>
        </div>
        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Dear <strong>${candidateName}</strong>,</p>
          <p style="color: #374151; font-size: 16px;">We are pleased to inform you that you have been <strong>shortlisted</strong> for the position of <strong>${jobTitle}</strong> at <strong>${companyName}</strong>.</p>
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 5px 0; color: #4b5563;"><strong>📊 Match Score:</strong> ${score}/100</p>
            <p style="margin: 5px 0; color: #4b5563;"><strong>🏆 Rank:</strong> #${rank}</p>
          </div>
          ${nextSteps ? `<p style="color: #374151; font-size: 16px;"><strong>Next Steps:</strong> ${nextSteps}</p>` : ''}
          <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">Best regards,<br><strong>${companyName} Recruitment Team</strong></p>
        </div>
        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 16px;">Powered by Axios AI Recruitment System</p>
      </div>
    `,
  };
};

/**
 * Generate acknowledgment email HTML
 */
const generateAcknowledgmentEmail = ({ candidateName, jobTitle, companyName }) => {
  return {
    subject: `Application Received: ${jobTitle} at ${companyName}`,
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Application Received ✅</h1>
        </div>
        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Dear <strong>${candidateName}</strong>,</p>
          <p style="color: #374151; font-size: 16px;">Thank you for applying for the <strong>${jobTitle}</strong> position at <strong>${companyName}</strong>. Your application has been received and is currently under review.</p>
          <p style="color: #374151; font-size: 16px;">We will be in touch regarding the next steps in the process.</p>
          <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">Best regards,<br><strong>${companyName} Recruitment Team</strong></p>
        </div>
        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 16px;">Powered by Axios AI Recruitment System</p>
      </div>
    `,
  };
};

module.exports = {
  sendEmail,
  sendBatchEmails,
  generateShortlistEmail,
  generateAcknowledgmentEmail,
};
