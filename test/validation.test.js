'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.GEMINI_ALLOWED_MODELS = process.env.GEMINI_ALLOWED_MODELS || 'gemini-3.5-flash,gemini-3.1-pro-preview';
process.env.DEFAULT_GEMINI_MODEL = process.env.DEFAULT_GEMINI_MODEL || 'gemini-3.5-flash';

const test = require('node:test');
const assert = require('node:assert/strict');

const v = require('../backend/utils/validation');

const JPEG_HEAD = '/9j/4AAQSkZJRgABAQAAAQABAAD'; // FFD8FF + JFIF

test('parseTurkishNumber: Türkçe biçimleri doğru ayrıştırır', () => {
  assert.equal(v.parseTurkishNumber('21.000'), 21000);
  assert.equal(v.parseTurkishNumber('21,5'), 21.5);
  assert.equal(v.parseTurkishNumber('21.000,50'), 21000.5);
  assert.equal(v.parseTurkishNumber('21000'), 21000);
  assert.equal(v.parseTurkishNumber(' 1 000 000 '), 1000000);
  assert.ok(Number.isNaN(v.parseTurkishNumber('abc')));
  assert.ok(Number.isNaN(v.parseTurkishNumber('')));
  assert.ok(Number.isNaN(v.parseTurkishNumber('12,34,56')));
});

test('validatePrice: sıfır/negatif/aşırı büyük reddedilir', () => {
  assert.equal(v.validatePrice('').ok, false);
  assert.equal(v.validatePrice('-5').ok, false);
  assert.equal(v.validatePrice('0').ok, false);
  assert.equal(v.validatePrice('9999999999').ok, false);
  assert.deepEqual(v.validatePrice('21.000'), { ok: true, value: 21000 });
});

test('validateUrl: yalnızca public http/https kabul edilir', () => {
  assert.equal(v.validateUrl('ftp://x.com').ok, false);
  assert.equal(v.validateUrl('javascript:alert(1)').ok, false);
  assert.equal(v.validateUrl('http://localhost:3000/x').ok, false);
  assert.equal(v.validateUrl('http://127.0.0.1/x').ok, false);
  assert.equal(v.validateUrl('http://192.168.1.5/x').ok, false);
  assert.equal(v.validateUrl('http://user:pass@example.com/x').ok, false);
  assert.equal(v.validateUrl('').ok, true);
  assert.equal(v.validateUrl('https://www.sahibinden.com/ilan/123').ok, true);
});

test('validateUrl: özel IPv6/CGNAT ve sondaki nokta kaçışları engellenir', () => {
  const blocked = [
    'http://localhost./x',
    'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://example/'
  ];
  for (const url of blocked) {
    assert.equal(v.validateUrl(url).ok, false, `${url} kabul edilmemeliydi`);
  }

  const allowed = [
    'https://www.sahibinden.com/ilan/123',
    'https://example.com/path?x=1',
    'http://sub.example.com.tr/'
  ];
  for (const url of allowed) {
    assert.equal(v.validateUrl(url).ok, true, `${url} reddedilmemeliydi`);
  }
});

test('validateYear / validateKm sınırları', () => {
  const current = new Date().getFullYear();
  assert.equal(v.validateYear('1949').ok, false);
  assert.equal(v.validateYear(String(current + 2)).ok, false);
  assert.equal(v.validateYear('2018').ok, true);
  assert.equal(v.validateKm('-1').ok, false);
  assert.equal(v.validateKm('2000001').ok, false);
  assert.equal(v.validateKm('145000').ok, true);
});

test('validateImages: sayı, tür, boyut ve sihirli bayt kontrolü', () => {
  assert.equal(v.validateImages([]).ok, true);

  const nine = Array.from({ length: 9 }, () => ({ mimeType: 'image/jpeg', data: JPEG_HEAD }));
  assert.equal(v.validateImages(nine).ok, false);

  assert.equal(v.validateImages([{ mimeType: 'image/gif', data: JPEG_HEAD }]).ok, false);
  assert.equal(v.validateImages([{ mimeType: 'image/jpeg', data: '' }]).ok, false);
  assert.equal(v.validateImages([{ mimeType: 'image/jpeg', data: 'data:image/jpeg;base64,' + JPEG_HEAD }]).ok, false);
  // JPEG başlığı taşımayan base64
  assert.equal(v.validateImages([{ mimeType: 'image/jpeg', data: 'AAAAAAAAAAAAAAAAAAAA' }]).ok, false);

  const ok = v.validateImages([{ mimeType: 'image/jpeg', data: JPEG_HEAD }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.length, 1);
});

test('validateModel: boş -> varsayılan, listede olmayan -> hata', () => {
  assert.equal(v.validateModel('').value, 'gemini-3.5-flash');
  assert.equal(v.validateModel(undefined).value, 'gemini-3.5-flash');
  assert.equal(v.validateModel('bad-model').ok, false);
  assert.equal(v.validateModel('gemini-3.1-pro-preview').value, 'gemini-3.1-pro-preview');
});

test('validateAnalyzeRequest: uçtan uca gövde doğrulaması', () => {
  const ok = v.validateAnalyzeRequest({
    category: 'vasita',
    name: 'Renault Clio 1.5 dCi',
    price: '21.000',
    year: 2018,
    km: 145000,
    url: 'https://www.sahibinden.com/ilan/1',
    desc: 'Temiz araç',
    images: []
  });
  assert.equal(ok.valid, true);
  assert.equal(ok.value.price, 21000);
  assert.equal(ok.value.model, 'gemini-3.5-flash');

  const missing = v.validateAnalyzeRequest({ category: 'vasita', price: '', name: '' });
  assert.equal(missing.valid, false);
  const fields = missing.errors.map(e => e.field);
  assert.ok(fields.includes('name'));
  assert.ok(fields.includes('price'));
  assert.ok(fields.includes('year'));
  assert.ok(fields.includes('km'));

  const badCat = v.validateAnalyzeRequest({ category: 'x', name: 'a', price: '1' });
  assert.equal(badCat.valid, false);

  // ikinciel kategorisinde yıl/km aranmaz
  const second = v.validateAnalyzeRequest({ category: 'ikinciel', name: 'iPhone 13', price: '15000' });
  assert.equal(second.valid, true);
  assert.equal(second.value.year, undefined);
});

test('validateQuestion: boş, uzun ve bozuk girdiler', () => {
  assert.equal(v.validateQuestion(undefined).ok, false);
  assert.equal(v.validateQuestion('   ').ok, false);
  assert.equal(v.validateQuestion('a'.repeat(1001)).ok, false);
  assert.equal(v.validateQuestion('Tramer var mı?').value, 'Tramer var mı?');
  // NUL karakterleri temizlenir.
  assert.equal(v.validateQuestion('a\u0000b').value, 'ab');
});

test('normalizeClientId: biçim kontrolü', () => {  assert.equal(v.normalizeClientId(undefined), null);
  assert.equal(v.normalizeClientId('kisa'), null);
  assert.equal(v.normalizeClientId('a'.repeat(200)), null);
  assert.ok(v.normalizeClientId('123e4567-e89b-12d3-a456-426614174000'));
});
