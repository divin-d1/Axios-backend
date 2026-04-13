const express = require('express');
const router = express.Router();
const { getConstants } = require('../controllers/configController');

router.get('/constants', getConstants);

module.exports = router;
