'use strict';

const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { runAnalysis, isUserAbort } = require('./geminiService');

/**
 * Bellek-içi iş (job) yöneticisi.
 * - İşler istemci kimliğine bağlıdır; aynı istemci yeni analiz başlatınca önceki iptal edilir.
 * - İş erişimi rastgele bir token ile korunur (jobId tahmin edilse bile okunamaz/iptal edilemez).
 * - SSE abonelerine geçmiş olaylar replay edilir (geç bağlanan istemci sonucu kaçırmaz).
 * - 15 sn heartbeat ile proxy zaman aşımına karşı bağlantı canlı tutulur.
 * - Eşzamanlı Gemini çağrısı MAX_CONCURRENT_ANALYSES ile sınırlanır, fazlası kuyruğa girer.
 *
 * Çok sunuculu dağıtım için bu katman Redis pub/sub ile değiştirilmelidir.
 */

const JOBS = new Map();
const ACTIVE_BY_CLIENT = new Map();
const QUEUE = [];

const MAX_HEARTBEAT_MS = 15_000;

let running = 0;

function jobImageBytes(job) {
  const images = job && job.params && Array.isArray(job.params.images) ? job.params.images : [];
  return images.reduce((sum, im) => sum + (im && typeof im.data === 'string' ? im.data.length : 0), 0);
}

/** Takip için tutulacak fotoğrafları sınırlar: adet + foto başına base64 boyutu. */
function trimJobImages(job) {
  if (!job || !job.params) return 0;
  if (!Array.isArray(job.params.images)) {
    job.params.images = [];
    return 0;
  }
  job.params.images = job.params.images
    .filter(
      im =>
        im &&
        typeof im.data === 'string' &&
        im.data.length > 0 &&
        im.data.length <= config.followupImageMaxBytes
    )
    .slice(0, config.followupImageLimit);
  return jobImageBytes(job);
}

/**
 * Bellekte tutulan toplam görsel bütçesini aşınca en eski bitmiş işlerin
 * görsellerini boşaltır. Uçuştaki takip sorusunun görselleri korunur.
 */
function enforceImageBudget() {
  let total = 0;
  for (const job of JOBS.values()) total += jobImageBytes(job);
  if (total <= config.retainedImageBudgetBytes) return;

  const candidates = [...JOBS.values()]
    .filter(
      j =>
        (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') &&
        !j.followupInFlight
    )
    .sort((a, b) => (a.finishedAt || a.createdAt) - (b.finishedAt || b.createdAt));

  for (const job of candidates) {
    if (total <= config.retainedImageBudgetBytes) break;
    const freed = jobImageBytes(job);
    if (freed === 0) continue;
    job.params.images = [];
    total -= freed;
  }
}

function retainedImageBytes() {
  let total = 0;
  for (const job of JOBS.values()) total += jobImageBytes(job);
  return total;
}

function record(job, payload) {
  job.events.push(payload);
  broadcast(job, payload);
}

function broadcast(job, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.listeners.keys()) {
    if (res.writableEnded) continue;
    try {
      res.write(data);
    } catch {
      /* bağlantı kapanmış olabilir */
    }
  }
}

function closeAll(job) {
  for (const [res, heartbeat] of job.listeners) {
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* yut */
    }
  }
  job.listeners.clear();
}

function finish(job, status, payload) {
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return;

  job.status = status;
  job.finishedAt = Date.now();
  job.stage = status === 'done' ? 'done' : job.stage;

  // Analiz bittiğinde tüm fotoğrafları bellekte tutmak OOM riskidir. Takip için
  // yalnızca birkaç küçük fotoğraf saklanır; hata/iptalde hiçbiri tutulmaz.
  if (status === 'done') trimJobImages(job);
  else if (job.params && Array.isArray(job.params.images)) job.params.images = [];
  enforceImageBudget();

  if (status === 'error') job.error = payload.error;
  if (ACTIVE_BY_CLIENT.get(job.clientId) === job.id) ACTIVE_BY_CLIENT.delete(job.clientId);

  record(job, payload);
  closeAll(job);
}

function startJob(job) {
  running += 1;
  job.status = 'running';

  job.timer = setTimeout(() => {
    job.cancelReason = 'İşlem zaman aşımına uğradı.';
    job.controller.abort();
  }, config.jobTimeoutMs);

  const onProgress = stage => {
    if (job.status !== 'running') return;
    job.stage = stage;
    record(job, { type: 'stage', stage });
  };

  runAnalysis({ ...job.params, signal: job.controller.signal, onProgress })
    .then(result => {
      job.result = result;
      logger.info(
        { jobId: job.id, model: result.model, usage: result.usage, searchPerformed: result.searchPerformed },
        'Analiz tamamlandı'
      );
      finish(job, 'done', { type: 'done', result, maxFollowups: config.maxFollowupsPerJob });
    })
    .catch(err => {
      if (isUserAbort(err)) {
        finish(job, 'cancelled', { type: 'cancelled', reason: job.cancelReason || null });
      } else {
        logger.error({ err: { message: err.message, code: err.code, stack: err.stack }, jobId: job.id }, 'Analiz başarısız');
        finish(job, 'error', {
          type: 'error',
          error: {
            message: err.message || 'Bilinmeyen hata oluştu.',
            code: err.code || 'INTERNAL_ERROR'
          }
        });
      }
    })
    .finally(() => {
      clearTimeout(job.timer);
      job.timer = null;
      running -= 1;
      drain();
    });
}

function drain() {
  while (running < config.maxConcurrentAnalyses && QUEUE.length > 0) {
    const job = QUEUE.shift();
    if (!job || job.status !== 'pending' || job.controller.signal.aborted) continue;
    startJob(job);
  }
}

/** İşi ve istemci eşleşmesini temizler. Uçuştaki takip sorusu olan iş silinmez. */
function deleteJob(id) {
  const job = JOBS.get(id);
  if (!job) return false;
  if (job.followupInFlight) return false;
  JOBS.delete(id);
  if (ACTIVE_BY_CLIENT.get(job.clientId) === id) ACTIVE_BY_CLIENT.delete(job.clientId);
  return true;
}

function evictOldestFinished() {
  if (JOBS.size <= config.maxJobs) return;
  const finished = [...JOBS.values()]
    .filter(
      j =>
        (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') &&
        !j.followupInFlight
    )
    .sort((a, b) => (a.finishedAt || a.createdAt) - (b.finishedAt || b.createdAt));
  for (const job of finished) {
    if (JOBS.size <= config.maxJobs) break;
    deleteJob(job.id);
  }
}

function createJob({ clientId, params }) {
  const previousId = ACTIVE_BY_CLIENT.get(clientId);
  if (previousId) cancelJob(previousId, 'Aynı istemciden yeni bir analiz başlatıldığı için iptal edildi.');

  const job = {
    id: crypto.randomUUID(),
    accessToken: crypto.randomBytes(24).toString('hex'),
    clientId,
    params,
    status: 'pending',
    stage: 'queued',
    controller: new AbortController(),
    listeners: new Map(),
    events: [],
    result: null,
    error: null,
    cancelReason: null,
    createdAt: Date.now(),
    finishedAt: null,
    timer: null,
    followups: [],
    followupInFlight: false
  };

  JOBS.set(job.id, job);
  ACTIVE_BY_CLIENT.set(clientId, job.id);
  record(job, { type: 'stage', stage: 'queued' });
  QUEUE.push(job);

  evictOldestFinished();
  drain();
  return job;
}

function getJob(id) {
  return JOBS.get(id) || null;
}

/** Başarılı takip sorusundan sonra işin TTL'ini tazeler. */
function touchJob(id) {
  const job = JOBS.get(id);
  if (!job) return false;
  job.finishedAt = Date.now();
  return true;
}

function cancelJob(id, reason = null) {
  const job = JOBS.get(id);
  if (!job) return false;
  if (job.status !== 'running' && job.status !== 'pending') return false;

  job.cancelReason = reason;
  // Kuyruktaysa doğrudan düşür.
  const idx = QUEUE.indexOf(job);
  if (idx >= 0) QUEUE.splice(idx, 1);

  job.controller.abort();
  // Henüz startJob çalışmadıysa (kuyruktan düştüyse) finish'i kendimiz çağırırız.
  if (job.status === 'pending') finish(job, 'cancelled', { type: 'cancelled', reason });
  return true;
}

function tokenMatches(job, token) {
  if (!job || typeof token !== 'string' || token.length !== job.accessToken.length) return false;
  const a = Buffer.from(job.accessToken);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** SSE aboneliği: geçmiş olayları replay eder, heartbeat başlatır. */
function subscribe(job, res) {
  for (const payload of job.events) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    try {
      res.write(data);
    } catch {
      return () => {};
    }
  }

  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, MAX_HEARTBEAT_MS);
  heartbeat.unref?.();

  job.listeners.set(res, heartbeat);

  return function unsubscribe() {
    clearInterval(heartbeat);
    job.listeners.delete(res);
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    result: job.status === 'done' ? job.result : null,
    error: job.error,
    reason: job.status === 'cancelled' ? job.cancelReason : null,
    followupCount: job.followups.length,
    maxFollowups: config.maxFollowupsPerJob
  };
}

/** Takip sorusu geçmişini (rapor gövdesi olmadan) döndürür. */
function publicFollowups(job) {
  return job.followups.map(f => ({
    question: f.question,
    answer: f.answer,
    updated: f.updated,
    createdAt: f.createdAt
  }));
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    // Uçuştaki takip sorusunun işi, TTL dolsa bile yanıt tamamlanana kadar korunur.
    if (job.followupInFlight) continue;
    if (job.finishedAt && now - job.finishedAt > config.jobTtlMs) {
      deleteJob(id);
    }
  }
}

const cleanupTimer = setInterval(cleanupOldJobs, 60 * 1000);
cleanupTimer.unref?.();

function shutdown() {
  for (const job of JOBS.values()) {
    if (job.status === 'running' || job.status === 'pending') {
      job.cancelReason = 'Sunucu kapatılıyor.';
      job.controller.abort();
    }
    closeAll(job);
  }
  QUEUE.length = 0;
}

module.exports = {
  createJob,
  getJob,
  deleteJob,
  touchJob,
  cancelJob,
  subscribe,
  tokenMatches,
  publicJob,
  publicFollowups,
  cleanupOldJobs,
  trimJobImages,
  enforceImageBudget,
  retainedImageBytes,
  shutdown,
  isQueueFull: () => QUEUE.length >= config.maxQueuedJobs
};
