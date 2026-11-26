'use strict';

/**
 * İlan sayfası ön izleme servisi.
 *
 * Kullanıcının verdiği ilan linki sunucu tarafından bir kez indirilir; HTML
 * içindeki Open Graph / Twitter Card / JSON-LD meta verileri ve galeri
 * görselleri çıkarılır. Görseller sihirli bayt kontrolünden geçirilerek
 * base64 olarak döner; böylece frontend bunları normal fotoğraf yükleme
 * akışındaki gibi analize ekleyebilir.
 *
 * GÜVENLİK:
 * - Yalnızca public http/https adresleri; localhost, RFC1918, CGNAT,
 *   link-local, IPv6 ULA ve tek etiketli host'lar reddedilir.
 * - Yönlendirmeler elle izlenir (en fazla 3) ve her adımda yeniden doğrulanır.
 * - DNS yanıtındaki tüm adresler public olmak zorundadır.
 * - HTML 2 MB, fotoğraf başına 3 MB, toplam 16 MB ve en fazla 8 fotoğraf.
 * - Yalnızca JPEG/PNG/WEBP kabul edilir; içerik türü sihirli baytla doğrulanır.
 *
 * Not: DNS doğrulaması ile bağlantı arasında kalan teorik DNS-rebinding
 * penceresi, altyapı seviyesinde (çıkış güvenlik duvarı) ayrıca kapatılmalıdır.
 */

const dns = require('node:dns').promises;
const net = require('node:net');

const {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  isPrivateOrLocalHost,
  looksLikeImage,
  validateUrl
} = require('../utils/validation');

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_SCANNED_IMAGE_URLS = 24;
const DOWNLOAD_CONCURRENCY = 3;
const HTML_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 12_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36 IkinciElEksper/2.5';
const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1';
const IMAGE_ACCEPT = 'image/webp,image/png,image/jpeg,image/*;q=0.8';

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const PRODUCT_TYPE_RE = /product|vehicle|car|motorcycle|offer|itempage/i;

class ListingError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'ListingError';
    this.code = code;
    this.status = status;
    this.publicMessage = message;
  }
}

function isAbortError(err) {
  return Boolean(
    err &&
      (err.name === 'AbortError' ||
        err.name === 'TimeoutError' ||
        err.code === 'ABORT_ERR' ||
        err.code === 'UND_ERR_ABORTED')
  );
}

/**
 * URL'yi doğrular ve DNS yanıtındaki tüm adreslerin public olduğunu kontrol eder.
 * Yerel/özel adresler LISTING_BLOCKED ile reddedilir.
 */
async function resolvePublicUrl(raw, lookupImpl) {
  const checked = validateUrl(raw);
  if (!checked.ok || !checked.value) {
    const blocked = /yerel\/özel ağ/.test(checked.error || '');
    throw new ListingError(
      blocked ? 'LISTING_BLOCKED' : 'VALIDATION_ERROR',
      checked.error || 'Geçerli bir ilan linki girin.',
      400
    );
  }

  const parsed = new URL(checked.value);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookupImpl(host, { all: true, verbatim: true });
    } catch {
      throw new ListingError(
        'LISTING_FETCH_FAILED',
        'İlan sitesinin alan adı çözümlenemedi. Linki kontrol edip tekrar deneyin.',
        502
      );
    }
  }

  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (list.length === 0) {
    throw new ListingError('LISTING_FETCH_FAILED', 'İlan sitesinin adresi bulunamadı.', 502);
  }
  if (list.some(addr => !addr || isPrivateOrLocalHost(addr.address))) {
    throw new ListingError(
      'LISTING_BLOCKED',
      'İlan linki özel veya yerel bir ağ adresine yönleniyor; güvenlik nedeniyle engellendi.',
      400
    );
  }

  return parsed;
}

async function readLimitedBody(res, maxBytes) {
  if (!res.body) {
    throw new ListingError('LISTING_FETCH_FAILED', 'İlan sitesi boş bir yanıt döndürdü.', 502);
  }

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body.cancel();
    } catch {
      /* yut */
    }
    throw new ListingError('LISTING_TOO_LARGE', 'İlan sayfası izin verilen boyuttan büyük.', 413);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* yut */
        }
        throw new ListingError('LISTING_TOO_LARGE', 'İlan sayfası izin verilen boyuttan büyük.', 413);
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* yut */
    }
  }

  return Buffer.concat(chunks);
}

/**
 * Yönlendirmeleri elle izleyen, boyut ve süre sınırlı HTTP indirme.
 * Her adımda hedef URL yeniden doğrulanır (SSRF koruması).
 */
async function safeFetchBuffer(rawUrl, options) {
  const {
    maxBytes,
    timeoutMs,
    accept,
    lookupImpl,
    fetchImpl,
    signal
  } = options;

  let current = rawUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const parsed = await resolvePublicUrl(current, lookupImpl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onAbort = null;

    if (signal) {
      onAbort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetchImpl(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept,
          'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8',
          'cache-control': 'no-cache',
          'user-agent': USER_AGENT
        }
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        try {
          await res.body?.cancel();
        } catch {
          /* yut */
        }
        if (!location) {
          throw new ListingError('LISTING_FETCH_FAILED', 'İlan sitesi geçersiz bir yönlendirme döndürdü.', 502);
        }
        if (redirectCount === MAX_REDIRECTS) {
          throw new ListingError('LISTING_FETCH_FAILED', 'İlan linki çok fazla yönlendirme içeriyor.', 502);
        }
        current = new URL(location, parsed).toString();
        continue;
      }

      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          /* yut */
        }
        const status = res.status;
        let message;
        if (status === 401 || status === 403 || status === 429) {
          message =
            'İlan sitesi erişimi engelledi (bot koruması, üyelik veya istek limiti olabilir). ' +
            'Bilgileri elle girmeye devam edebilirsiniz.';
        } else if (status === 404 || status === 410) {
          message = 'İlan bulunamadı veya kaldırılmış (HTTP ' + status + ').';
        } else {
          message = 'İlan sayfası alınamadı (HTTP ' + status + ').';
        }
        throw new ListingError('LISTING_FETCH_FAILED', message, 502);
      }

      const buffer = await readLimitedBody(res, maxBytes);
      return {
        buffer,
        finalUrl: parsed.toString(),
        contentType: res.headers.get('content-type') || ''
      };
    } catch (err) {
      if (err instanceof ListingError) throw err;
      if (isAbortError(err) || controller.signal.aborted) {
        throw new ListingError('LISTING_TIMEOUT', 'İlan sitesi zamanında yanıt vermedi.', 504);
      }
      throw new ListingError(
        'LISTING_FETCH_FAILED',
        'İlan sitesine ulaşılamadı. Linki kontrol edip tekrar deneyin.',
        502
      );
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  throw new ListingError('LISTING_FETCH_FAILED', 'İlan linki çok fazla yönlendirme içeriyor.', 502);
}

/* ================= HTML ayrıştırma ================= */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  uuml: 'ü',
  Uuml: 'Ü',
  ouml: 'ö',
  Ouml: 'Ö',
  ccedil: 'ç',
  Ccedil: 'Ç',
  gbreve: 'ğ',
  Gbreve: 'Ğ',
  imath: 'ı',
  Idot: 'İ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  deg: '°',
  middot: '·',
  laquo: '«',
  raquo: '»',
  times: '×'
};

function decodeEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, entity)) return NAMED_ENTITIES[entity];
    const lower = NAMED_ENTITIES[entity.toLowerCase()];
    return lower !== undefined ? lower : match;
  });
}

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return decodeEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .trim();
}

function parseAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = re.exec(tag))) {
    const name = match[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    attrs[name] = decodeEntities((match[2] ?? match[3] ?? match[4] ?? '').trim());
  }
  return attrs;
}

function normalizePrice(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000) return null;
    return String(Math.round(value * 100) / 100);
  }
  if (typeof value !== 'string') return null;

  const cleaned = value.trim().replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let numeric;

  if (lastDot >= 0 && lastComma >= 0) {
    numeric =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const parts = cleaned.split(',');
    const looksThousands = parts.length > 1 && parts.slice(1).every(p => p.length === 3) && parts[0].length <= 3;
    numeric = looksThousands ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  } else if (lastDot >= 0) {
    const parts = cleaned.split('.');
    const looksThousands = parts.length > 1 && parts.slice(1).every(p => p.length === 3) && parts[0].length <= 3;
    numeric = looksThousands ? cleaned.replace(/\./g, '') : cleaned;
  } else {
    numeric = cleaned;
  }

  const n = Number(numeric);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_000) return null;
  return String(Math.round(n * 100) / 100);
}

function extractMetaFields(html) {
  const fields = { title: '', description: '', price: '', siteName: '', images: [] };

  const metaRe = /<meta\b[^>]*>/gi;
  let match;
  while ((match = metaRe.exec(html))) {
    const attrs = parseAttributes(match[0]);
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    const content = attrs.content || '';
    if (!key || !content) continue;

    if (!fields.title && /^(og:title|twitter:title|title)$/.test(key)) fields.title = content;
    if (!fields.description && /^(og:description|twitter:description|description)$/.test(key)) {
      fields.description = content;
    }
    if (!fields.siteName && key === 'og:site_name') fields.siteName = content;
    if (!fields.price && /^(product:price:amount|og:price:amount|price)$/.test(key)) fields.price = content;
    if (
      /^(og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src|image|thumbnailurl|thumbnail)$/.test(
        key
      )
    ) {
      fields.images.push(content);
    }
  }

  const linkRe = /<link\b[^>]*>/gi;
  while ((match = linkRe.exec(html))) {
    const attrs = parseAttributes(match[0]);
    const rel = String(attrs.rel || '').toLowerCase().split(/\s+/);
    if (rel.includes('image_src') && attrs.href) fields.images.push(attrs.href);
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!fields.title && titleMatch) fields.title = titleMatch[1];

  return fields;
}

function collectJsonLd(value, out, depth) {
  if (!value || typeof value !== 'object' || depth > 8 || out.length >= 200) return;
  if (Array.isArray(value)) {
    value.forEach(item => collectJsonLd(item, out, depth + 1));
    return;
  }

  out.push(value);
  ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasPart'].forEach(key => {
    if (value[key]) collectJsonLd(value[key], out, depth + 1);
  });
}

function parseJsonLdObjects(html) {
  const objects = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (!/application\/ld\+json/i.test(attrs.type || '')) continue;

    const raw = match[2].replace(/^\s*<!--/, '').replace(/-->\s*$/, '').trim();
    if (!raw) continue;
    try {
      collectJsonLd(JSON.parse(raw), objects, 0);
    } catch {
      /* bozuk JSON-LD yok sayılır */
    }
  }
  return objects;
}

function firstString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const found = value.find(item => typeof item === 'string');
    return found || '';
  }
  return '';
}

function collectImageValues(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectImageValues(item, out));
    return;
  }
  if (typeof value === 'object') {
    collectImageValues(value.url || value.contentUrl || value.thumbnailUrl, out);
  }
}

function pickJsonLdFields(objects) {
  const productLike = objects.filter(obj => {
    const type = Array.isArray(obj['@type']) ? obj['@type'].join(' ') : String(obj['@type'] || '');
    return PRODUCT_TYPE_RE.test(type) || obj.offers || obj.price !== undefined;
  });
  const pool = productLike.length > 0 ? productLike : objects;

  let title = '';
  let description = '';
  let price = '';
  const images = [];

  for (const obj of pool) {
    if (!title) title = cleanText(firstString(obj.name || obj.headline || obj.alternateName), 300);
    if (!description) description = cleanText(firstString(obj.description), 6000);

    if (!price) {
      const candidates = [obj.price, obj.priceSpecification && obj.priceSpecification.price];
      if (obj.offers) {
        const offers = Array.isArray(obj.offers) ? obj.offers : [obj.offers];
        offers.forEach(offer => {
          if (!offer || typeof offer !== 'object') return;
          candidates.push(offer.price, offer.lowPrice, offer.priceSpecification && offer.priceSpecification.price);
        });
      }
      for (const candidate of candidates) {
        const normalized = normalizePrice(candidate);
        if (normalized) {
          price = normalized;
          break;
        }
      }
    }

    collectImageValues(obj.image, images);
    if (obj.thumbnailUrl) collectImageValues(obj.thumbnailUrl, images);
  }

  return { title, description, price, images };
}

function resolveImageUrl(value, baseUrl) {
  if (typeof value !== 'string') return null;
  const raw = decodeEntities(value).trim();
  if (!raw || /^data:/i.test(raw)) return null;

  try {
    const parsed = new URL(raw, baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (/\.(svg|gif|ico|bmp|avif)$/i.test(parsed.pathname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractImgCandidates(html) {
  const out = [];
  const imgRe = /<img\b[^>]*>/gi;
  let match;

  while ((match = imgRe.exec(html)) && out.length < MAX_SCANNED_IMAGE_URLS) {
    const attrs = parseAttributes(match[0]);
    const alt = String(attrs.alt || '').toLowerCase();
    if (/logo|icon|avatar|sprite|placeholder/.test(alt)) continue;

    const width = Number(attrs.width);
    const height = Number(attrs.height);
    if ((Number.isFinite(width) && width > 0 && width < 180) || (Number.isFinite(height) && height > 0 && height < 180)) {
      continue;
    }

    let candidate = attrs.src || attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src'] || '';
    const srcset = attrs.srcset || attrs['data-srcset'] || '';
    if (!candidate && srcset) candidate = srcset.split(',')[0].trim().split(/\s+/)[0];
    if (!candidate || /^data:/i.test(candidate)) continue;
    if (/logo|icon|avatar|sprite|placeholder|1x1|pixel\.(?:gif|png)/i.test(candidate)) continue;

    out.push(candidate);
  }

  return out;
}

/**
 * HTML'den ilan başlığı, açıklaması, fiyatı ve görsel adaylarını çıkarır.
 * Görseller indirilmez; yalnızca çözümlenmiş URL listesi döner.
 */
function parseListingHtml(html, pageUrl) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new ListingError('LISTING_EMPTY', 'İlan sayfası boş döndü.', 422);
  }

  const jsonLd = pickJsonLdFields(parseJsonLdObjects(html));
  const withoutScripts = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const meta = extractMetaFields(withoutScripts);

  const rawImages = [
    ...meta.images,
    ...jsonLd.images,
    ...extractImgCandidates(withoutScripts)
  ];

  const imageCandidates = [];
  const seen = new Set();
  for (const raw of rawImages) {
    const resolved = resolveImageUrl(raw, pageUrl);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    imageCandidates.push(resolved);
    if (imageCandidates.length >= MAX_SCANNED_IMAGE_URLS) break;
  }

  return {
    title: cleanText(meta.title || jsonLd.title, 160),
    description: cleanText(meta.description || jsonLd.description, 6000),
    price: normalizePrice(meta.price) || jsonLd.price || null,
    siteName: cleanText(meta.siteName, 120),
    imageCandidates
  };
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (looksLikeImage(buffer, 'image/jpeg')) return 'image/jpeg';
  if (looksLikeImage(buffer, 'image/png')) return 'image/png';
  if (looksLikeImage(buffer, 'image/webp')) return 'image/webp';
  return null;
}

function decodeHtml(buffer, contentType) {
  let charset = '';
  const headerCharset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType || '');
  if (headerCharset) charset = headerCharset[1];

  if (!charset) {
    const head = buffer.subarray(0, 2048).toString('latin1');
    const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
    if (metaCharset) charset = metaCharset[1];
  }

  const label = (charset || 'utf-8').toLowerCase();
  try {
    const decoded = new TextDecoder(label).decode(buffer);
    if (label !== 'utf-8' && decoded.includes('\uFFFD')) return buffer.toString('utf8');
    return decoded;
  } catch {
    return buffer.toString('utf8');
  }
}

async function downloadListingImages(candidates, options) {
  const { fetchImpl, lookupImpl, signal } = options;
  const warnings = [];
  const results = [];
  const queue = candidates.slice(0, MAX_SCANNED_IMAGE_URLS);

  let nextIndex = 0;
  let totalBytes = 0;
  let failed = 0;
  let unsupported = 0;
  let tooLarge = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped) {
      const index = nextIndex++;
      if (index >= queue.length) return;
      if (results.length >= MAX_IMAGES || totalBytes >= MAX_TOTAL_IMAGE_BYTES) {
        stopped = true;
        return;
      }

      const remaining = MAX_TOTAL_IMAGE_BYTES - totalBytes;
      if (remaining < 4096) {
        stopped = true;
        return;
      }

      try {
        const downloaded = await safeFetchBuffer(queue[index], {
          maxBytes: Math.min(MAX_IMAGE_BYTES, remaining),
          timeoutMs: IMAGE_TIMEOUT_MS,
          accept: IMAGE_ACCEPT,
          lookupImpl,
          fetchImpl,
          signal
        });

        const mimeType = detectImageMime(downloaded.buffer);
        if (!mimeType || !looksLikeImage(downloaded.buffer, mimeType)) {
          unsupported++;
          continue;
        }
        if (downloaded.buffer.length > MAX_IMAGE_BYTES) {
          tooLarge++;
          continue;
        }
        if (results.length >= MAX_IMAGES) {
          stopped = true;
          continue;
        }
        if (totalBytes + downloaded.buffer.length > MAX_TOTAL_IMAGE_BYTES) {
          tooLarge++;
          stopped = true;
          continue;
        }

        totalBytes += downloaded.buffer.length;
        results.push({ index, mimeType, data: downloaded.buffer.toString('base64') });
      } catch (err) {
        if (err instanceof ListingError && err.code === 'LISTING_TOO_LARGE') tooLarge++;
        else failed++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, () => worker())
  );

  results.sort((a, b) => a.index - b.index);

  if (failed > 0) {
    warnings.push(`${failed} fotoğraf indirilemedi (site erişimi veya bağlantı hatası).`);
  }
  if (unsupported > 0) {
    warnings.push(`${unsupported} görsel desteklenmeyen formatta olduğu için atlandı (yalnızca JPEG/PNG/WEBP).`);
  }
  if (tooLarge > 0) {
    warnings.push(`${tooLarge} görsel boyut sınırını aştığı için atlandı.`);
  }
  if (candidates.length > MAX_IMAGES) {
    warnings.push(`Sayfada ${candidates.length} görsel bulundu; en fazla ${MAX_IMAGES} tanesi alındı.`);
  }

  return {
    images: results.map(({ mimeType, data }) => ({ mimeType, data })),
    warnings
  };
}

/**
 * İlan linkini indirir; başlık, açıklama, fiyat ve fotoğrafları döndürür.
 * Testlerde fetchImpl/lookupImpl enjekte edilebilir.
 */
async function fetchListingPreview(rawUrl, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const lookupImpl = options.lookupImpl || ((host, opts) => dns.lookup(host, opts));

  if (typeof fetchImpl !== 'function') {
    throw new ListingError('LISTING_FETCH_FAILED', 'Sunucu HTTP istemcisi kullanılamıyor.', 500);
  }

  const checked = validateUrl(rawUrl);
  if (!checked.ok || !checked.value) {
    throw new ListingError('VALIDATION_ERROR', checked.error || 'Geçerli bir ilan linki girin.', 400);
  }

  const page = await safeFetchBuffer(checked.value, {
    maxBytes: MAX_HTML_BYTES,
    timeoutMs: HTML_TIMEOUT_MS,
    accept: HTML_ACCEPT,
    lookupImpl,
    fetchImpl,
    signal: options.signal
  });

  const mime = String(page.contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (mime && !HTML_TYPES.has(mime)) {
    throw new ListingError('UNSUPPORTED_CONTENT', `İlan linki bir web sayfası değil (${mime}).`, 415);
  }

  const html = decodeHtml(page.buffer, page.contentType);
  if (!/^\s*</.test(html.replace(/^\uFEFF/, ''))) {
    throw new ListingError('UNSUPPORTED_CONTENT', 'İlan linki HTML içeriği döndürmedi.', 415);
  }

  const parsed = parseListingHtml(html, page.finalUrl);
  const downloaded = await downloadListingImages(parsed.imageCandidates, {
    fetchImpl,
    lookupImpl,
    signal: options.signal
  });

  const warnings = downloaded.warnings.slice();
  if (!parsed.title && !parsed.description && !parsed.price && downloaded.images.length === 0) {
    throw new ListingError(
      'LISTING_EMPTY',
      'İlan sayfasında okunabilir ilan bilgisi veya fotoğraf bulunamadı. ' +
        'Site bot koruması kullanıyor olabilir; bilgileri elle girmeye devam edebilirsiniz.',
      422
    );
  }
  if (downloaded.images.length === 0) {
    warnings.unshift('İlan sayfasında indirilebilir fotoğraf bulunamadı.');
  }

  return {
    url: page.finalUrl,
    sourceHost: new URL(page.finalUrl).hostname,
    siteName: parsed.siteName || null,
    title: parsed.title || '',
    description: parsed.description || '',
    price: parsed.price || null,
    images: downloaded.images,
    warnings,
    fetchedAt: new Date().toISOString()
  };
}

module.exports = {
  ListingError,
  fetchListingPreview,
  parseListingHtml,
  normalizePrice
};
