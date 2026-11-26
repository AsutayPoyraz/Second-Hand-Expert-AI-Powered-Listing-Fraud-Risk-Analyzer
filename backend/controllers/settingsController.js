'use strict';

const apiKeyStore = require('../services/apiKeyStore');
const { invalidateModelCache } = require('../services/geminiService');
const { ApiKeyStoreError } = apiKeyStore;
const logger = require('../utils/logger');

/** İstemciye yalnızca maskeli durum döner; anahtarın kendisi asla gönderilmez. */
function publicStatus() {
  return apiKeyStore.getStatus();
}

function errorResponse(res, err) {
  if (err instanceof ApiKeyStoreError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  return null;
}

/** GET /api/settings/api-key */
function getApiKeyStatus(req, res) {
  res.json(publicStatus());
}

/** PUT /api/settings/api-key — gövde: { apiKey } */
async function saveApiKey(req, res) {
  try {
    const status = await apiKeyStore.setApiKey(req.body && req.body.apiKey);
    invalidateModelCache();
    logger.info({ source: status.source }, 'Gemini API anahtarı güncellendi');
    return res.json({ ok: true, ...status });
  } catch (err) {
    if (errorResponse(res, err)) return;
    logger.error(
      { err: { code: err.code, message: err.message } },
      'Gemini API anahtarı kaydedilemedi'
    );
    return res.status(500).json({
      error:
        'API anahtarı kaydedilemedi. Sunucunun veri dizinine yazma izni olduğundan emin olun (Docker kullanıyorsanız data volume tanımlayın).',
      code: 'API_KEY_STORE_WRITE_FAILED'
    });
  }
}

/** DELETE /api/settings/api-key — yalnızca sistemde kayıtlı anahtarı siler. */
async function deleteApiKey(req, res) {
  try {
    const status = await apiKeyStore.clearApiKey();
    invalidateModelCache();
    logger.info({ source: status.source }, 'Kayıtlı Gemini API anahtarı silindi');
    return res.json({ ok: true, ...status });
  } catch (err) {
    if (errorResponse(res, err)) return;
    logger.error(
      { err: { code: err.code, message: err.message } },
      'Kayıtlı Gemini API anahtarı silinemedi'
    );
    return res.status(500).json({
      error: 'Kayıtlı API anahtarı silinemedi. Sunucu dosya izinlerini kontrol edin.',
      code: 'API_KEY_STORE_DELETE_FAILED'
    });
  }
}

/**
 * POST /api/settings/api-key/test — gövde: { apiKey? }
 * Gövdede anahtar varsa yalnızca test edilir ve kaydedilmez. Yoksa etkin
 * (kayıtlı veya .env) anahtar test edilir.
 */
async function testApiKey(req, res) {
  try {
    const candidate = req.body && typeof req.body.apiKey === 'string' ? req.body.apiKey : undefined;
    const result = await apiKeyStore.testApiKey(candidate);
    logger.info({ valid: result.valid, reason: result.reason }, 'Gemini API anahtarı test edildi');
    return res.json(result);
  } catch (err) {
    if (errorResponse(res, err)) return;
    logger.error(
      { err: { code: err.code, message: err.message } },
      'Gemini API anahtarı test edilemedi'
    );
    return res.status(500).json({
      error: 'API anahtarı test edilemedi. Lütfen tekrar deneyin.',
      code: 'API_KEY_TEST_FAILED'
    });
  }
}

module.exports = {
  getApiKeyStatus,
  saveApiKey,
  deleteApiKey,
  testApiKey
};
