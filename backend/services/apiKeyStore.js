'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const config = require('../config');
const logger = require('../utils/logger');

const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const KEY_MIN_LENGTH = 20;
const KEY_MAX_LENGTH = 400;
const KEY_PATTERN = /^[A-Za-z0-9._~-]+$/;
const STORE_VERSION = 1;

class ApiKeyStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApiKeyStoreError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Kullanıcıdan gelen anahtarı doğrular. Anahtar HTTP başlığında gönderildiği
 * için boşluk/kontrol karakteri kabul edilmez.
 */
function normalizeUserKey(raw) {
  if (typeof raw !== 'string') {
    throw new ApiKeyStoreError('INVALID_API_KEY_FORMAT', 'API anahtarı metin olarak gönderilmelidir.');
  }
  const key = raw.trim();
  if (!key) {
    throw new ApiKeyStoreError('INVALID_API_KEY_FORMAT', 'API anahtarı boş olamaz.');
  }
  if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH || !KEY_PATTERN.test(key)) {
    throw new ApiKeyStoreError(
      'INVALID_API_KEY_FORMAT',
      'API anahtarı geçersiz görünüyor. AIza… veya AQ.… ile başlayan anahtarı boşluksuz ve eksiksiz yapıştırın.'
    );
  }
  return key;
}

/** Ortam değişkeninden gelen anahtar için daha gevşek kontrol (test anahtarları kısa olabilir). */
function normalizeEnvKey(raw) {
  if (typeof raw !== 'string') return '';
  const key = raw.trim();
  if (!key || /[\r\n]/.test(key)) return '';
  return key;
}

function maskKey(key) {
  if (!key) return '';
  if (key.length < 12) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function readStoredKey(filePath, log = logger) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    const key = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    if (!key) return null;
    // Dosyadaki anahtar kullanıcı girdisiyle aynı kurallara uymalı.
    if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH || !KEY_PATTERN.test(key)) {
      log.warn({ storePath: filePath }, 'API anahtarı dosyasındaki anahtar geçersiz; yok sayıldı');
      return null;
    }
    return {
      apiKey: key,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn({ err: err.code || err.message, storePath: filePath }, 'API anahtarı dosyası okunamadı');
    }
    return null;
  }
}

async function writeAtomic(filePath, key) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  const updatedAt = new Date().toISOString();
  const payload = `${JSON.stringify({ version: STORE_VERSION, apiKey: key, updatedAt }, null, 2)}\n`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fsp.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    try {
      await fsp.rename(tmpPath, filePath);
    } catch (err) {
      // Windows'ta hedef dosya varsa rename EPERM/EEXIST verebilir.
      if (err.code === 'EEXIST' || err.code === 'EPERM') {
        await fsp.rm(filePath, { force: true });
        await fsp.rename(tmpPath, filePath);
      } else {
        throw err;
      }
    }
    await fsp.chmod(filePath, 0o600).catch(() => {});
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  return updatedAt;
}

/**
 * Anahtar deposu fabrikası. Testlerde geçici dosya ile bağımsız örnek
 * oluşturulabilir; uygulama tekil (singleton) örneği kullanır.
 */
function createApiKeyStore({ filePath, envKey = '', log = logger, timeoutMs = 10_000 } = {}) {
  if (!filePath) throw new Error('API anahtar deposu için dosya yolu gerekli.');

  const envApiKey = normalizeEnvKey(envKey);
  const initial = readStoredKey(filePath, log);
  let storedKey = initial ? initial.apiKey : '';
  let storedUpdatedAt = initial ? initial.updatedAt : null;
  let writeQueue = Promise.resolve();

  function activeKey() {
    return storedKey || envApiKey;
  }

  function enqueue(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  }

  function getStatus() {
    const key = activeKey();
    return {
      configured: Boolean(key),
      source: storedKey ? 'stored' : envApiKey ? 'env' : 'none',
      masked: maskKey(key),
      updatedAt: storedKey ? storedUpdatedAt : null,
      envFallback: Boolean(envApiKey),
      canDelete: Boolean(storedKey)
    };
  }

  function getApiKey() {
    return activeKey();
  }

  function setApiKey(raw) {
    const key = normalizeUserKey(raw);
    return enqueue(async () => {
      const updatedAt = await writeAtomic(filePath, key);
      storedKey = key;
      storedUpdatedAt = updatedAt;
      return getStatus();
    });
  }

  function clearApiKey() {
    return enqueue(async () => {
      try {
        await fsp.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw new ApiKeyStoreError(
            'API_KEY_STORE_DELETE_FAILED',
            'Kayıtlı API anahtarı silinemedi. Sunucu dosya izinlerini kontrol edin.',
            500
          );
        }
      }
      storedKey = '';
      storedUpdatedAt = null;
      return getStatus();
    });
  }

  /**
   * Anahtarı Gemini model listesi ucuyla doğrular. Sağlanan anahtar yalnızca
   * test edilir, kaydedilmez. Sonuçta anahtarın kendisi asla yer almaz.
   */
  async function testApiKey(rawKey) {
    let key;
    if (rawKey === undefined || rawKey === null || rawKey === '') {
      key = activeKey();
    } else {
      key = normalizeUserKey(rawKey);
    }

    if (!key) {
      return {
        valid: false,
        reason: 'MISSING_API_KEY',
        message: 'Sunucuda tanımlı bir Gemini API anahtarı yok. Önce anahtarı girin ve kaydedin.'
      };
    }

    let res;
    try {
      res = await fetch(`${GEMINI_MODELS_URL}?pageSize=1`, {
        method: 'GET',
        headers: { 'x-goog-api-key': key, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      return {
        valid: null,
        reason: 'UNREACHABLE',
        message: 'Gemini servisine ulaşılamadı. İnternet bağlantısını ve sunucu güvenlik duvarını kontrol edin.'
      };
    }

    if (res.ok) {
      return {
        valid: true,
        reason: 'OK',
        message: 'Anahtar geçerli; Gemini API erişimi başarılı.'
      };
    }

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return {
        valid: false,
        reason: 'INVALID_API_KEY',
        message: 'Anahtar geçersiz veya yetkisiz. Google AI Studio üzerinden yeni bir anahtar üretip tekrar deneyin.'
      };
    }

    if (res.status === 429) {
      return {
        valid: true,
        reason: 'QUOTA_LIMITED',
        message: 'Anahtar kabul edildi; ancak kota/limit nedeniyle şu an yanıt vermiyor. Analizlerde arama kotası devre dışı kalabilir.'
      };
    }

    return {
      valid: null,
      reason: 'UPSTREAM_ERROR',
      message: `Gemini servisi beklenmeyen bir yanıt verdi (HTTP ${res.status}). Anahtar kaydedilebilir; daha sonra tekrar test edin.`
    };
  }

  return {
    getApiKey,
    getStatus,
    setApiKey,
    clearApiKey,
    testApiKey
  };
}

const apiKeyStore = createApiKeyStore({
  filePath: config.apiKeyStorePath,
  envKey: config.apiKey
});

module.exports = apiKeyStore;
module.exports.createApiKeyStore = createApiKeyStore;
module.exports.maskKey = maskKey;
module.exports.normalizeUserKey = normalizeUserKey;
module.exports.ApiKeyStoreError = ApiKeyStoreError;
