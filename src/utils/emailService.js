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
    connectionTimeout: 5000, 
    socketTimeout: 5000,     
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

/**
 * Generate and send Verification OTP email
 */
const sendVerificationEmail = async (to, otp) => {
  const html = `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 20px; text-align: center; background-color: #fafafa; border-radius: 16px;">
      <div style="background-color: #09090b; width: 48px; height: 48px; border-radius: 50%; margin: 0 auto 24px auto; display: flex; align-items: center; justify-content: center;">
        <h2 style="color: white; margin: 0; font-size: 20px; line-height: 48px;">A</h2>
      </div>
      <h1 style="color: #09090b; font-size: 24px; font-weight: 700; margin-bottom: 16px;">Verify your email</h1>
      <p style="color: #71717a; font-size: 15px; line-height: 1.5; margin-bottom: 32px;">
        You're almost in. We just need to verify your email address to complete your Axios account setup. Copy the security code below to proceed.
      </p>
      
      <div style="background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 24px; margin-bottom: 32px;">
        <p style="color: #09090b; font-size: 32px; font-weight: 800; letter-spacing: 8px; margin: 0;">${otp}</p>
      </div>
      
      <p style="color: #a1a1aa; font-size: 13px; line-height: 1.5;">
        This code will expire in 15 minutes. If you didn't request this email, you can safely ignore it.
      </p>
    </div>
  `;
  
  return sendEmail({
    to,
    subject: "Your Axios Verification Code",
    html,
  });
};

/**
 * Generate and send Reset Password email
 */
const sendResetPasswordEmail = async (to, resetCode) => {
  const html = `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 20px; text-align: center; background-color: #fafafa; border-radius: 16px;">
      <div style="background-color: #09090b; width: 48px; height: 48px; border-radius: 50%; margin: 0 auto 24px auto; display: flex; align-items: center; justify-content: center;">
        <h2 style="color: white; margin: 0; font-size: 20px; line-height: 48px;">A</h2>
      </div>
      <h1 style="color: #09090b; font-size: 24px; font-weight: 700; margin-bottom: 16px;">Reset Password</h1>
      <p style="color: #71717a; font-size: 15px; line-height: 1.5; margin-bottom: 32px;">
        We received a request to reset your password. Use the security code below to set up a new password for your Axios account.
      </p>
      
      <div style="background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 24px; margin-bottom: 32px;">
        <p style="color: #09090b; font-size: 32px; font-weight: 800; letter-spacing: 8px; margin: 0;">${resetCode}</p>
      </div>
      
      <p style="color: #a1a1aa; font-size: 13px; line-height: 1.5;">
        This code will expire in 15 minutes. If you didn't request a password reset, you can safely ignore it.
      </p>
    </div>
  `;
  
  return sendEmail({
    to,
    subject: "Reset your Axios Password",
    html,
  });
};

module.exports = {
  sendEmail,
  sendBatchEmails,
  generateShortlistEmail,
  generateAcknowledgmentEmail,
  sendVerificationEmail,
  sendResetPasswordEmail,
};
