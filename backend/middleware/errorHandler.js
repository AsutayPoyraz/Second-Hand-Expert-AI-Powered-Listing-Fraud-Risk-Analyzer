'use strict';

const logger = require('../utils/logger');
const { redactUrl, redactText } = require('../utils/redact');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Bulunamadı.', code: 'NOT_FOUND' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Gövde çok büyük (express.json limiti)
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      error: 'Gönderilen veri çok büyük. Fotoğraf sayısını/boyutunu azaltın.',
      code: 'PAYLOAD_TOO_LARGE'
    });
  }

  // Bozuk JSON gövdesi
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'İstek gövdesi geçerli JSON değil.', code: 'INVALID_JSON' });
  }

  const status = Number.isInteger(err && err.status) ? err.status : 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const code = (err && err.code) || (safeStatus === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
  const message =
    (err && err.publicMessage) ||
    (safeStatus === 403
      ? 'Bu kaynağa erişim izniniz yok.'
      : safeStatus < 500
        ? 'İstek geçersiz.'
        : 'Sunucuda beklenmeyen bir hata oluştu.');

  // Yığın izi yalnızca sunucu loguna; istemciye asla gitmez.
  logger.error(
    {
      err: {
        message: redactText(err && err.message),
        stack: redactText(err && err.stack),
        code
      },
      status: safeStatus,
      method: req.method,
      url: redactUrl(req.originalUrl),
      requestId: req.id
    },
    'istek hatası'
  );

  if (res.headersSent) return;
  res.status(safeStatus).json({ error: message, code, requestId: req.id });
}

module.exports = { notFoundHandler, errorHandler };
