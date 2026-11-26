'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const {
  validateAnalyzeRequest,
  validateQuestion,
  validateUrl,
  normalizeClientId,
  getAllowedModels
} = require('../utils/validation');
const jobManager = require('../services/jobManager');
const listingFetcher = require('../services/listingFetcher');
const apiKeyStore = require('../services/apiKeyStore');
const { listAvailableModels, runFollowup, isUserAbort } = require('../services/geminiService');

/**
 * POST /api/analyze
 * Gövde: { category, name, price, desc?, url?, year?, km?, model?, images: [{mimeType, data}] }
 * Yanıt: 202 { jobId, token, streamUrl }
 */
function startAnalyze(req, res, next) {
  try {
    const clientId = normalizeClientId(req.get('x-client-id'));
    if (!clientId) {
      return res.status(400).json({
        error: 'Geçersiz veya eksik x-client-id başlığı.',
        code: 'INVALID_CLIENT_ID'
      });
    }

    const { valid, errors, value } = validateAnalyzeRequest(req.body);
    if (!valid) {
      return res.status(400).json({
        error: errors.map(e => e.message).join(' '),
        code: 'VALIDATION_ERROR',
        fields: errors
      });
    }

    const apiKey = apiKeyStore.getApiKey();
    if (!apiKey) {
      return res.status(503).json({
        error:
          'Sunucuda Gemini API anahtarı tanımlı değil. Arayüzdeki "Gemini API anahtarı" kartından anahtarınızı girip kaydedin.',
        code: 'MISSING_API_KEY'
      });
    }

    if (jobManager.isQueueFull()) {
      return res.status(503).json({
        error: 'Sunucu şu anda yoğun. Lütfen birkaç dakika sonra tekrar deneyin.',
        code: 'QUEUE_FULL'
      });
    }

    const job = jobManager.createJob({
      clientId,
      params: {
        apiKey,
        model: value.model,
        category: value.category,
        name: value.name,
        price: value.price,
        year: value.year,
        km: value.km,
        url: value.url,
        desc: value.desc,
        images: value.images
      }
    });

    logger.info(
      { jobId: job.id, category: value.category, model: value.model, imageCount: value.images.length },
      'Analiz işi oluşturuldu'
    );

    return res.status(202).json({
      jobId: job.id,
      token: job.accessToken,
      streamUrl: `/api/analyze/${job.id}/stream?token=${job.accessToken}`
    });
  } catch (err) {
    return next(err);
  }
}

function extractToken(req) {
  const header = req.get('x-job-token');
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (typeof req.query.token === 'string' && req.query.token.trim()) return req.query.token.trim();
  if (req.body && typeof req.body.token === 'string' && req.body.token.trim()) return req.body.token.trim();
  return '';
}

function loadAuthorizedJob(req, res) {
  const job = jobManager.getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Analiz işi bulunamadı veya süresi doldu.', code: 'JOB_NOT_FOUND' });
    return null;
  }
  if (!jobManager.tokenMatches(job, extractToken(req))) {
    res.status(403).json({ error: 'Bu analiz işine erişim yetkiniz yok.', code: 'JOB_FORBIDDEN' });
    return null;
  }
  return job;
}

/** GET /api/analyze/:jobId — SSE desteklenmeyen istemciler için polling. */
function getAnalyze(req, res) {
  const job = loadAuthorizedJob(req, res);
  if (!job) return;
  res.json({ ...jobManager.publicJob(job), followups: jobManager.publicFollowups(job) });
}

/** GET /api/analyze/:jobId/stream — Server-Sent Events. */
function streamAnalyze(req, res) {
  const job = loadAuthorizedJob(req, res);
  if (!job) return;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const unsubscribe = jobManager.subscribe(job, res);

  // İş bittiyse akışı kapat (olaylar replay edildi).
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    unsubscribe();
    res.end();
    return;
  }

  const cleanup = () => {
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
}

/** POST /api/analyze/:jobId/cancel */
function cancelAnalyze(req, res) {
  const job = loadAuthorizedJob(req, res);
  if (!job) return;

  const cancelled = jobManager.cancelJob(job.id, 'Kullanıcı isteğiyle iptal edildi.');
  res.json({ cancelled, status: jobManager.publicJob(job).status });
}

/**
 * POST /api/analyze/:jobId/followup
 * Gövde: { question }
 * Tamamlanmış rapora takip sorusu sorar; kısa cevap + güncellenmiş rapor döner.
 */
async function followupAnalyze(req, res) {
  const job = loadAuthorizedJob(req, res);
  if (!job) return;

  if (job.status !== 'done' || !job.result || !job.result.report) {
    return res.status(409).json({
      error: 'Analiz henüz tamamlanmadı; takip sorusu gönderilemez.',
      code: 'JOB_NOT_DONE'
    });
  }

  const apiKey = apiKeyStore.getApiKey();
  if (!apiKey) {
    return res.status(503).json({
      error:
        'Sunucuda Gemini API anahtarı tanımlı değil. Arayüzdeki "Gemini API anahtarı" kartından anahtarınızı girip kaydedin.',
      code: 'MISSING_API_KEY'
    });
  }

  // Doğrulama limit/kilit kontrolünden önce: geçersiz istekler kota veya kilit tüketmesin.
  const q = validateQuestion(req.body && req.body.question);
  if (!q.ok) {
    return res.status(400).json({
      error: q.error,
      code: 'VALIDATION_ERROR',
      fields: [{ field: 'question', message: q.error }]
    });
  }

  if (job.followupInFlight) {
    return res.status(409).json({
      error: 'Önceki soru hâlâ yanıtlanıyor; lütfen yanıt geldikten sonra tekrar sorun.',
      code: 'FOLLOWUP_BUSY'
    });
  }

  if (job.followups.length >= config.maxFollowupsPerJob) {
    return res.status(429).json({
      error: `Bu analiz için en fazla ${config.maxFollowupsPerJob} takip sorusu sorabilirsiniz. Yeni bir analiz başlatın.`,
      code: 'FOLLOWUP_LIMIT'
    });
  }

  job.followupInFlight = true;

  // İstemci bağlantıyı kapatırsa veya toplam süre aşılırsa Gemini çağrısını iptal et.
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.followupTimeoutMs);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  try {
    const out = await runFollowup({
      apiKey,
      model: job.params.model,
      category: job.params.category,
      name: job.params.name,
      price: job.params.price,
      year: job.params.year,
      km: job.params.km,
      url: job.params.url,
      desc: job.params.desc,
      images: job.params.images,
      photoCount: job.result.photoCount,
      previousReport: job.result.report,
      searchPerformed: Boolean(job.result.searchPerformed),
      history: job.followups,
      question: q.value,
      signal: controller.signal
    });

    const updated = Boolean(out.updated && out.report);
    if (updated) job.result.report = out.report;

    const entry = {
      question: q.value,
      answer: out.answer,
      updated,
      createdAt: Date.now(),
      usage: out.usage || null
    };
    job.followups.push(entry);
    job.result.followupCount = job.followups.length;

    // Başarılı soru işi canlı tutar: hemen ardından TTL dolup 404 vermesin.
    jobManager.touchJob(job.id);

    logger.info(
      { jobId: job.id, followupCount: job.followups.length, updated, imagesSent: out.imagesSent },
      'Takip sorusu yanıtlandı'
    );

    return res.json({
      answer: out.answer,
      updated,
      report: job.result.report,
      sources: job.result.sources || [],
      queries: job.result.queries || [],
      searchPerformed: Boolean(job.result.searchPerformed),
      followupCount: job.followups.length,
      maxFollowups: config.maxFollowupsPerJob,
      createdAt: entry.createdAt
    });
  } catch (err) {
    if (isUserAbort(err)) {
      if (timedOut && !res.headersSent && !res.writableEnded) {
        return res.status(504).json({
          error: 'Takip sorusu zaman aşımına uğradı. Lütfen tekrar deneyin.',
          code: 'FOLLOWUP_TIMEOUT'
        });
      }
      // İstemci bağlantıyı kapattı; yazacak kimse yok.
      return;
    }

    logger.error(
      { err: { message: err.message, code: err.code }, jobId: job.id },
      'Takip sorusu yanıtlanamadı'
    );
    if (res.headersSent || res.writableEnded) return;

    // İç zaman aşımı (Gemini) veya dış deadline aynı kullanıcı koduna eşlenir.
    if (timedOut || err.code === 'TIMEOUT' || err.code === 'FOLLOWUP_TIMEOUT') {
      return res.status(504).json({
        error: 'Takip sorusu zaman aşımına uğradı. Lütfen tekrar deneyin.',
        code: 'FOLLOWUP_TIMEOUT'
      });
    }

    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({
      error: err.message || 'Takip sorusu yanıtlanamadı. Lütfen tekrar deneyin.',
      code: err.code || 'FOLLOWUP_FAILED'
    });
  } finally {
    clearTimeout(timeout);
    res.removeListener('close', onClose);
    job.followupInFlight = false;
  }
}

/**
 * POST /api/listing/preview
 * Gövde: { url }
 * İlan sayfasını sunucu tarafında bir kez tarar; başlık, açıklama, fiyat ve
 * indirilebilen fotoğrafları (base64) döndürür. Gemini anahtarı gerekmez.
 */
async function previewListing(req, res, next) {
  try {
    const checked = validateUrl(req.body && req.body.url);
    if (!checked.ok || !checked.value) {
      return res.status(400).json({
        error: checked.error || 'Geçerli bir ilan linki girin.',
        code: 'VALIDATION_ERROR',
        fields: [{ field: 'url', message: checked.error || 'Geçerli bir ilan linki girin.' }]
      });
    }

    const preview = await listingFetcher.fetchListingPreview(checked.value);

    logger.info(
      {
        host: preview.sourceHost,
        imageCount: preview.images.length,
        warningCount: preview.warnings.length
      },
      'İlan linki tarandı'
    );

    return res.json(preview);
  } catch (err) {
    if (err instanceof listingFetcher.ListingError) {
      logger.warn({ code: err.code, status: err.status }, 'İlan linki taranamadı');
      return res.status(err.status || 502).json({
        error: err.publicMessage || err.message,
        code: err.code
      });
    }
    return next(err);
  }
}

/** GET /api/models — izinli ve (mümkünse) hesapta gerçekten var olan modeller. */
async function getModels(req, res) {
  const allowed = getAllowedModels();
  const available = await listAvailableModels(apiKeyStore.getApiKey());
  const models = available ? allowed.filter(m => available.includes(m)) : allowed;
  res.json({
    models: models.length > 0 ? models : allowed,
    default: (models.includes(config.defaultModel) ? config.defaultModel : models[0]) || allowed[0],
    source: available ? 'dynamic' : 'config'
  });
}

module.exports = {
  startAnalyze,
  streamAnalyze,
  cancelAnalyze,
  getAnalyze,
  followupAnalyze,
  previewListing,
  getModels
};
