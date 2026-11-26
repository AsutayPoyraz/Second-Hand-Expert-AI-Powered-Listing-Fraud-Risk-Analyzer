'use strict';

/**
 * URL ve serbest metinlerdeki gizli değerleri maskeler.
 * - `?token=` / `?key=` / `?api_key=` sorgu parametreleri
 * - Google API anahtarları (`AIza…`, yeni `AQ.…` biçimi)
 *
 * pino-http erişim logu ve hata logu aynı fonksiyonu kullanır; böylece
 * `?token=…` gibi hassas değerler hiçbir log satırına düz metin düşmez.
 */

const SECRET_QUERY_RE = /([?&](?:token|access_token|key|api_key)=)[^&\s]*/gi;
const GOOGLE_KEY_RES = [/AIza[0-9A-Za-z_-]{10,}/g, /AQ\.[0-9A-Za-z_.-]{8,}/g];

function redactUrl(url) {
  return String(url || '').replace(SECRET_QUERY_RE, '$1[GİZLİ]');
}

function redactText(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const re of GOOGLE_KEY_RES) out = out.replace(re, '[GİZLİ]');
  return out.replace(SECRET_QUERY_RE, '$1[GİZLİ]');
}

module.exports = { redactUrl, redactText };
