'use strict';

const express = require('express');
const { analyzeLimiter, apiLimiter, listingLimiter, followupLimiter, globalAnalysisLimiter } = require('../middleware/rateLimiter');
const {
  startAnalyze,
  streamAnalyze,
  cancelAnalyze,
  getAnalyze,
  followupAnalyze,
  previewListing,
  getModels
} = require('../controllers/analyzeController');

const router = express.Router();

router.post('/listing/preview', apiLimiter, listingLimiter, previewListing);
router.post('/analyze', globalAnalysisLimiter, analyzeLimiter, startAnalyze);
router.get('/analyze/:jobId', apiLimiter, getAnalyze);
router.get('/analyze/:jobId/stream', apiLimiter, streamAnalyze);
router.post('/analyze/:jobId/followup', followupLimiter, followupAnalyze);
router.post('/analyze/:jobId/cancel', apiLimiter, cancelAnalyze);
router.get('/models', apiLimiter, getModels);

module.exports = router;
