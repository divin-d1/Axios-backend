const express = require('express');
const router = express.Router();
const {
  triggerScreening,
  getScreeningResults,
  getScreeningResultDetail,
} = require('../controllers/screeningController');

router.post('/:jobId', triggerScreening);
router.get('/:jobId', getScreeningResults);
router.get('/result/:id', getScreeningResultDetail);

module.exports = router;
