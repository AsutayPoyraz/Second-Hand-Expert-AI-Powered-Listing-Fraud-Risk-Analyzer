'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ListingError,
  fetchListingPreview,
  parseListingHtml,
  normalizePrice
} = require('../backend/services/listingFetcher');

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00
]);

function htmlResponse(html, extraHeaders = {}) {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders }
  });
}

function imageResponse(bytes = JPEG_BYTES, mimeType = 'image/jpeg') {
  return new Response(bytes, { status: 200, headers: { 'content-type': mimeType } });
}

function isListingError(code) {
  return err => err instanceof ListingError && err.code === code;
}

test('parseListingHtml: Open Graph + JSON-LD + göreli görsel ve dedupe', () => {
  const html = `<!doctype html><html><head>
    <title>Yedek başlık</title>
    <meta property="og:title" content="2018 Renault Clio 1.5 dCi">
    <meta property="og:description" content="Temiz &amp; bakımlı araç">
    <meta property="product:price:amount" content="215.000">
    <meta property="og:image" content="/img/on.jpg">
    <meta property="og:image" content="https://cdn.example.com/img/on.jpg">
    <meta name="twitter:image" content="https://cdn.example.com/img/yan.jpg">
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Vehicle","name":"JSON-LD Clio",
       "image":["https://cdn.example.com/img/ic.jpg"],
       "offers":{"@type":"Offer","price":"215000"}}
    </script>
  </head><body>
    <img src="https://cdn.example.com/logo.png" alt="Site logosu">
    <img data-src="/img/kapak.jpg" width="800" height="600" alt="Ön görünüm">
  </body></html>`;

  const parsed = parseListingHtml(html, 'https://www.example.com/ilan/1');

  assert.equal(parsed.title, '2018 Renault Clio 1.5 dCi');
  assert.equal(parsed.description, 'Temiz & bakımlı araç');
  assert.equal(parsed.price, '215000');
  assert.deepEqual(parsed.imageCandidates, [
    'https://www.example.com/img/on.jpg',
    'https://cdn.example.com/img/on.jpg',
    'https://cdn.example.com/img/yan.jpg',
    'https://cdn.example.com/img/ic.jpg',
    'https://www.example.com/img/kapak.jpg'
  ]);
});

test('parseListingHtml: meta yoksa JSON-LD alanlarına düşer ve göreli URL çözer', () => {
  const html = `<html><head>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"iPhone 13 128GB",
       "description":"Kutulu, faturalı","offers":{"price":"21.500,50"},
       "image":{"@type":"ImageObject","url":"/img/iphone.jpg"}}
    </script>
  </head><body></body></html>`;

  const parsed = parseListingHtml(html, 'https://example.com/urun/1');

  assert.equal(parsed.title, 'iPhone 13 128GB');
  assert.equal(parsed.description, 'Kutulu, faturalı');
  assert.equal(parsed.price, '21500.5');
  assert.deepEqual(parsed.imageCandidates, ['https://example.com/img/iphone.jpg']);
});

test('normalizePrice: Türkçe ve İngilizce fiyat biçimlerini çözer', () => {
  assert.equal(normalizePrice('1.250.000 TL'), '1250000');
  assert.equal(normalizePrice('215,000.00 USD'), '215000');
  assert.equal(normalizePrice('₺21.500,50'), '21500.5');
  assert.equal(normalizePrice(215000), '215000');
  assert.equal(normalizePrice('fiyat yok'), null);
  assert.equal(normalizePrice(0), null);
});

test('fetchListingPreview: HTML ve fotoğrafları indirir, base64 döndürür', async () => {
  const html = `<html><head>
    <meta property="og:title" content="Test İlanı">
    <meta property="og:description" content="Açıklama">
    <meta property="product:price:amount" content="215.000">
    <meta property="og:image" content="/img/a.jpg">
    <meta property="og:image" content="/img/b.jpg">
  </head><body></body></html>`;

  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === 'https://www.example.com/ilan/1') return htmlResponse(html);
    if (/\/img\/[ab]\.jpg$/.test(url)) return imageResponse();
    return new Response('yok', { status: 404 });
  };

  const preview = await fetchListingPreview('https://www.example.com/ilan/1', {
    fetchImpl,
    lookupImpl: PUBLIC_LOOKUP
  });

  assert.equal(preview.title, 'Test İlanı');
  assert.equal(preview.description, 'Açıklama');
  assert.equal(preview.price, '215000');
  assert.equal(preview.sourceHost, 'www.example.com');
  assert.equal(preview.images.length, 2);
  assert.equal(preview.images[0].mimeType, 'image/jpeg');
  assert.equal(Buffer.from(preview.images[0].data, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.deepEqual(preview.warnings, []);
  assert.equal(calls.length, 3);
});

test('fetchListingPreview: desteklenmeyen görseli atlar ve uyarı döner', async () => {
  const html = `<html><head>
    <meta property="og:title" content="Başlık">
    <meta property="og:image" content="/img/a.jpg">
  </head><body></body></html>`;

  const fetchImpl = async url => {
    if (url.endsWith('.jpg')) return htmlResponse('bu bir görsel değil');
    return htmlResponse(html);
  };

  const preview = await fetchListingPreview('https://www.example.com/ilan/1', {
    fetchImpl,
    lookupImpl: PUBLIC_LOOKUP
  });

  assert.equal(preview.images.length, 0);
  assert.ok(preview.warnings.some(w => /desteklenmeyen formatta/.test(w)));
  assert.ok(preview.warnings.some(w => /indirilebilir fotoğraf bulunamadı/.test(w)));
});

test('fetchListingPreview: HTML olmayan içeriği UNSUPPORTED_CONTENT ile reddeder', async () => {
  const fetchImpl = async () =>
    new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    () => fetchListingPreview('https://www.example.com/api/1', { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    isListingError('UNSUPPORTED_CONTENT')
  );
});

test('fetchListingPreview: özel ağa çözümlenen DNS yanıtını engeller', async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return htmlResponse('<html><head><title>x</title></head></html>');
  };

  await assert.rejects(
    () =>
      fetchListingPreview('https://www.example.com/ilan/1', {
        fetchImpl,
        lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }]
      }),
    isListingError('LISTING_BLOCKED')
  );
  assert.equal(fetched, false);
});

test('fetchListingPreview: özel ağa yönlendirmeyi engeller', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/gizli' }
    });
  };

  await assert.rejects(
    () => fetchListingPreview('https://www.example.com/ilan/1', { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    isListingError('LISTING_BLOCKED')
  );
  assert.equal(calls, 1);
});

test('fetchListingPreview: okunabilir ilan verisi yoksa LISTING_EMPTY döner', async () => {
  const fetchImpl = async () =>
    htmlResponse('<html><head></head><body><p>Access denied</p></body></html>');

  await assert.rejects(
    () => fetchListingPreview('https://www.example.com/ilan/1', { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    isListingError('LISTING_EMPTY')
  );
});

test('fetchListingPreview: en fazla 8 fotoğraf alır', async () => {
  const html = `<html><head><meta property="og:title" content="Başlık">${Array.from(
    { length: 10 },
    (_, i) => `<meta property="og:image" content="/img/${i}.jpg">`
  ).join('')}</head><body></body></html>`;

  const fetchImpl = async url => {
    if (/\/img\/\d+\.jpg$/.test(url)) return imageResponse();
    return htmlResponse(html);
  };

  const preview = await fetchListingPreview('https://www.example.com/ilan/1', {
    fetchImpl,
    lookupImpl: PUBLIC_LOOKUP
  });

  assert.equal(preview.images.length, 8);
  assert.ok(preview.warnings.some(w => /en fazla 8 tanesi alındı/.test(w)));
});

test('fetchListingPreview: 2 MB üzeri HTML yanıtını reddeder', async () => {
  const bigHtml =
    '<html><head><title>Büyük sayfa</title></head><body>' +
    'a'.repeat(2 * 1024 * 1024) +
    '</body></html>';

  const fetchImpl = async () => htmlResponse(bigHtml);

  await assert.rejects(
    () => fetchListingPreview('https://www.example.com/ilan/1', { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    isListingError('LISTING_TOO_LARGE')
  );
});

test('fetchListingPreview: geçersiz protokolü doğrulama hatasıyla reddeder', async () => {
  await assert.rejects(
    () => fetchListingPreview('ftp://www.example.com/ilan/1', { fetchImpl: async () => {} }),
    isListingError('VALIDATION_ERROR')
  );
});
