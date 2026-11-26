'use strict';

const express = require('express');
const config = require('../config');
const apiKeyStore = require('../services/apiKeyStore');

const router = express.Router();
const startedAt = Date.now();

// Liveness: süreç ayakta mı? (yük dengeleyici için)
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000)
  });
});

// Readiness: trafiğe hazır mı? (anahtar yoksa analiz çalışmaz)
router.get('/ready', (req, res) => {
  const status = apiKeyStore.getStatus();
  const ready = status.configured;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    hasApiKey: ready,
    apiKeySource: status.source,
    models: config.allowedModels,
    defaultModel: config.defaultModel
  });
});

module.exports = router;
