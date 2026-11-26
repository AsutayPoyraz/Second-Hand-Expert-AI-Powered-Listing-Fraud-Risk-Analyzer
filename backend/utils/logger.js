'use strict';

const pino = require('pino');
const config = require('../config');

/**
 * Yapılandırılmış log. Üretimde JSON, geliştirmede okunabilir çıktı.
 * Gizli alanlar redact ile maskelenir (API anahtarı, istemci kimliği).
 */
const logger = pino({
  level: config.logLevel,
  base: { service: 'ikinci-el-eksper' },
  redact: {
    paths: [
      'req.headers["x-goog-api-key"]',
      'req.headers["x-client-id"]',
      'req.headers["x-job-token"]',
      'req.headers.authorization',
      'apiKey',
      '*.apiKey',
      'accessToken',
      '*.accessToken',
      'token'
    ],
    censor: '[GİZLİ]'
  },
  transport: config.isProduction
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 }
      }
});

module.exports = logger;
