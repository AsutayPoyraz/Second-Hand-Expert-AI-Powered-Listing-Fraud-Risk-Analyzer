'use strict';

const config = require('./config');
const logger = require('./utils/logger');
const { createApp } = require('./app');
const jobManager = require('./services/jobManager');
const apiKeyStore = require('./services/apiKeyStore');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.env,
      models: config.allowedModels,
      defaultModel: config.defaultModel,
      maxConcurrentAnalyses: config.maxConcurrentAnalyses
    },
    `İkinci El Eksper backend http://localhost:${config.port} adresinde çalışıyor`
  );
});

// Yavaş/askıda kalan bağlantılara karşı sunucu seviyesinde zaman aşımı.
server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = Math.min(60_000, config.requestTimeoutMs);
server.keepAliveTimeout = 65_000;

const keyStatus = apiKeyStore.getStatus();
if (!keyStatus.configured) {
  logger.warn(
    '[uyarı] Gemini API anahtarı tanımlı değil. Arayüzdeki "Gemini API anahtarı" kartından anahtar girip kaydedebilirsiniz.'
  );
} else {
  logger.info({ apiKeySource: keyStatus.source }, 'Gemini API anahtarı hazır');
}

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Sunucu kapatılıyor');

  jobManager.shutdown();

  server.close(err => {
    if (err) {
      logger.error({ err }, 'Sunucu kapatılırken hata');
      process.exitCode = 1;
    }
    logger.info('Sunucu kapandı');
    process.exit();
  });

  // Açık SSE bağlantıları varsa zorla çık.
  setTimeout(() => {
    logger.warn('Zorla kapatma zaman aşımı');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', reason => {
  logger.error({ err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason }, 'Yakalanmamış promise reddi');
});

process.on('uncaughtException', err => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'Yakalanmamış istisna');
  shutdown('uncaughtException');
});

module.exports = { server, app };
