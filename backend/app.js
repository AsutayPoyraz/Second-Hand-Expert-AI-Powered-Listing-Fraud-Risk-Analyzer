'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');

const config = require('./config');
const logger = require('./utils/logger');
const { redactUrl } = require('./utils/redact');
const requestId = require('./middleware/requestId');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const analyzeRoutes = require('./routes/analyzeRoutes');
const systemRoutes = require('./routes/systemRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  app.use(requestId);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          manifestSrc: ["'self'"],
          workerSrc: ["'self'"]
        }
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
    })
  );

  app.use(
    pinoHttp({
      logger,
      genReqId: req => req.id,
      autoLogging: {
        ignore: req => req.url === '/api/health' || req.url.startsWith('/css/') || req.url.startsWith('/js/')
      },
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: redactUrl(req.url),
            remoteAddress: req.remoteAddress
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        }
      }
    })
  );

  // CORS: aynı origin her zaman serbest; ek origin'ler ALLOWED_ORIGINS ile.
  app.use(
    cors((req, callback) => {
      const origin = req.header('Origin');
      const host = req.get('host');
      const selfOrigins = host ? [`http://${host}`, `https://${host}`] : [];
      if (!origin || config.allowedOrigins.includes(origin) || selfOrigins.includes(origin)) {
        return callback(null, {
          origin: true,
          methods: ['GET', 'POST', 'PUT', 'DELETE'],
          allowedHeaders: ['Content-Type', 'x-client-id', 'x-job-token', 'x-request-id'],
          exposedHeaders: ['x-request-id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
          maxAge: 600
        });
      }
      const err = new Error(`CORS: izin verilmeyen origin (${origin})`);
      err.status = 403;
      err.code = 'CORS_FORBIDDEN';
      err.publicMessage = 'Bu origin için erişim izni yok.';
      return callback(err);
    })
  );

  app.use(
    compression({
      filter(req, res) {
        // SSE akışı sıkıştırılırsa tamponlanır ve ilerleme gecikir.
        if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
        return compression.filter(req, res);
      }
    })
  );

  app.use(express.json({ limit: config.bodyLimit }));

  // API yanıtları tarayıcı/kurumsal proxy önbelleğine düşmesin (iş sonuçları kişiye özel).
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  // API
  app.use('/api', systemRoutes);
  app.use('/api', settingsRoutes);
  app.use('/api', analyzeRoutes);

  // Statik frontend
  const frontendDir = path.join(__dirname, '..', 'frontend');
  app.use(
    express.static(frontendDir, {
      index: 'index.html',
      etag: true,
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    })
  );

  app.get('/', (req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });

  // API 404 (statik dosyalardan sonra)
  app.use('/api', notFoundHandler);

  // Diğer 404'ler
  app.use((req, res) => {
    res.status(404).sendFile(path.join(frontendDir, 'index.html'));
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
