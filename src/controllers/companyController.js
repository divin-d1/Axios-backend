const Company = require('../models/Company');

// @desc    Get user's own company only
// @route   GET /api/companies
const getCompanies = async (req, res, next) => {
  try {
    if (!req.user.company) {
      return res.json({ success: true, count: 0, data: [] });
    }
    const company = await Company.findById(req.user.company);
    res.json({ success: true, count: company ? 1 : 0, data: company ? [company] : [] });
  } catch (error) {
    next(error);
  }
};

// @desc    Get user's own company by ID (verify ownership)
// @route   GET /api/companies/:id
const getCompany = async (req, res, next) => {
  try {
    if (String(req.user.company) !== String(req.params.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const company = await Company.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json({ success: true, data: company });
  } catch (error) {
    next(error);
  }
};

// @desc    Update user's own company only
// @route   PUT /api/companies/:id
const updateCompany = async (req, res, next) => {
  try {
    if (String(req.user.company) !== String(req.params.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const company = await Company.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json({ success: true, data: company });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete user's own company only
// @route   DELETE /api/companies/:id
const deleteCompany = async (req, res, next) => {
  try {
    if (String(req.user.company) !== String(req.params.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const company = await Company.findByIdAndDelete(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

// createCompany is handled by /api/company/setup during onboarding
const createCompany = async (req, res, next) => {
  return res.status(403).json({ error: 'Use /api/company/setup during onboarding to create a company' });
};

module.exports = { createCompany, getCompanies, getCompany, updateCompany, deleteCompany };
