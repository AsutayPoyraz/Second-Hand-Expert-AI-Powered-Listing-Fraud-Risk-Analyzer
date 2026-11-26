'use strict';

const express = require('express');
const { apiLimiter, settingsLimiter } = require('../middleware/rateLimiter');
const {
  getApiKeyStatus,
  saveApiKey,
  deleteApiKey,
  testApiKey
} = require('../controllers/settingsController');

const router = express.Router();

router.get('/settings/api-key', apiLimiter, getApiKeyStatus);
router.put('/settings/api-key', settingsLimiter, saveApiKey);
router.delete('/settings/api-key', settingsLimiter, deleteApiKey);
router.post('/settings/api-key/test', settingsLimiter, testApiKey);

module.exports = router;
