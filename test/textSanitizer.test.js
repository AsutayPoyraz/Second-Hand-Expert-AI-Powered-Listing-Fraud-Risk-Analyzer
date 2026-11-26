'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeModelText,
  stripForeignScripts,
  isUnsupportedFeatureClaim,
  SUMMARY_FALLBACK
} = require('../backend/utils/textSanitizer');
const { validateReport } = require('../backend/utils/reportSchema');

const EXCUSE =
  'Sistemimizde ilan linklerini canlı tarama ve fotoğrafları otomatik çekme özelliği ' +
  'bu aşamada aktif değildir; bu nedenle ilan linki üzerinden görseller çekilemez.';

test('sanitizeModelText: özellik yokluğu mazeretini tamamen kaldırır', () => {
  assert.equal(sanitizeModelText(EXCUSE), '');
  assert.equal(isUnsupportedFeatureClaim(EXCUSE), true);
});

test('sanitizeModelText: mazereti ayıklar, yararlı cümleleri korur', () => {
  const input =
    'İlan açıklaması ve 3 fotoğraf incelendi. ' +
    EXCUSE +
    ' Ön tamponda sol tarafta çizik var.';
  const cleaned = sanitizeModelText(input);

  assert.equal(cleaned, 'İlan açıklaması ve 3 fotoğraf incelendi. Ön tamponda sol tarafta çizik var.');
  assert.doesNotMatch(cleaned, /canlı tarama|aktif değildir|çekilemez/i);
});

test('sanitizeModelText: farklı mazeret kalıplarını yakalar', () => {
  const variants = [
    'Sistemde otomatik fotoğraf çekme özelliği mevcut değildir.',
    'İlan linki üzerinden fotoğraf alamıyorum.',
    'Görselleri inceleyemiyorum.',
    'Sistemimizde canlı tarama olmadığı için görselleri çekemedim.',
    'Fotoğrafları otomatik çekme özelliği olmadığından ilan linkindeki görselleri göremedim.',
    'Live listing scanning is not available.',
    'We cannot fetch images from the listing link.'
  ];

  for (const variant of variants) {
    assert.equal(sanitizeModelText(variant), '', variant);
  }
});

test('sanitizeModelText: virgülle bağlanmış mazereti ayıklar, bulguyu korur', () => {
  const input =
    'Sistemimizde canlı tarama yok, bu nedenle görseller çekilemez, ' +
    'ancak ilan açıklamasında hasar kaydı belirtilmemiş.';
  assert.equal(sanitizeModelText(input), 'İlan açıklamasında hasar kaydı belirtilmemiş.');
});

test('sanitizeModelText: normal cümleye dokunmaz', () => {
  const input = 'Motor bakımlı görünüyor; ancak servis faturası istenmeli.';
  assert.equal(sanitizeModelText(input), input);
});

test('stripForeignScripts: Tayca/Çince/Kiril/Arapça kelimeleri atar', () => {
  assert.equal(stripForeignScripts('Bu adขั้นตอนda ilan incelendi').trim(), 'Bu ilan incelendi');
  assert.equal(stripForeignScripts('Motor проверка temiz').trim(), 'Motor temiz');
  assert.equal(stripForeignScripts('Fiyat 测试 uygun').trim(), 'Fiyat uygun');
  assert.equal(stripForeignScripts('Araç حالة iyi').trim(), 'Araç iyi');
});

test('sanitizeModelText: Türkçe harfleri ve emojiyi korur', () => {
  const input = 'Çığlık değil; ışık, ölçüm, şüpheli ✅';
  assert.equal(sanitizeModelText(input), input);
});

test('validateReport: yalnızca mazeretten oluşan özet yerine tarafsız özet kullanılır', () => {
  const report = {
    analiz_ozeti_dusunceler: EXCUSE,
    urun_tam_adi: 'Renault Clio 1.5 dCi 2018',
    piyasa_verisi: {
      ilan_fiyati: '215000',
      emsal_sayisi: 0,
      ortalama_ikinci_el_araligi: 'bilinmiyor',
      fiyat_durumu: 'Normal',
      yeterli_veri_var_mi: false
    },
    tespit_edilen_kusurlar_ve_kor_noktalar: ['Motor fotoğrafı yok.'],
    metin_celiskileri_ve_kronik_riskler: ['Hasar kaydı sorulmamış.'],
    saticiya_sorulacak_kanit_sorulari: ['a?', 'b?', 'c?', 'd?', 'e?'],
    nihai_karar: { durum: 'TEST EDİLEREK ALINABİLİR', puan: '6/10', tek_cumlelik_hukum: 'Servis kaydı istenmeli.' }
  };

  const result = validateReport(report);
  assert.equal(result.valid, true);
  assert.equal(result.normalized.analiz_ozeti_dusunceler, SUMMARY_FALLBACK);
  assert.doesNotMatch(result.normalized.analiz_ozeti_dusunceler, /tarama|çekilemez/i);
});

test('validateReport: rapor alanlarındaki yabancı alfabe karakterlerini temizler', () => {
  const report = {
    analiz_ozeti_dusunceler: 'Araç genel olarak temiz görünüyor 测试.',
    urun_tam_adi: 'BMW 520i 步骤',
    piyasa_verisi: {
      ilan_fiyati: '3725000',
      emsal_sayisi: 3,
      ortalama_ikinci_el_araligi: '3.600.000 - 3.900.000 TL',
      fiyat_durumu: 'Normal',
      yeterli_veri_var_mi: true
    },
    tespit_edilen_kusurlar_ve_kor_noktalar: ['Sol kapıda проверка boya var.'],
    metin_celiskileri_ve_kronik_riskler: ['“Kusursuz” denmiş.'],
    saticiya_sorulacak_kanit_sorulari: ['a?', 'b?', 'c?', 'd?', 'e?'],
    nihai_karar: { durum: 'YÜKSEK RİSKLİ', puan: '4/10', tek_cumlelik_hukum: 'Kanıt olmadan alınmaz.' }
  };

  const result = validateReport(report);
  assert.equal(result.valid, true);
  assert.doesNotMatch(JSON.stringify(result.normalized), /[\u3000-\u9FFF\u0400-\u04FF]/u);
  assert.match(result.normalized.analiz_ozeti_dusunceler, /Araç genel olarak temiz görünüyor/);
  assert.match(result.normalized.tespit_edilen_kusurlar_ve_kor_noktalar[0], /Sol kapıda boya var/);
});
