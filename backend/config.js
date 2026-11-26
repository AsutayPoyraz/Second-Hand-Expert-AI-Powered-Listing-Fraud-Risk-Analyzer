'use strict';

/**
 * Ortam değişkenlerini tek noktadan, şema ile doğrular.
 * Hatalı/eksik yapılandırma ile uygulamanın "yarı çalışır" hâlde
 * ayağa kalkmasını engeller (fail-fast).
 */

require('dotenv').config();

const path = require('path');
const { z } = require('zod');

const truthy = new Set(['1', 'true', 'yes', 'on']);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  // Arayüzden girilen anahtarın kalıcı olarak saklanacağı dosya.
  // Varsayılan: proje kökündeki data/api-key.json (frontend'in dışında).
  API_KEY_STORE_PATH: z.string().trim().optional(),
  DEFAULT_GEMINI_MODEL: z.string().trim().regex(/^[a-z0-9.-]{3,64}$/i).default('gemini-3.5-flash'),
  GEMINI_ALLOWED_MODELS: z
    .string()
    .default('gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-pro-preview'),
  GEMINI_SEARCH_ENABLED: z.string().default('true'),

  ALLOWED_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().optional(),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(10_000).default(5),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(10_000).default(120),
  LISTING_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(10_000).default(10),
  FOLLOWUP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(10_000).default(6),
  SETTINGS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(10_000).default(10),
  GLOBAL_ANALYSIS_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(10_000).default(30),

  MAX_CONCURRENT_ANALYSES: z.coerce.number().int().positive().max(100).default(3),
  MAX_QUEUED_JOBS: z.coerce.number().int().positive().max(10_000).default(20),
  MAX_JOBS: z.coerce.number().int().positive().max(10_000).default(200),
  JOB_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  MAX_FOLLOWUPS_PER_JOB: z.coerce.number().int().positive().max(100).default(10),
  FOLLOWUP_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  // Takip sorusunda yeniden gönderilecek fotoğraf sayısı ve foto başına base64 üst sınırı.
  FOLLOWUP_IMAGE_LIMIT: z.coerce.number().int().min(0).max(8).default(2),
  FOLLOWUP_IMAGE_MAX_BYTES: z.coerce.number().int().positive().default(700_000),
  // Tamamlanmış işlerde takip için bellekte tutulan toplam fotoğraf bütçesi (base64 karakter).
  RETAINED_IMAGE_BUDGET_MB: z.coerce.number().int().positive().max(4096).default(64),

  BODY_LIMIT: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d+)?(?:b|kb|mb|gb)$/i, 'Örnek: 32mb')
    .default('32mb'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2)
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map(issue => `  - ${issue.path.join('.') || '(kök)'}: ${issue.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`[yapılandırma hatası] .env değerleri geçersiz:\n${details}`);
  process.exit(1);
}

const env = parsed.data;

const allowedOrigins = (env.ALLOWED_ORIGINS || `http://localhost:${env.PORT}`)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowedModels = env.GEMINI_ALLOWED_MODELS
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (allowedModels.length === 0) {
  // eslint-disable-next-line no-console
  console.error('[yapılandırma hatası] GEMINI_ALLOWED_MODELS boş olamaz.');
  process.exit(1);
}

if (!allowedModels.includes(env.DEFAULT_GEMINI_MODEL)) {
  // eslint-disable-next-line no-console
  console.warn(
    `[uyarı] DEFAULT_GEMINI_MODEL (${env.DEFAULT_GEMINI_MODEL}) izinli model listesinde değil; ` +
      `ilk izinli model kullanılacak: ${allowedModels[0]}`
  );
}

if (env.NODE_ENV === 'production' && !env.GEMINI_API_KEY) {
  // Anahtar arayüzden girilebildiği için üretimde zorunlu değil; yalnızca uyar.
  // eslint-disable-next-line no-console
  console.warn(
    '[uyarı] GEMINI_API_KEY tanımlı değil. Anahtarı arayüzdeki "Gemini API anahtarı" kartından girip kaydedebilirsiniz.'
  );
}

let trustProxy = false;
if (env.TRUST_PROXY !== undefined) {
  const raw = env.TRUST_PROXY.trim();
  if (truthy.has(raw.toLowerCase())) trustProxy = true;
  else if (/^\d+$/.test(raw)) trustProxy = Number(raw);
  else trustProxy = raw; // express'e "loopback" gibi bir ifade geçirilebilir
} else if (env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.warn(
    '[uyarı] TRUST_PROXY tanımlı değil. Ters proxy/load balancer arkasında tüm istemciler ' +
      'aynı IP olarak görülür; IP bazlı rate limit global hâle gelir. Üretimde TRUST_PROXY=1 (veya proxy sayısı) ayarlayın.'
  );
}

const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  // Yalnızca .env yedeği; etkin anahtar apiKeyStore üzerinden okunur.
  apiKey: env.GEMINI_API_KEY || '',
  // Göreli yol verilirse proje köküne göre çözülür (çalışma dizininden bağımsız).
  apiKeyStorePath: env.API_KEY_STORE_PATH
    ? path.resolve(__dirname, '..', env.API_KEY_STORE_PATH)
    : path.join(__dirname, '..', 'data', 'api-key.json'),
  defaultModel: allowedModels.includes(env.DEFAULT_GEMINI_MODEL)
    ? env.DEFAULT_GEMINI_MODEL
    : allowedModels[0],
  allowedModels,
  searchEnabled: truthy.has(env.GEMINI_SEARCH_ENABLED.trim().toLowerCase()),
  allowedOrigins,
  trustProxy,
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
  apiRateLimitPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
  listingRateLimitPerMinute: env.LISTING_RATE_LIMIT_PER_MINUTE,
  followupRateLimitPerMinute: env.FOLLOWUP_RATE_LIMIT_PER_MINUTE,
  settingsRateLimitPerMinute: env.SETTINGS_RATE_LIMIT_PER_MINUTE,
  globalAnalysisLimitPerMinute: env.GLOBAL_ANALYSIS_LIMIT_PER_MINUTE,
  maxConcurrentAnalyses: env.MAX_CONCURRENT_ANALYSES,
  maxQueuedJobs: env.MAX_QUEUED_JOBS,
  maxJobs: env.MAX_JOBS,
  jobTtlMs: env.JOB_TTL_MS,
  jobTimeoutMs: env.JOB_TIMEOUT_MS,
  maxFollowupsPerJob: env.MAX_FOLLOWUPS_PER_JOB,
  followupTimeoutMs: env.FOLLOWUP_TIMEOUT_MS,
  followupImageLimit: env.FOLLOWUP_IMAGE_LIMIT,
  followupImageMaxBytes: env.FOLLOWUP_IMAGE_MAX_BYTES,
  retainedImageBudgetBytes: env.RETAINED_IMAGE_BUDGET_MB * 1024 * 1024,
  bodyLimit: env.BODY_LIMIT,
  requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
  logLevel: env.LOG_LEVEL,
  geminiTimeoutMs: env.GEMINI_TIMEOUT_MS,
  geminiMaxRetries: env.GEMINI_MAX_RETRIES
};

module.exports = config;
