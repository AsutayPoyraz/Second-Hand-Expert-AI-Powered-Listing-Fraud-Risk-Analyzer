'use strict';

/**
 * Sunucu tarafı girdi doğrulama. İstemci doğrulaması yalnızca kullanıcı
 * deneyimi içindir; güvenlik sınırı burasıdır.
 */

const config = require('../config');

const net = require('net');

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // base64 çözüldükten sonraki üst sınır (foto başına)
const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;

const MAX_NAME_LEN = 160;
const MAX_DESC_LEN = 6000;
const MAX_URL_LEN = 2048;

const MIN_YEAR = 1950;
const MAX_KM = 2_000_000;
const MAX_PRICE = 1_000_000_000;

const CATEGORIES = ['vasita', 'ikinciel'];
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// URL context aracına verilebilecek adresler: yalnızca genel (public) http/https.
// Yerel/özel ağ adresleri (localhost, RFC1918, CGNAT, link-local, IPv6 ULA/link-local,
// IPv4-mapped IPv6, metadata servisleri) engellenir. Hostname sondaki nokta atılarak
// normalize edilir: "localhost." → "localhost".
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  'metadata.google.internal',
  'metadata.google'
]);
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.lan'];

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function isPrivateIPv6(ip) {
  const h = ip.toLowerCase();
  if (h === '::' || h === '::1') return true;

  const mapped4 = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped4) return isPrivateIPv4(mapped4[1]);

  // Node URL, IPv4-mapped adresleri hex biçimine normalize eder: ::ffff:7f00:1
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]?:/.test(h) || h === 'fe80') return true; // fe80::/10 (link-local)
  if (h.startsWith('ff')) return true; // multicast
  return false;
}

function isPrivateOrLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '');
  const bare = h.replace(/^\[|\]$/g, '');
  if (!bare) return true;
  if (BLOCKED_HOSTS.has(bare)) return true;
  if (BLOCKED_SUFFIXES.some(suffix => h.endsWith(suffix))) return true;

  const version = net.isIP(bare);
  if (version === 4) return isPrivateIPv4(bare);
  if (version === 6) return isPrivateIPv6(bare);

  // Noktasız (tek etiketli) adlar iç ağ adı olabilir; genel alan adı varsayılmaz.
  return !bare.includes('.');
}

function getAllowedModels() {
  return config.allowedModels.slice();
}

function validateModel(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: config.defaultModel };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Model adı metin olmalı.' };
  }
  const model = raw.trim();
  if (!getAllowedModels().includes(model)) {
    return {
      ok: false,
      error: `Desteklenmeyen model: "${model}". İzinli modeller: ${getAllowedModels().join(', ')}.`
    };
  }
  return { ok: true, value: model };
}

/**
 * Türkçe sayı biçimlerini ayrıştırır: "21.000", "21,5", "21.000,50", "21000".
 * Geçersizse NaN döner.
 */
function parseTurkishNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;

  let s = raw.trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (!/^-?[0-9.,]+$/.test(s)) return NaN;

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  } else if (hasDot) {
    const parts = s.split('.');
    const looksThousands = parts.length > 1 && parts.slice(1).every(p => p.length === 3) && parts[0].length <= 3;
    if (looksThousands) s = s.replace(/\./g, '');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function validatePrice(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: 'İlan fiyatı zorunludur.' };
  }
  const n = parseTurkishNumber(raw);
  if (Number.isNaN(n)) {
    return { ok: false, error: 'Fiyat geçerli bir sayı olmalı (örn: 21000 veya 21.000).' };
  }
  if (n <= 0) {
    return { ok: false, error: 'Fiyat sıfır veya negatif olamaz.' };
  }
  if (n > MAX_PRICE) {
    return { ok: false, error: 'Fiyat mantık dışı derecede büyük.' };
  }
  return { ok: true, value: n };
}

function validateUrl(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'İlan linki metin olmalı.' };
  }
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > MAX_URL_LEN) {
    return { ok: false, error: `İlan linki çok uzun (en fazla ${MAX_URL_LEN} karakter).` };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'Geçerli bir ilan linki girin (http:// veya https://).' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'İlan linki yalnızca http veya https olabilir.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'İlan linki kullanıcı adı/şifre içeremez.' };
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLocalHost(host)) {
    return { ok: false, error: 'İlan linki yerel/özel ağ adreslerini gösteremez.' };
  }
  return { ok: true, value: parsed.toString() };
}

function looksLikeImage(buffer, mimeType) {
  if (!buffer || buffer.length < 12) return false;
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimeType === 'image/webp') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function validateImages(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: '"images" bir dizi olmalı.' };
  }
  if (raw.length > MAX_IMAGES) {
    return { ok: false, error: `En fazla ${MAX_IMAGES} fotoğraf gönderilebilir (gelen: ${raw.length}).` };
  }

  const out = [];
  let totalBytes = 0;

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const label = `Fotoğraf ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `${label}: geçersiz nesne.` };
    }
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      return { ok: false, error: `${label}: desteklenmeyen tür (${mimeType || 'bilinmiyor'}). JPEG, PNG veya WEBP olmalı.` };
    }
    let data = typeof item.data === 'string' ? item.data.trim() : '';
    if (!data) {
      return { ok: false, error: `${label}: görsel verisi boş.` };
    }
    if (data.startsWith('data:')) {
      return { ok: false, error: `${label}: veri "data:" öneki içermemeli; yalnızca base64 gövdesi gönderin.` };
    }
    if (data.length > MAX_IMAGE_BASE64_CHARS) {
      return { ok: false, error: `${label}: görsel çok büyük (üst sınır ${MAX_IMAGE_BYTES / 1024 / 1024}MB).` };
    }
    if (!BASE64_RE.test(data)) {
      return { ok: false, error: `${label}: geçersiz base64 verisi.` };
    }

    const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) {
      return { ok: false, error: `${label}: görsel çok büyük (üst sınır ${MAX_IMAGE_BYTES / 1024 / 1024}MB).` };
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return { ok: false, error: `Fotoğrafların toplam boyutu çok yüksek (üst sınır ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024}MB).` };
    }

    const head = Buffer.from(data.slice(0, 32), 'base64');
    if (!looksLikeImage(head, mimeType)) {
      return { ok: false, error: `${label}: içerik belirtilen görsel türüyle uyuşmuyor.` };
    }

    out.push({ mimeType, data });
  }

  return { ok: true, value: out };
}

function validateText(raw, { field, label, required, maxLen }) {
  if (raw === undefined || raw === null) {
    if (required) return { ok: false, error: `${label} zorunludur.` };
    return { ok: true, value: '' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `${label} metin olmalı.` };
  }
  const value = raw.split('\u0000').join('').trim();
  if (required && !value) {
    return { ok: false, error: `${label} zorunludur.` };
  }
  if (value.length > maxLen) {
    return { ok: false, error: `${label} çok uzun (en fazla ${maxLen} karakter).` };
  }
  return { ok: true, value, field };
}

function validateYear(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: 'Model yılı zorunludur.' };
  }
  const n = Number(raw);
  const currentYear = new Date().getFullYear();
  if (!Number.isInteger(n)) {
    return { ok: false, error: 'Model yılı tam sayı olmalı.' };
  }
  if (n < MIN_YEAR || n > currentYear + 1) {
    return { ok: false, error: `Model yılı ${MIN_YEAR}–${currentYear + 1} arasında olmalı.` };
  }
  return { ok: true, value: n };
}

function validateKm(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: 'Kilometre zorunludur.' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: 'Kilometre tam sayı olmalı.' };
  }
  if (n < 0) {
    return { ok: false, error: 'Kilometre negatif olamaz.' };
  }
  if (n > MAX_KM) {
    return { ok: false, error: 'Kilometre mantık dışı derecede büyük.' };
  }
  return { ok: true, value: n };
}

/**
 * POST /api/analyze gövdesini doğrular.
 * Döndürür: { valid, errors: [{ field, message }], value }
 */
function validateAnalyzeRequest(body) {
  const errors = [];
  const push = (field, result) => {
    if (!result.ok) errors.push({ field, message: result.error });
    return result;
  };

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: [{ field: 'body', message: 'İstek gövdesi bir JSON nesnesi olmalı.' }], value: null };
  }

  const category = typeof body.category === 'string' ? body.category.trim() : '';
  if (!CATEGORIES.includes(category)) {
    errors.push({ field: 'category', message: `Kategori "vasita" veya "ikinciel" olmalı (gelen: "${category || 'boş'}").` });
  }

  const name = push('name', validateText(body.name, { field: 'name', label: 'Ürün / araç adı', required: true, maxLen: MAX_NAME_LEN }));
  const desc = push('desc', validateText(body.desc, { field: 'desc', label: 'İlan açıklaması', required: false, maxLen: MAX_DESC_LEN }));
  const price = push('price', validatePrice(body.price));
  const url = push('url', validateUrl(body.url));
  const model = push('model', validateModel(body.model));
  const images = push('images', validateImages(body.images));

  let year;
  let km;
  if (category === 'vasita') {
    year = push('year', validateYear(body.year));
    km = push('km', validateKm(body.km));
  }

  if (errors.length > 0) {
    return { valid: false, errors, value: null };
  }

  const value = {
    category,
    name: name.value,
    desc: desc.value,
    price: price.value,
    url: url.value,
    model: model.value,
    images: images.value
  };
  if (category === 'vasita') {
    value.year = year.value;
    value.km = km.value;
  }

  return { valid: true, errors: [], value };
}

/** Takip sorusu: kısa, boş olamaz, en fazla 1000 karakter. */
const MAX_QUESTION_LEN = 1000;

function validateQuestion(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Soru metin olmalı.' };
  }
  const value = raw.split('\u0000').join('').trim();
  if (!value) {
    return { ok: false, error: 'Soru boş olamaz.' };
  }
  if (value.length > MAX_QUESTION_LEN) {
    return { ok: false, error: `Soru çok uzun (en fazla ${MAX_QUESTION_LEN} karakter).` };
  }
  return { ok: true, value };
}

/** x-client-id başlığını doğrular (imza değil, yalnızca biçim). */
function normalizeClientId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(id)) return null;
  return id;
}

module.exports = {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_NAME_LEN,
  MAX_DESC_LEN,
  MAX_URL_LEN,
  MAX_QUESTION_LEN,
  CATEGORIES,
  ALLOWED_MIME_TYPES,
  getAllowedModels,
  validateModel,
  parseTurkishNumber,
  validatePrice,
  validateUrl,
  isPrivateOrLocalHost,
  looksLikeImage,
  validateImages,
  validateYear,
  validateKm,
  validateAnalyzeRequest,
  validateQuestion,
  normalizeClientId
};
