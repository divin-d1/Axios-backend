const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendVerificationEmail, sendResetPasswordEmail } = require('../utils/emailService');

// Generate JWT Trigger
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'axios-secret-key-development', {
    expiresIn: '30d',
  });
};

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 */
exports.register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    const userExists = await User.findOne({ email });
    if (userExists) {
      if (!userExists.isVerified) {
        // Temp Hackathon Bypass: Auto-verify existing unverified user
        userExists.isVerified = true;
        userExists.password = password;
        await userExists.save();
        return res.status(200).json({
          message: 'Registration successful',
          token: generateToken(userExists._id),
          user: { id: userExists._id, fullName: userExists.fullName, email: userExists.email }
        });
      }
      return res.status(400).json({ error: 'User already exists and is verified' });
    }

    const otp = generateOTP();

    const user = await User.create({
      fullName: name,
      email,
      password,
      isVerified: true, // Temp Hackathon Bypass
      // verificationCode: otp,
      // verificationCodeExpires: Date.now() + 15 * 60 * 1000,
    });

    // Temp Hackathon Bypass: Skip email sending
    // const emailResult = await sendVerificationEmail(user.email, otp);
    // if (!emailResult.success) { ... }

    res.status(201).json({
      message: 'Registration successful',
      token: generateToken(user._id),
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Verify email with OTP
 * @route   POST /api/auth/verify-email
 */
exports.verifyEmail = async (req, res, next) => {
  try {
    const { email, code } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isVerified) return res.status(400).json({ error: 'User already verified' });

    if (user.verificationCode !== code || user.verificationCodeExpires < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    user.isVerified = true;
    user.verificationCode = undefined;
    user.verificationCodeExpires = undefined;
    await user.save();

    res.status(200).json({
      message: 'Email verified successfully',
      token: generateToken(user._id),
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    // Temp Hackathon Bypass: Skip email verification check
    // if (!user.isVerified) {
    //   return res.status(403).json({ error: 'Please verify your email to login' });
    // }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid email or password' });

    res.status(200).json({
      message: 'Login successful',
      token: generateToken(user._id),
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        companyId: user.company
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Request forgot password email
 * @route   POST /api/auth/forgot-password
 */
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (user) {
      const resetToken = generateOTP();
      user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
      user.resetPasswordExpires = Date.now() + 15 * 60 * 1000; // 15 mins
      await user.save();

      await sendResetPasswordEmail(user.email, resetToken);
    }

    res.status(200).json({ message: 'If an account exists, a reset code was sent' });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Reset password
 * @route   POST /api/auth/reset-password
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body;

    const hashedToken = crypto.createHash('sha256').update(code).digest('hex');

    const user = await User.findOne({
      email,
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset code' });
    }

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.status(200).json({ message: 'Password reset successful' });
  } catch (error) {
    next(error);
  }
};
