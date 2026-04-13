const express = require('express');
const router = express.Router();
const {
  sendShortlistEmails,
  sendCustomEmails,
  previewEmail,
} = require('../controllers/emailController');

router.post('/shortlist/:jobId', sendShortlistEmails);
router.post('/custom', sendCustomEmails);
router.post('/preview', previewEmail);

module.exports = router;
