'use strict';

/*
 * ESLint'in no-misleading-character-class kuralı, yazı sistemi aralıklarını
 * (özellikle birleşik işaretler ve emoji bileşenleri) yanlış pozitif olarak
 * işaretliyor. Burada amaç harf oluşturmak değil, Latin dışı aralıkları
 * güvenli biçimde eşleştirmek.
 */
/* eslint-disable no-misleading-character-class */

/**
 * Model çıktısı için deterministik metin temizliği.
 *
 * Prompt kuralları tek başına yeterli değildir: model bazen "sistemde canlı
 * tarama / otomatik fotoğraf çekme yok" mazeretini üretmeye devam ediyor ve
 * Türkçe dışı alfabelerden karakter sızdırabiliyor. Bu katman, rapor
 * kullanıcıya gösterilmeden önce:
 *
 * 1. Özellik yokluğu mazereti içeren cümle/yan cümleleri kaldırır.
 * 2. Latin dışı alfabe (Tayca, Çince, Arapça, Kiril vb.) içeren kelimeleri atar.
 * 3. Boşluk ve noktalama artıklarını toparlar.
 *
 * Amaç içerik uydurmak değil; yanlış bir özellik algısını ve bozuk karakterleri
 * kullanıcıya hiç ulaştırmamaktır.
 */

const SUMMARY_FALLBACK =
  'İlan bilgileri ve fotoğraflar incelendi; bulgular aşağıdaki bölümlerde özetlenmiştir.';
const ANSWER_FALLBACK =
  'Elimdeki ilan bilgileri ve fotoğraflar bu soruya kesin bir yanıt vermeye yetmiyor; satıcıdan doğrudan bilgi ve belge isteyin.';

// Latin dışı yazı sistemleri. Latin genişletilmiş harfler (ı, ğ, ş, â, é…)
// kapsam dışıdır ve korunur; emoji/simge aralıkları da korunur.
const FOREIGN_SCRIPT_RANGES =
  /[\u0370-\u03FF\u0400-\u052F\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u0900-\u0DFF\u0E00-\u0E7F\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1100-\u11FF\u1200-\u139F\u13A0-\u13FF\u1400-\u167F\u1680-\u169F\u16A0-\u16FF\u1700-\u17FF\u1800-\u18AF\u1900-\u1C7F\u1C80-\u1C8F\u1D00-\u1D7F\u1DC0-\u1DFF\u2C00-\u2DFF\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3100-\u31FF\u3200-\u4DBF\u4DC0-\u4DFF\u4E00-\u9FFF\uA000-\uA4CF\uA500-\uA63F\uA640-\uA69F\uA6A0-\uA6FF\uA700-\uA7FF\uA800-\uA82F\uA840-\uA87F\uA880-\uA8DF\uA900-\uA92F\uA930-\uA95F\uA960-\uA97F\uA980-\uA9DF\uAA00-\uAA5F\uAA60-\uAA7F\uAA80-\uAADF\uAB00-\uAB2F\uAC00-\uD7AF\uF900-\uFAFF\uFB00-\uFB4F\uFB50-\uFDFF\uFE30-\uFE6F\uFE70-\uFEFF\uFF00-\uFFEF]/u;

const TOKEN_WITH_FOREIGN_SCRIPT = new RegExp(
  `\\S*${FOREIGN_SCRIPT_RANGES.source}\\S*`,
  'gu'
);

const FEATURE_RE =
  /(canl[ıi]\s+tarama|ilan\s+link(?:i|lerini)?\s+tarama|link(?:lerini)?\s+tarama|otomatik\s+(?:foto[ğg]raf|g[öo]rsel)\s+[çc]ekme|foto[ğg]raf(?:lar[ıi])?\s+otomatik\s+[çc]ekme|g[öo]rsel(?:ler[ıi])?\s+otomatik\s+[çc]ekme|foto[ğg]raf\s+[çc]ekme|g[öo]rsel\s+[çc]ekme|g[öo]rsel\s+getirme)/iu;

const NEGATIVE_RE =
  /(aktif\s+de[ğg]il|mevcut\s+de[ğg]il|s[öo]z\s+konusu\s+de[ğg]il|kullan[ıi]lam[ıi]yor|kullan[ıi]lm[ıi]yor|kullan[ıi]lmad[ıi][ğg][ıi]|desteklenmiyor|desteklenmedi[ğg][ıi]|sunulmuyor|sunulmamaktadır|m[üu]mk[üu]n\s+de[ğg]il|bulunmuyor|bulunmamaktadır|bulunmad[ıi][ğg][ıi]|olmad[ıi][ğg][ıi]|yer\s+alm[ıi]yor|yer\s+almamaktadır|yap[ıi]lam[ıi]yor|yap[ıi]lamad[ıi]|devre\s+d[ıi][şs][ıi]|(?:^|\s)yok(?:\s|[.,;:!?]|$))/iu;

const DIRECT_UNAVAILABLE_RE =
  /(g[öo]rsel(?:ler)?|foto[ğg]raf(?:lar)?)[^.!?]{0,90}([çc]ekilemez|[çc]ekilemiyor|[çc]ekilememektedir|[çc]ekilemedi|[çc]ekemiyorum|[çc]ekemiyor|[çc]ekememektedir|[çc]ekemedim|[çc]ekemedi|alam[ıi]yorum|alam[ıi]yor|al[ıi]nam[ıi]yor|al[ıi]namad[ıi]|alamad[ıi]m|alamad[ıi]|eri[şs]emiyorum|eri[şs]ilemiyor|eri[şs]ilemedi|eri[şs]emedim|eri[şs]emedi|getirilemez|getirilemiyor|getiremiyorum|getiremedim|indirilemez|indirilemiyor|indiremiyorum|indiremedim|g[öo]remiyorum|g[öo]remedim|inceleyemiyorum|inceleyemedim|g[öo]r[üu]nt[üu]leyemiyorum|g[öo]r[üu]nt[üu]leyemedim)/iu;

const LINK_UNAVAILABLE_RE =
  /(ilan\s+linki|link|url)[^.!?]{0,90}([çc]ekilemez|[çc]ekilemiyor|[çc]ekilemedi|alam[ıi]yorum|alamad[ıi]m|al[ıi]nam[ıi]yor|al[ıi]namad[ıi]|eri[şs]emiyorum|eri[şs]emedim|eri[şs]ilemiyor|eri[şs]ilemedi|getirilemez|getirilemiyor|getiremedim|indirilemez|indirilemiyor|indiremedim|g[öo]r[üu]nt[üu]leyemiyorum|g[öo]r[üu]nt[üu]leyemedim)/iu;

const ENGLISH_FEATURE_RE =
  /(live\s+(?:listing\s+)?scanning|automatic\s+(?:image|photo)\s+(?:fetching|downloading)|image\s+fetching|photo\s+fetching)[^.!?]{0,90}(not\s+(?:available|enabled|supported)|unavailable|disabled)/iu;

const ENGLISH_UNAVAILABLE_RE =
  /(cannot|can't|unable\s+to)\s+(?:fetch|download|retrieve|access)\s+(?:the\s+)?(?:images?|photos?)\s+from\s+(?:the\s+)?(?:listing|link|url)/iu;

/** Bir cümle/yan cümle, özellik yokluğu mazereti mi? */
function isUnsupportedFeatureClaim(clause) {
  if (!clause || !clause.trim()) return false;

  if (FEATURE_RE.test(clause) && NEGATIVE_RE.test(clause)) return true;
  if (DIRECT_UNAVAILABLE_RE.test(clause)) return true;
  if (LINK_UNAVAILABLE_RE.test(clause)) return true;
  if (ENGLISH_FEATURE_RE.test(clause)) return true;
  if (ENGLISH_UNAVAILABLE_RE.test(clause)) return true;

  // "bu aşamada aktif değildir" + tarama/görsel bağlamı.
  if (
    /bu\s+a[şs]amada/iu.test(clause) &&
    /(aktif\s+de[ğg]il|kullan[ıi]lam[ıi]yor|m[üu]mk[üu]n\s+de[ğg]il)/iu.test(clause) &&
    /(tarama|g[öo]rsel|foto[ğg]raf|link)/iu.test(clause)
  ) {
    return true;
  }

  return false;
}

function splitSentences(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[.!?…])\s+/)
    .filter(part => part.length > 0);
}

/** Noktalama ve boşluk artıklarını toparlar. */
function tidyText(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])\s*([.!?…])/g, '$2')
    .replace(/([.!?…])\1+/g, '$1')
    .replace(/^[\s,;:.\-–—]+/, '')
    .replace(/^(ancak|fakat|ama|bu nedenle|bu yüzden|dolayısıyla|çünkü)\s+([a-zçğıöşü])/iu, (_m, _conj, ch) =>
      ch.toLocaleUpperCase('tr-TR')
    )
    .replace(/[\s,;:]+$/, '')
    .replace(/\b(ancak|fakat|ama|bu nedenle|dolayısıyla)\s*$/iu, '')
    .trim();
}

/** Latin dışı alfabe içeren kelimeleri ve artık karakterleri kaldırır. */
function stripForeignScripts(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(TOKEN_WITH_FOREIGN_SCRIPT, ' ')
    .replace(new RegExp(FOREIGN_SCRIPT_RANGES.source, 'gu'), '')
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Özellik yokluğu mazeretini cümle/yan cümle düzeyinde kaldırır.
 * Cümle içindeki diğer yararlı bilgi korunur.
 */
function removeUnsupportedFeatureClaims(text) {
  if (typeof text !== 'string' || !text) return '';

  const keptSentences = [];

  for (const sentence of splitSentences(text)) {
    // Noktalı virgül ve bağlaç öncesi virgülden yan cümlelere ayır; böylece
    // mazeret ayıklanırken aynı cümledeki gerçek bulgu korunur.
    const clauses = sentence.split(
      /(?<=;)\s+|,\s+(?=(?:ancak|fakat|ama|bu\s+nedenle|bu\s+yüzden|dolayısıyla|çünkü)\s)/iu
    );
    const keptClauses = clauses.filter(clause => !isUnsupportedFeatureClaim(clause));

    if (keptClauses.length === clauses.length) {
      keptSentences.push(sentence);
      continue;
    }

    const rebuilt = tidyText(keptClauses.join(' '));
    if (rebuilt && !isUnsupportedFeatureClaim(rebuilt)) keptSentences.push(rebuilt);
  }

  return tidyText(keptSentences.join(' '));
}

/**
 * Model metnini güvenli biçimde temizler.
 * @param {unknown} value
 * @param {number} [maxLen] - Verilirse sonuç bu uzunlukta kesilir.
 * @returns {string}
 */
function sanitizeModelText(value, maxLen) {
  if (typeof value !== 'string') return '';

  let text = value.split('\u0000').join('');
  text = stripForeignScripts(text);
  text = removeUnsupportedFeatureClaims(text);
  text = tidyText(text);

  if (Number.isFinite(maxLen) && maxLen > 0) {
    text = text.slice(0, maxLen).trim();
  }
  return text;
}

module.exports = {
  sanitizeModelText,
  stripForeignScripts,
  removeUnsupportedFeatureClaims,
  isUnsupportedFeatureClaim,
  SUMMARY_FALLBACK,
  ANSWER_FALLBACK
};
