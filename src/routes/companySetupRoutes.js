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

    const { name, email, website, size, industries, industry, departments, hiringPhilosophy, description, specialization, skills, techStack } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    // Resolve tech stack from either 'techStack' or legacy 'skills' field
    const resolvedTechStack = (() => {
      const raw = techStack || skills;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
      if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
      return [];
    })();

    // Resolve industry from either 'industry' or 'industries' field
    const resolvedIndustry = (() => {
      const raw = industry || industries;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
      if (typeof raw === 'string') return [raw.trim()].filter(Boolean);
      return [];
    })();

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Create company
      const company = await Company.create([{
        name,
        email: email || req.user.email,
        website,
        size,
        industry: resolvedIndustry,
        departments: departments || [],
        hiringPhilosophy,
        description,
        specialization,
        techStack: resolvedTechStack,
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
