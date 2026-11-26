'use strict';

/**
 * Gemini'ye gönderilen responseSchema (structured output) ve gelen JSON'u
 * ikinci kez doğrulayan katman. Model yapılandırılmış çıktı desteklese bile
 * asla körü körüne güvenilmez.
 */

const { sanitizeModelText, SUMMARY_FALLBACK } = require('./textSanitizer');

const DECISION_OPTIONS = ['ALINMAZ', 'YÜKSEK RİSKLİ', 'TEST EDİLEREK ALINABİLİR', 'FIRSAT'];
const PRICE_STATUS_PREFIXES = ['Şüpheli Ucuz', 'Piyasa Altı', 'Normal', 'Piyasa Üstü'];

const MIN_QUESTIONS = 4;
const MAX_QUESTIONS = 6;
const MAX_LIST_ITEMS = 40;
const MAX_STRING_LEN = 4000;

const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    analiz_ozeti_dusunceler: { type: 'STRING' },
    urun_tam_adi: { type: 'STRING' },
    piyasa_verisi: {
      type: 'OBJECT',
      properties: {
        ilan_fiyati: { type: 'STRING' },
        emsal_sayisi: { type: 'INTEGER' },
        ortalama_ikinci_el_araligi: { type: 'STRING' },
        fiyat_durumu: { type: 'STRING' },
        yeterli_veri_var_mi: { type: 'BOOLEAN' }
      },
      required: ['ilan_fiyati', 'ortalama_ikinci_el_araligi', 'fiyat_durumu', 'yeterli_veri_var_mi']
    },
    tespit_edilen_kusurlar_ve_kor_noktalar: { type: 'ARRAY', items: { type: 'STRING' } },
    metin_celiskileri_ve_kronik_riskler: { type: 'ARRAY', items: { type: 'STRING' } },
    saticiya_sorulacak_kanit_sorulari: { type: 'ARRAY', items: { type: 'STRING' } },
    nihai_karar: {
      type: 'OBJECT',
      properties: {
        durum: { type: 'STRING', enum: DECISION_OPTIONS },
        puan: { type: 'STRING' },
        tek_cumlelik_hukum: { type: 'STRING' }
      },
      required: ['durum', 'puan', 'tek_cumlelik_hukum']
    }
  },
  required: [
    'analiz_ozeti_dusunceler',
    'urun_tam_adi',
    'piyasa_verisi',
    'tespit_edilen_kusurlar_ve_kor_noktalar',
    'metin_celiskileri_ve_kronik_riskler',
    'saticiya_sorulacak_kanit_sorulari',
    'nihai_karar'
  ]
};

/**
 * Takip sorusu yanıtı: kısa bir cevap + güncellenmiş tam rapor.
 * Aynı rapor şeması iç içe kullanılır; böylece tek çağrıda hem cevap
 * hem güncel rapor alınır ve rapor aynı doğrulayıcıdan geçer.
 */
const FOLLOWUP_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    cevap: { type: 'STRING' },
    rapor: GEMINI_RESPONSE_SCHEMA
  },
  required: ['cevap', 'rapor']
};

function isStringArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string');
}

function cleanString(v, maxLen = MAX_STRING_LEN) {
  return sanitizeModelText(v, maxLen);
}

function cleanList(v) {
  if (!Array.isArray(v)) return null;
  return v
    .filter(x => typeof x === 'string')
    .map(x => cleanString(x))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

/** "4/10", "4 / 10", "10 üzerinden 4" gibi biçimleri "4/10"a normalize eder. */
function normalizeScore(raw) {
  let n = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    n = Math.round(raw);
  } else if (typeof raw === 'string') {
    const s = raw.trim().replace(/\s+/g, ' ');
    const direct = s.match(/^(\d{1,2})\s*\/\s*10$/);
    const outOf = s.match(/^10\s*üzerinden\s*(\d{1,2})$/i);
    const bare = s.match(/^(\d{1,2})$/);
    if (direct) n = Number(direct[1]);
    else if (outOf) n = Number(outOf[1]);
    else if (bare) n = Number(bare[1]);
  }
  // Puan 0–10 aralığında olmalı; "15/10" gibi değerler raporu bozmamalı.
  if (!Number.isInteger(n) || n < 0 || n > 10) return null;
  return `${n}/10`;
}

/** Karar metnini büyük/küçük harf ve Türkçe i/İ farklarına dayanıklı eşler. */
function normalizeDecision(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr-TR');
  if (!s) return null;
  // "ALINMAZ DEĞİL" gibi olumsuzlama cümleleri yanlış sınıflanmasın.
  if (/\bDEĞİL\b/.test(s)) return null;
  const exact = DECISION_OPTIONS.find(opt => s === opt);
  if (exact) return exact;
  // Uzun seçenekler önce denenir: "TEST EDİLEREK ALINABİLİR", "ALINMAZ"dan önce eşleşmeli.
  const byLength = [...DECISION_OPTIONS].sort((a, b) => b.length - a.length);
  return byLength.find(opt => s.includes(opt)) || null;
}

/**
 * Serbest metinli fiyat durumunu 4 kanonik değerden birine eşler.
 * Model "Piyasa ortalamasının %40 altında (aşırı düşük)" gibi doğal bir cevap
 * verdiğinde gereksiz şema onarımı tetiklenmesini engeller.
 */
function normalizePriceStatus(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!s) return null;
  const lower = s.toLocaleLowerCase('tr-TR');

  const prefix = PRICE_STATUS_PREFIXES.find(p => lower.startsWith(p.toLocaleLowerCase('tr-TR')));
  if (prefix) return prefix;

  const has = (...words) => words.some(w => lower.includes(w));

  if (has('şüpheli', 'aşırı düşük', 'çok düşük', 'fırsat değil', 'dolandırıcılık', 'piyasanın çok altında')) {
    return 'Şüpheli Ucuz';
  }
  if (has('üstünde', 'üstü', 'üzerinde', 'yüksek', 'pahalı', 'abartılı', 'şişirilmiş')) {
    return 'Piyasa Üstü';
  }
  if (has('altında', 'altı', 'düşük', 'ucuz', 'indirimli')) {
    return 'Piyasa Altı';
  }
  if (has('normal', 'uygun', 'uyumlu', 'emsalinde', 'emsaline yakın', 'dengeli', 'makul', 'piyasa ile aynı')) {
    return 'Normal';
  }
  return null;
}

/**
 * Modelden gelen (parse edilmiş) JSON raporunu doğrular ve normalize eder.
 * Döndürür: { valid, errors[], normalized }
 */
function validateReport(d) {
  const errors = [];

  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    return { valid: false, errors: ['Model yanıtı bir JSON nesnesi değil.'], normalized: null };
  }

  // Özet yalnızca "canlı tarama yok / görsel çekilemez" mazeretinden oluşuyorsa
  // temizlik sonrası boş kalır. Bu durumda raporu düşürmek yerine gerçek
  // bulgulara yönlendiren tarafsız bir özet kullanılır.
  const rawSummary = typeof d.analiz_ozeti_dusunceler === 'string' ? d.analiz_ozeti_dusunceler.trim() : '';
  let summary = cleanString(d.analiz_ozeti_dusunceler);
  if (!summary && rawSummary) summary = SUMMARY_FALLBACK;
  if (!summary) errors.push('"analiz_ozeti_dusunceler" alanı eksik veya boş.');

  const productName = cleanString(d.urun_tam_adi, 200);
  if (!productName) errors.push('"urun_tam_adi" alanı eksik veya boş.');

  const p = d.piyasa_verisi;
  let market = null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    errors.push('"piyasa_verisi" alanı eksik.');
  } else {
    const priceStatus = normalizePriceStatus(p.fiyat_durumu);
    const range = cleanString(p.ortalama_ikinci_el_araligi, 300);
    const listingPrice = typeof p.ilan_fiyati === 'number' ? String(p.ilan_fiyati) : cleanString(p.ilan_fiyati, 100);

    if (!listingPrice) errors.push('"piyasa_verisi.ilan_fiyati" eksik.');
    if (!range) errors.push('"piyasa_verisi.ortalama_ikinci_el_araligi" eksik veya boş.');
    if (!priceStatus) {
      errors.push(
        `"piyasa_verisi.fiyat_durumu" beklenmeyen bir değer: "${cleanString(p.fiyat_durumu, 100)}". ` +
          `Şunlardan biriyle başlamalı: ${PRICE_STATUS_PREFIXES.join(', ')}.`
      );
    }

    market = {
      ilan_fiyati: listingPrice,
      emsal_sayisi:
        Number.isFinite(Number(p.emsal_sayisi)) && Number(p.emsal_sayisi) >= 0
          ? Math.min(10_000, Math.floor(Number(p.emsal_sayisi)))
          : 0,
      ortalama_ikinci_el_araligi: range,
      fiyat_durumu: priceStatus || '',
      yeterli_veri_var_mi: p.yeterli_veri_var_mi === true
    };
  }

  const flaws = cleanList(d.tespit_edilen_kusurlar_ve_kor_noktalar);
  if (flaws === null) errors.push('"tespit_edilen_kusurlar_ve_kor_noktalar" bir metin listesi olmalı.');

  const contradictions = cleanList(d.metin_celiskileri_ve_kronik_riskler);
  if (contradictions === null) errors.push('"metin_celiskileri_ve_kronik_riskler" bir metin listesi olmalı.');

  const rawQuestions = d.saticiya_sorulacak_kanit_sorulari;
  let questions = null;
  if (!isStringArray(rawQuestions)) {
    errors.push('"saticiya_sorulacak_kanit_sorulari" bir metin listesi olmalı.');
  } else {
    questions = cleanList(rawQuestions);
    if (questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
      errors.push(
        `"saticiya_sorulacak_kanit_sorulari" ${MIN_QUESTIONS}–${MAX_QUESTIONS} soru içermeli (gelen: ${questions.length}).`
      );
    }
  }

  const k = d.nihai_karar;
  let verdict = null;
  if (!k || typeof k !== 'object' || Array.isArray(k)) {
    errors.push('"nihai_karar" alanı eksik.');
  } else {
    const decision = normalizeDecision(k.durum);
    const score = normalizeScore(k.puan);
    const rawSentence = typeof k.tek_cumlelik_hukum === 'string' ? k.tek_cumlelik_hukum.trim() : '';
    let sentence = cleanString(k.tek_cumlelik_hukum);
    if (!sentence && rawSentence) {
      sentence = `Karar: ${decision || 'belirtilemedi'}, puan: ${score || 'belirtilemedi'}.`;
    }

    if (!decision) {
      errors.push(`"nihai_karar.durum" geçerli bir seçenek olmalı: ${DECISION_OPTIONS.join(' / ')}.`);
    }
    if (!score) errors.push('"nihai_karar.puan" 0–10 arasında "X/10" biçiminde olmalı (örn: "4/10").');
    if (!sentence) errors.push('"nihai_karar.tek_cumlelik_hukum" eksik veya boş.');

    verdict = { durum: decision || '', puan: score || '', tek_cumlelik_hukum: sentence };
  }

  if (errors.length > 0) return { valid: false, errors, normalized: null };

  return {
    valid: true,
    errors: [],
    normalized: {
      analiz_ozeti_dusunceler: summary,
      urun_tam_adi: productName,
      piyasa_verisi: market,
      tespit_edilen_kusurlar_ve_kor_noktalar: flaws,
      metin_celiskileri_ve_kronik_riskler: contradictions,
      saticiya_sorulacak_kanit_sorulari: questions,
      nihai_karar: verdict
    }
  };
}

module.exports = {
  GEMINI_RESPONSE_SCHEMA,
  FOLLOWUP_RESPONSE_SCHEMA,
  validateReport,
  normalizeScore,
  normalizeDecision,
  normalizePriceStatus,
  DECISION_OPTIONS,
  PRICE_STATUS_PREFIXES
};
