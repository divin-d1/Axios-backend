const express = require('express');
const router = express.Router();
const { uploadResume, uploadSpreadsheet } = require('../middlewares/upload');
const {
  addCandidate,
  bulkUploadCandidates,
  uploadResume: parseResumePDF,
  getCandidatesByJob,
  getAllCandidates,
  getCandidate,
  deleteCandidate,
} = require('../controllers/candidateController');

// Global candidates
router.route('/')
  .get(getAllCandidates)
  .post(addCandidate);

// Job specific
router.route('/job/:jobId')
  .get(getCandidatesByJob);

router.post('/upload/:jobId', uploadSpreadsheet, bulkUploadCandidates);
router.post('/resume/:jobId', uploadResume, parseResumePDF);

// Single candidate operations
router.route('/:id')
  .get(getCandidate)
  .delete(deleteCandidate);

module.exports = router;
