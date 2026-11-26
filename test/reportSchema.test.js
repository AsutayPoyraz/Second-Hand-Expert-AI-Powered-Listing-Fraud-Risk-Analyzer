'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateReport,
  normalizeScore,
  normalizePriceStatus,
  normalizeDecision,
  DECISION_OPTIONS
} = require('../backend/utils/reportSchema');

function baseReport() {
  return {
    analiz_ozeti_dusunceler: 'Araç fiyatı emsallerin altında; tramer sorgusu istenmeli.',
    urun_tam_adi: 'Renault Clio 1.5 dCi 2018',
    piyasa_verisi: {
      ilan_fiyati: '215.000 TL',
      emsal_sayisi: 6,
      ortalama_ikinci_el_araligi: '240.000 - 265.000 TL',
      fiyat_durumu: 'Şüpheli Ucuz (emsallerin %15 altı)',
      yeterli_veri_var_mi: true
    },
    tespit_edilen_kusurlar_ve_kor_noktalar: ['Motor bölmesi fotoğrafı yok.'],
    metin_celiskileri_ve_kronik_riskler: ['"Sorunsuz" denmesine rağmen hasar kaydı sorulmamış.'],
    saticiya_sorulacak_kanit_sorulari: ['1?', '2?', '3?', '4?', '5?'],
    nihai_karar: { durum: 'YÜKSEK RİSKLİ', puan: '4/10', tek_cumlelik_hukum: 'Kanıt gelmeden alınmaz.' }
  };
}

test('validateReport: geçerli rapor normalize edilir', () => {
  const r = validateReport(baseReport());
  assert.equal(r.valid, true);
  assert.equal(r.normalized.nihai_karar.puan, '4/10');
  assert.equal(r.normalized.piyasa_verisi.emsal_sayisi, 6);
});

test('validateReport: eksik alanlar hata listesi döndürür', () => {
  const r = validateReport({ urun_tam_adi: 'X' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length >= 5);
});

test('validateReport: büyük/küçük harf ve puan biçimine dayanıklı', () => {
  const rep = baseReport();
  rep.nihai_karar.durum = 'yüksek riskli';
  rep.nihai_karar.puan = '10 üzerinden 6';
  rep.piyasa_verisi.fiyat_durumu = 'piyasa altı';
  const r = validateReport(rep);
  assert.equal(r.valid, true);
  assert.equal(r.normalized.nihai_karar.durum, 'YÜKSEK RİSKLİ');
  assert.equal(r.normalized.nihai_karar.puan, '6/10');
});

test('validateReport: 4-6 soru aralığı kabul, dışı reddedilir', () => {
  const four = baseReport();
  four.saticiya_sorulacak_kanit_sorulari = ['a', 'b', 'c', 'd'];
  assert.equal(validateReport(four).valid, true);

  const seven = baseReport();
  seven.saticiya_sorulacak_kanit_sorulari = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.equal(validateReport(seven).valid, false);
});

test('validateReport: bilinmeyen karar reddedilir', () => {
  const rep = baseReport();
  rep.nihai_karar.durum = 'BELKİ ALINIR';
  assert.equal(validateReport(rep).valid, false);
  assert.ok(DECISION_OPTIONS.length === 4);
});

test('validateReport: boş/yönlü olmayan girdi güvenle reddedilir', () => {
  assert.equal(validateReport(null).valid, false);
  assert.equal(validateReport([]).valid, false);
  assert.equal(validateReport('metin').valid, false);
});

test('Puan 0–10 aralığı dışındaysa reddedilir', () => {
  const high = baseReport();
  high.nihai_karar.puan = '15/10';
  assert.equal(validateReport(high).valid, false);

  const veryHigh = baseReport();
  veryHigh.nihai_karar.puan = '99/10';
  assert.equal(validateReport(veryHigh).valid, false);

  assert.equal(normalizeScore('0/10'), '0/10');
  assert.equal(normalizeScore('10/10'), '10/10');
  assert.equal(normalizeScore('10 üzerinden 10'), '10/10');
  assert.equal(normalizeScore('11/10'), null);
  assert.equal(normalizeScore(-1), null);
});

test('Fiyat durumu serbest metinden kanonik değere eşlenir', () => {
  assert.equal(normalizePriceStatus('Piyasa ortalamasının %40 altında (aşırı düşük)'), 'Şüpheli Ucuz');
  assert.equal(normalizePriceStatus('emsallerin %18 altında'), 'Piyasa Altı');
  assert.equal(normalizePriceStatus('piyasa üstünde, şişirilmiş'), 'Piyasa Üstü');
  assert.equal(normalizePriceStatus('Normal seviyede'), 'Normal');
  assert.equal(normalizePriceStatus('bilinmeyen bir ifade'), null);

  const rep = baseReport();
  rep.piyasa_verisi.fiyat_durumu = 'Piyasa ortalamasının %40 altında (aşırı düşük)';
  const r = validateReport(rep);
  assert.equal(r.valid, true);
  assert.equal(r.normalized.piyasa_verisi.fiyat_durumu, 'Şüpheli Ucuz');
});

test('Karar normalizasyonu olumsuzlama içeren metni kabul etmez', () => {
  assert.equal(normalizeDecision('ALINMAZ DEĞİL'), null);
  assert.equal(normalizeDecision('YÜKSEK RİSKLİ DEĞİL'), null);
  assert.equal(normalizeDecision('test edilerek alınabilir'), 'TEST EDİLEREK ALINABİLİR');
});
