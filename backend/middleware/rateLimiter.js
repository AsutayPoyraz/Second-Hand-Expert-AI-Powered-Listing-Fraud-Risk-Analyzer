'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config');

const message = extra => ({
  error: extra,
  code: 'RATE_LIMITED'
});

// Analiz başlatma: dakikada RATE_LIMIT_PER_MINUTE (varsayılan 5).
// Not: varsayılan bellek deposu tek süreç içindir. Çok sunuculu dağıtımda
// rate-limit-redis gibi paylaşılan bir store kullanılmalıdır.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.rateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message(
    `Çok fazla analiz isteği gönderdiniz. Lütfen bir dakika bekleyip tekrar deneyin (limit: dakikada ${config.rateLimitPerMinute}).`
  )
});

// Diğer API uçları için daha gevşek sınır (SSE/polling dahil).
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.apiRateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message(
    `Çok fazla istek gönderdiniz. Lütfen biraz bekleyin (limit: dakikada ${config.apiRateLimitPerMinute}).`
  )
});

// İlan linki tarama: dış siteye istek atıldığı için ayrı ve dar bir sınır.
const listingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.listingRateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message(
    `Çok fazla ilan linki tarama isteği gönderdiniz. Lütfen biraz bekleyin (limit: dakikada ${config.listingRateLimitPerMinute}).`
  )
});

// Takip sorusu: her biri ücretli bir Gemini çağrısı; ayrı ve dar bir sınır.
const followupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.followupRateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message(
    `Çok fazla takip sorusu gönderdiniz. Lütfen biraz bekleyin (limit: dakikada ${config.followupRateLimitPerMinute}).`
  )
});

// Anahtar ayarları: yazma/test uçları anahtar denemesi yapabildiği için dar sınır.
const settingsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.settingsRateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message(
    `Çok fazla anahtar ayarı isteği gönderdiniz. Lütfen biraz bekleyin (limit: dakikada ${config.settingsRateLimitPerMinute}).`
  )
});

// Süreç geneli analiz sınırı: IP başına limitten bağımsız olarak toplam maliyeti
// kontrol altında tutar (tek süreç; dağıtımda paylaşılan store gerekir).
const globalAnalysisLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.globalAnalysisLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: () => 'global',
  message: message(
    `Sunucu genelinde analiz limitine ulaşıldı. Lütfen bir dakika bekleyip tekrar deneyin (limit: dakikada ${config.globalAnalysisLimitPerMinute}).`
  )
});

module.exports = {
  analyzeLimiter,
  apiLimiter,
  listingLimiter,
  followupLimiter,
  settingsLimiter,
  globalAnalysisLimiter
};
