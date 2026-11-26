'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ieks-api-key-store-'));
// Tekil (singleton) örnek gerçek data dosyasına dokunmasın.
process.env.API_KEY_STORE_PATH = path.join(tempDir, 'singleton-never-used.json');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApiKeyStore,
  maskKey,
  normalizeUserKey
} = require('../backend/services/apiKeyStore');

const VALID_KEY = 'AIzaSyUnitTestKey1234567890abcdefghij';
const OTHER_KEY = 'AQ.UnitTestKey1234567890abcdefghijklmnop';

function storeFile(name) {
  return path.join(tempDir, `${name}.json`);
}

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('maskKey anahtarın tamamını göstermez', () => {
  const masked = maskKey(VALID_KEY);
  assert.equal(masked, 'AIza…ghij');
  assert.ok(!masked.includes(VALID_KEY));
  assert.equal(maskKey('kisa'), '••••');
  assert.equal(maskKey(''), '');
});

test('normalizeUserKey geçersiz biçimleri reddeder', () => {
  const bad = [null, '', '   ', 'kisa', 'anahtar bosluk iceriyor 1234567890', 'a'.repeat(401)];
  for (const value of bad) {
    assert.throws(
      () => normalizeUserKey(value),
      err => err && err.code === 'INVALID_API_KEY_FORMAT',
      `geçersiz değer kabul edildi: ${String(value).slice(0, 20)}`
    );
  }

  assert.equal(normalizeUserKey(`  ${VALID_KEY}  `), VALID_KEY);
  assert.equal(normalizeUserKey(OTHER_KEY), OTHER_KEY);
});

test('anahtar yokken durum none döner', () => {
  const store = createApiKeyStore({ filePath: storeFile('empty'), envKey: '' });
  assert.equal(store.getApiKey(), '');
  assert.deepEqual(store.getStatus(), {
    configured: false,
    source: 'none',
    masked: '',
    updatedAt: null,
    envFallback: false,
    canDelete: false
  });
});

test('anahtar kaydedilir, maskelenir ve yeniden başlatmada hatırlanır', async () => {
  const filePath = storeFile('persist');
  const store = createApiKeyStore({ filePath, envKey: '' });

  const status = await store.setApiKey(VALID_KEY);
  assert.equal(status.configured, true);
  assert.equal(status.source, 'stored');
  assert.equal(status.masked, 'AIza…ghij');
  assert.equal(status.canDelete, true);
  assert.ok(status.updatedAt);

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(raw.apiKey, VALID_KEY);
  assert.equal(raw.version, 1);

  // Yeni süreç/örnek aynı dosyadan anahtarı okur.
  const restarted = createApiKeyStore({ filePath, envKey: OTHER_KEY });
  assert.equal(restarted.getApiKey(), VALID_KEY);
  assert.equal(restarted.getStatus().source, 'stored');
  assert.equal(restarted.getStatus().envFallback, true);

  // Silinince .env yedeğine döner.
  const afterDelete = await restarted.clearApiKey();
  assert.equal(afterDelete.configured, true);
  assert.equal(afterDelete.source, 'env');
  assert.equal(afterDelete.canDelete, false);
  assert.equal(restarted.getApiKey(), OTHER_KEY);
  assert.equal(fs.existsSync(filePath), false);
});

test('env anahtarı yedek olarak kullanılır; dosyadaki anahtar önceliklidir', async () => {
  const filePath = storeFile('env-fallback');
  const store = createApiKeyStore({ filePath, envKey: OTHER_KEY });

  assert.equal(store.getApiKey(), OTHER_KEY);
  assert.equal(store.getStatus().source, 'env');
  assert.equal(store.getStatus().canDelete, false);

  await store.setApiKey(VALID_KEY);
  assert.equal(store.getApiKey(), VALID_KEY);
  assert.equal(store.getStatus().source, 'stored');

  await store.clearApiKey();
  assert.equal(store.getApiKey(), OTHER_KEY);
});

test('bozuk depo dosyası yok sayılır ve anahtar sızdırmaz', () => {
  const filePath = storeFile('corrupt');
  fs.writeFileSync(filePath, '{ bozuk json', 'utf8');

  const warnings = [];
  const store = createApiKeyStore({
    filePath,
    envKey: '',
    log: { warn: (...args) => warnings.push(args) }
  });

  assert.equal(store.getStatus().configured, false);
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings).includes('bozuk json'));
});

test('testApiKey: geçerli, geçersiz, kota ve ağ hatalarını ayırır', async () => {
  const originalFetch = global.fetch;
  const filePath = storeFile('test-endpoint');
  const store = createApiKeyStore({ filePath, envKey: '' });

  try {
    global.fetch = async (url, opts) => {
      assert.match(String(url), /\/models\?pageSize=1$/);
      assert.equal(opts.headers['x-goog-api-key'], VALID_KEY);
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const ok = await store.testApiKey(VALID_KEY);
    assert.equal(ok.valid, true);
    assert.equal(ok.reason, 'OK');
    assert.ok(!JSON.stringify(ok).includes(VALID_KEY));

    global.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'API key not valid' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    const invalid = await store.testApiKey(VALID_KEY);
    assert.equal(invalid.valid, false);
    assert.equal(invalid.reason, 'INVALID_API_KEY');
    assert.ok(!JSON.stringify(invalid).includes(VALID_KEY));

    global.fetch = async () => new Response('{}', { status: 429 });
    const quota = await store.testApiKey(VALID_KEY);
    assert.equal(quota.valid, true);
    assert.equal(quota.reason, 'QUOTA_LIMITED');

    global.fetch = async () => {
      throw new Error('ağ yok');
    };
    const unreachable = await store.testApiKey(VALID_KEY);
    assert.equal(unreachable.valid, null);
    assert.equal(unreachable.reason, 'UNREACHABLE');

    const missing = await store.testApiKey();
    assert.equal(missing.valid, false);
    assert.equal(missing.reason, 'MISSING_API_KEY');
  } finally {
    global.fetch = originalFetch;
  }
});
