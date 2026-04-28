const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const mongoose = require('mongoose');
const Company = require('../models/Company');
const User = require('../models/User');

/**
 * @desc    Onboarding company setup - creates company and links to user
 * @route   POST /api/company/setup
 */
router.post('/setup', protect, async (req, res, next) => {
  try {
    const existingUser = await User.findById(req.user._id).select('company');
    if (existingUser?.company) {
      return res.status(409).json({ error: 'Onboarding already completed for this account' });
    }

    const { name, email, website, size, industries, departments, hiringPhilosophy, description, specialization, skills } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Create company
      const company = await Company.create([{
        name,
        email: email || req.user.email,
        website,
        size,
        industries: industries || [],
        departments: departments || [],
        hiringPhilosophy,
        description,
        specialization,
        skills: typeof skills === 'string' ? skills.split(',').map(s => s.trim()).filter(Boolean) : (skills || []),
      }], { session });

      // Link company to user
      req.user.company = company[0]._id;
      await req.user.save({ session });
      
      await session.commitTransaction();
      session.endSession();

      res.status(201).json({
        success: true,
        message: 'Company profile created and linked to your account',
        company: company[0],
      });
    } catch (transactionError) {
      await session.abortTransaction();
      session.endSession();
      throw transactionError;
    }
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get current user profile (for onboarding check)
 * @route   GET /api/company/me
 */
router.get('/me', protect, async (req, res) => {
  const user = await User.findById(req.user._id).populate('company');
  res.json({
    success: true,
    user: {
      id: user._id,
      fullName: user.fullName,
      email: user.email,
      company: user.company || null,
    }
  });
});

module.exports = router;
