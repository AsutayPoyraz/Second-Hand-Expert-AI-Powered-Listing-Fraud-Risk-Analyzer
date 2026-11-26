'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const { buildSystemInstruction, buildFollowupInstruction, buildFollowupQuestion, buildUserParts } = require('./promptBuilder');
const { GEMINI_RESPONSE_SCHEMA, FOLLOWUP_RESPONSE_SCHEMA, validateReport } = require('../utils/reportSchema');
const { sanitizeModelText, ANSWER_FALLBACK } = require('../utils/textSanitizer');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS_URL = `${GEMINI_BASE_URL}/models`;
const MODEL_LIST_TTL_MS = 10 * 60 * 1000;

class GeminiApiError extends Error {
  constructor(message, { status, code, retriable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status || 502;
    this.code = code || 'GEMINI_ERROR';
    this.retriable = retriable;
    this.retryAfterMs = retryAfterMs;
  }
}

function userAbortError(message = 'İşlem kullanıcı tarafından iptal edildi.') {
  return Object.assign(new Error(message), { name: 'UserAbortError', code: 'CANCELLED' });
}

function isUserAbort(err) {
  return Boolean(err && (err.name === 'UserAbortError' || err.code === 'CANCELLED'));
}

/**
 * İptal edilebilir bekleme. Listener her durumda temizlenir (sızıntı yok).
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(userAbortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(userAbortError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 30_000));
  return 0;
}

function remainingMs(deadline) {
  return deadline - Date.now();
}

function deadlineError(code, message) {
  return new GeminiApiError(message, { status: 504, code, retriable: false });
}

/**
 * Tek bir generateContent çağrısı. Zaman aşımı ve dış abort sinyalini birleştirir.
 */
async function callGemini({
  apiKey,
  model,
  systemInstruction,
  contents,
  tools,
  signal,
  temperature = 0.3,
  responseSchema = GEMINI_RESPONSE_SCHEMA,
  maxOutputTokens = 16384,
  timeoutMs = config.geminiTimeoutMs
}) {
  if (!apiKey) {
    throw new GeminiApiError(
      'Gemini API anahtarı sunucuda tanımlı değil. Arayüzdeki "Gemini API anahtarı" kartından anahtarınızı girip kaydedin.',
      { status: 500, code: 'MISSING_API_KEY' }
    );
  }

  // İş/yanıt deadline'ı kalan süreden daha uzun olamaz; aksi hâlde job timeout
  // denemeler bitmeden devreye girip yarım kalmış çağrılar bırakır.
  const requested = Number(timeoutMs);
  const effectiveTimeout = Math.max(
    1000,
    Math.min(config.geminiTimeoutMs, Number.isFinite(requested) ? requested : config.geminiTimeoutMs)
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema
      }
    };
    if (Array.isArray(tools) && tools.length > 0) body.tools = tools;

    const res = await fetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body)
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // gövde JSON değil
    }

    if (!res.ok) {
      const apiMsg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      const safeMsg = sanitizeUpstreamMessage(apiMsg);
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      // Google geçersiz anahtarı bazen 400 olarak döndürür; mesaja da bakıyoruz.
      const looksLikeInvalidKey = /api key not valid|api_key_invalid|invalid api key/i.test(apiMsg);

      if (res.status === 401 || res.status === 403 || looksLikeInvalidKey) {
        throw new GeminiApiError(
          'Gemini API anahtarı geçersiz veya yetkisiz. Arayüzdeki "Gemini API anahtarı" kartından anahtarı kontrol edin veya güncelleyin.',
          { status: 401, code: 'INVALID_API_KEY' }
        );
      }
      if (res.status === 400) {
        throw new GeminiApiError('Gemini isteği geçersiz: ' + safeMsg, { status: 400, code: 'BAD_REQUEST' });
      }
      if (res.status === 404) {
        throw new GeminiApiError(`Belirtilen model bulunamadı: ${model}`, { status: 404, code: 'MODEL_NOT_FOUND' });
      }
      if (res.status === 429) {
        throw new GeminiApiError(
          'Gemini API kota/istek sınırına ulaşıldı (429).',
          { status: 429, code: 'RATE_LIMITED', retriable: true, retryAfterMs }
        );
      }
      if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
        throw new GeminiApiError(
          `Gemini sunucusunda geçici bir sorun oluştu (${res.status}).`,
          { status: res.status, code: 'UPSTREAM_UNAVAILABLE', retriable: true, retryAfterMs }
        );
      }
      throw new GeminiApiError('Gemini API hatası: ' + safeMsg, { status: res.status, code: 'UNKNOWN_UPSTREAM_ERROR' });
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      if (signal && signal.aborted) throw userAbortError();
      throw new GeminiApiError(
        `Gemini isteği zaman aşımına uğradı (${Math.round(effectiveTimeout / 1000)} sn).`,
        { status: 504, code: 'TIMEOUT', retriable: true }
      );
    }
    if (err instanceof GeminiApiError) throw err;
    if (isUserAbort(err)) throw err;
    throw new GeminiApiError('Gemini bağlantı hatası: ' + err.message, {
      status: 502,
      code: 'NETWORK_ERROR',
      retriable: true
    });
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Yukarı akış (Google) mesajlarından olası anahtar/parola parçalarını maskeler.
 * Google'ın yeni "AQ." ile başlayan anahtar biçimi de kapsanır.
 */
function sanitizeUpstreamMessage(msg) {
  if (typeof msg !== 'string') return 'bilinmeyen hata';
  return msg
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[GİZLİ]')
    .replace(/AQ\.[0-9A-Za-z_.-]{8,}/g, '[GİZLİ]')
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1[GİZLİ]')
    .replace(/\bkey[=:]\s*[0-9A-Za-z_.-]{12,}/gi, 'key=[GİZLİ]');
}

function extractCandidateOrThrow(data) {
  if (data && data.promptFeedback && data.promptFeedback.blockReason) {
    throw new GeminiApiError(
      'İstek güvenlik filtresi tarafından engellendi: ' + data.promptFeedback.blockReason,
      { status: 422, code: 'BLOCKED' }
    );
  }
  const cand = ((data && data.candidates) || [])[0];
  if (!cand) {
    throw new GeminiApiError('Gemini boş yanıt döndürdü. Lütfen tekrar deneyin.', {
      status: 502,
      code: 'EMPTY_RESPONSE',
      retriable: true
    });
  }
  const finishReason = cand.finishReason;
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
    throw new GeminiApiError('Yanıt güvenlik politikası nedeniyle engellendi (' + finishReason + ').', {
      status: 422,
      code: 'SAFETY_BLOCKED'
    });
  }
  if (finishReason === 'MAX_TOKENS') {
    throw new GeminiApiError(
      'Model yanıtı token sınırına takıldı ve tamamlanamadı. Daha az fotoğrafla veya daha kısa açıklamayla tekrar deneyin.',
      { status: 502, code: 'MAX_TOKENS', retriable: false }
    );
  }
  if (!cand.content || !Array.isArray(cand.content.parts) || cand.content.parts.length === 0) {
    throw new GeminiApiError(
      'Model içerik üretemedi' + (finishReason ? ` (${finishReason})` : '') + '.',
      { status: 502, code: 'NO_CONTENT', retriable: true }
    );
  }
  return cand;
}

function candidateText(cand) {
  return cand.content.parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('\n');
}

function parseJsonResponse(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new GeminiApiError('Model yanıtı boş.', { status: 502, code: 'JSON_PARSE_ERROR' });
  }
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b < a) {
      throw new GeminiApiError('Model yanıtında JSON bulunamadı.', { status: 502, code: 'JSON_PARSE_ERROR' });
    }
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch {
      throw new GeminiApiError('Model yanıtı geçerli JSON değil.', { status: 502, code: 'JSON_PARSE_ERROR' });
    }
  }
}

function buildRepairContents(contents, rawText, errors) {
  return [
    ...contents,
    { role: 'model', parts: [{ text: rawText }] },
    {
      role: 'user',
      parts: [
        {
          text:
            'Yukarıdaki JSON yanıtın şemaya uymuyor. Aşağıdaki sorunları düzelt ve SADECE düzeltilmiş JSON nesnesini döndür:\n' +
            errors.map(e => `- ${e}`).join('\n') +
            '\nYeni bilgi uydurma; yalnızca eksik/hatalı alanları şemaya uygun hâle getir.'
        }
      ]
    }
  ];
}

/**
 * Tam analiz akışı: prompt kurar, Gemini'yi çağırır (sınırlı retry),
 * şema hatasında bir kez onarım denemesi yapar, sonucu doğrular.
 */
async function runAnalysis({ apiKey, model, category, name, price, year, km, url, desc, images, signal, onProgress }) {
  const progress = stage => onProgress && onProgress(stage);

  progress('prepare');
  const systemInstruction = buildSystemInstruction(category);
  const requestDate = new Date().toLocaleDateString('tr-TR');
  const contents = [{ role: 'user', parts: buildUserParts({ category, name, price, year, km, url, desc, images, requestDate }) }];

  const tools = [];
  if (config.searchEnabled) {
    tools.push({ google_search: {} });
    if (url) tools.push({ url_context: {} });
  }
  let searchSkipped = !config.searchEnabled;
  let searchSkippedReason = config.searchEnabled ? null : 'Arama, sunucu yapılandırmasında (GEMINI_SEARCH_ENABLED=false) kapalı.';

  progress('requesting');

  // İşin toplam süresinden küçük bir pay bırak; onarım/retry'ler bu bütçeyi aşmasın.
  const deadline = Date.now() + config.jobTimeoutMs - 5000;
  let lastErr = null;
  let data = null;

  for (let attempt = 0; attempt <= config.geminiMaxRetries; attempt++) {
    if (signal && signal.aborted) throw userAbortError();
    const remaining = remainingMs(deadline);
    if (remaining <= 1000) {
      throw deadlineError(
        'ANALYSIS_TIMEOUT',
        'Analiz, iş zaman aşımına yaklaştığı için tamamlanamadı. Daha az fotoğrafla tekrar deneyin.'
      );
    }
    try {
      data = await callGemini({ apiKey, model, systemInstruction, contents, tools, signal, timeoutMs: remaining });
      lastErr = null;
      break;
    } catch (err) {
      if (isUserAbort(err)) throw err;
      lastErr = err;

      // url_context desteklenmiyorsa (400) onsuz tekrar dene.
      if (err.code === 'BAD_REQUEST' && tools.length > 1 && attempt === 0) {
        tools.length = 1;
        continue;
      }

      // Arama/grounding kotası yoksa (429) arama araçlarını çıkarıp devam et.
      // Rapor "doğrulanmış piyasa verisi" gibi sunulmaz; kullanıcıya uyarı gösterilir.
      if (err.code === 'RATE_LIMITED' && tools.length > 0) {
        searchSkipped = true;
        searchSkippedReason =
          'Google araması (grounding) bu API anahtarı için kullanılamıyor (kota/plan). Analiz arama yapılmadan sürdürüldü.';
        tools.length = 0;
        progress('search_skipped');
        logger.warn({ job: true }, 'Arama kotası yok; analiz aramasız sürdürülüyor');
        continue;
      }

      if (err.retriable && attempt < config.geminiMaxRetries) {
        progress('retrying');
        const waitMs = Math.min(
          err.retryAfterMs || 1500 * (attempt + 1),
          Math.max(0, remainingMs(deadline) - 2000)
        );
        logger.warn({ code: err.code, attempt: attempt + 1, waitMs }, 'Gemini isteği yeniden denenecek');
        if (waitMs > 0) await sleep(waitMs, signal);
        continue;
      }
      throw err;
    }
  }
  if (lastErr) throw lastErr;
  if (!data) {
    throw new GeminiApiError('Gemini yanıtı alınamadı.', { status: 502, code: 'EMPTY_RESPONSE', retriable: true });
  }

  progress('processing');
  let cand = extractCandidateOrThrow(data);
  let rawText = candidateText(cand);
  let report = parseJsonResponse(rawText);

  progress('validating');
  let check = validateReport(report);

  // Şema hatasında tek bir onarım denemesi (kullanıcı 3 dakika beklemesin).
  if (!check.valid && config.geminiMaxRetries > 0) {
    const remaining = remainingMs(deadline);
    if (remaining <= 1000) {
      throw deadlineError(
        'ANALYSIS_TIMEOUT',
        'Analiz, iş zaman aşımına yaklaştığı için rapor onarılamadı. Daha az fotoğrafla tekrar deneyin.'
      );
    }
    progress('repairing');
    logger.info({ errors: check.errors }, 'Rapor şeması geçersiz; onarım denemesi yapılacak');
    const repairContents = buildRepairContents(contents, rawText, check.errors);
    data = await callGemini({
      apiKey,
      model,
      systemInstruction,
      contents: repairContents,
      signal,
      temperature: 0,
      timeoutMs: remaining
    });
    cand = extractCandidateOrThrow(data);
    rawText = candidateText(cand);
    report = parseJsonResponse(rawText);
    progress('validating');
    check = validateReport(report);
  }

  if (!check.valid) {
    throw new GeminiApiError(
      'Model yanıtı eksik veya hatalı alanlar içeriyor: ' + check.errors.join(' | '),
      { status: 502, code: 'INVALID_REPORT_SHAPE' }
    );
  }
  report = check.normalized;

  const groundingMeta = cand.groundingMetadata || {};
  const chunks = (groundingMeta.groundingChunks || []).map(c => c && c.web).filter(Boolean);
  const queries = (Array.isArray(groundingMeta.webSearchQueries) ? groundingMeta.webSearchQueries : [])
    .filter(q => typeof q === 'string' && q.trim())
    .map(q => q.trim().slice(0, 300))
    .slice(0, 10);
  const searchPerformed = chunks.length > 0 || queries.length > 0;

  // Arama yapılmadıysa piyasa verisinin "doğrulanmış" gibi sunulmasını engelle.
  // Emsal sayısı da sıfırlanır: model, arama yapmadığı hâlde emsal "uydurmuş" olabilir.
  if (!searchPerformed) {
    report.piyasa_verisi.yeterli_veri_var_mi = false;
    report.piyasa_verisi.emsal_sayisi = 0;
    const base = 'Bu analizde Google araması çalıştırılmadı ya da kaynak bulunamadı; piyasa verileri doğrulanmamış olarak değerlendirilmelidir.';
    report._arastirma_notu = searchSkippedReason ? `${searchSkippedReason} ${base}` : base;
  } else {
    // Kaynak döndüyse "arama yapılmadı" notu kaynak listesiyle çelişmesin.
    delete report._arastirma_notu;
  }

  progress('finalizing');

  // Kaynak linklerini tekilleştir, yalnızca http/https tut ve sayı/uzunluk sınırla.
  const seen = new Set();
  const sources = [];
  for (const c of chunks) {
    if (sources.length >= 20) break;
    if (!c || typeof c.uri !== 'string') continue;
    const uri = c.uri.trim();
    if (!/^https?:\/\//i.test(uri) || seen.has(uri)) continue;
    seen.add(uri);
    const title = typeof c.title === 'string' ? c.title.trim().slice(0, 300) : uri;
    sources.push({ uri: uri.slice(0, 2048), title: title || uri });
  }

  const usage = data && data.usageMetadata
    ? {
        promptTokens: data.usageMetadata.promptTokenCount || 0,
        outputTokens: data.usageMetadata.candidatesTokenCount || 0,
        totalTokens: data.usageMetadata.totalTokenCount || 0
      }
    : null;

  return {
    report,
    sources,
    queries,
    searchPerformed,
    searchSkipped,
    searchSkippedReason: searchSkipped ? searchSkippedReason : null,
    model,
    usage,
    photoCount: Array.isArray(images) ? images.length : 0
  };
}

/* ---------------- Takip soruları ---------------- */

const MAX_ANSWER_LEN = 4000;
const FOLLOWUP_HISTORY_TURNS = 3;

function cleanAnswer(raw) {
  if (typeof raw !== 'string') return '';
  const hadContent = raw.trim().length > 0;
  const s = sanitizeModelText(raw);
  // Yanıt tamamen özellik yokluğu mazeretinden oluşuyorsa kullanıcıyı boş
  // cevapla bırakma; elindeki verilerle sınırlı, dürüst bir yanıt ver.
  if (!s && hadContent) return ANSWER_FALLBACK;
  if (s.length <= MAX_ANSWER_LEN) return s;
  const cut = s.slice(0, MAX_ANSWER_LEN);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > MAX_ANSWER_LEN * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Takip turunda yeniden gönderilecek görselleri seçer.
 * - En fazla `config.followupImageLimit` adet
 * - Her biri en fazla `config.followupImageMaxBytes` base64 karakter
 * Böylece her soru neredeyse bir analiz maliyetine dönüşmez ve istek boyutu
 * Gemini'nin inline veri sınırına yaklaşmaz.
 */
function selectFollowupImages(images, limit = config.followupImageLimit, maxBytes = config.followupImageMaxBytes) {
  if (!Array.isArray(images) || limit <= 0) return [];
  return images
    .filter(im => im && typeof im.data === 'string' && im.data.length > 0 && im.data.length <= maxBytes)
    .slice(0, limit);
}

function buildFollowupContents(
  {
    category,
    name,
    price,
    year,
    km,
    url,
    desc,
    images,
    previousReport,
    history,
    question,
    photoCount,
    requestDate
  },
  historyTurns = FOLLOWUP_HISTORY_TURNS
) {
  const attached = Array.isArray(images) ? images.length : 0;
  const total = Number.isFinite(Number(photoCount)) ? Number(photoCount) : attached;
  const photoNote =
    attached < total
      ? `Not: İlk analizde ${total} fotoğraf incelendi; bu turda ${
          attached > 0 ? `yalnızca ${attached} fotoğraf yeniden gönderildi` : 'fotoğraflar yeniden gönderilmedi'
        }. Diğer fotoğraflara ilişkin bulgular önceki raporda korunuyor; onları yeniden görmüş gibi davranma.`
      : '';

  const baseParts = buildUserParts({
    category,
    name,
    price,
    year,
    km,
    url,
    desc,
    images,
    requestDate,
    photoCount: total,
    photoNote,
    allowUrlContext: false
  });

  const contents = [
    { role: 'user', parts: baseParts },
    { role: 'model', parts: [{ text: JSON.stringify({ cevap: 'İlk analiz tamamlandı.', rapor: previousReport }) }] }
  ];

  // Son birkaç turu taşımak yeterli; tüm geçmişi göndermek token israfı olur.
  const turns = Array.isArray(history) && historyTurns > 0 ? history.slice(-historyTurns) : [];
  for (const turn of turns) {
    contents.push({ role: 'user', parts: [{ text: buildFollowupQuestion(turn.question) }] });
    contents.push({
      role: 'model',
      parts: [{ text: JSON.stringify({ cevap: turn.answer, rapor: previousReport }) }]
    });
  }

  contents.push({ role: 'user', parts: [{ text: buildFollowupQuestion(question) }] });
  return contents;
}

/**
 * Tamamlanmış bir rapora takip sorusu sorar.
 * - Tek çağrıda hem kısa cevap hem güncellenmiş rapor istenir (iç içe şema).
 * - Takip turunda web araması YAPILMAZ (kota + gecikme); cevap mevcut kanıta dayanır.
 * - Yalnızca birkaç küçük fotoğraf ve kısa geçmiş gönderilir.
 * - JSON/MAX_TOKENS sorununda kısa geçmişle bir kez daha denenir.
 * - Rapor güncellenemezse cevap yine döner, `updated: false` olur (eski rapor korunur).
 *
 * @returns {{ answer: string, updated: boolean, report: object|null, usage: object|null, imagesSent: number }}
 */
async function runFollowup({
  apiKey,
  model,
  category,
  name,
  price,
  year,
  km,
  url,
  desc,
  images,
  photoCount = Array.isArray(images) ? images.length : 0,
  previousReport,
  searchPerformed = false,
  history = [],
  question,
  signal
}) {
  const systemInstruction = buildFollowupInstruction(category);
  const requestDate = new Date().toLocaleDateString('tr-TR');
  const deadline = Date.now() + config.followupTimeoutMs;
  const followupImages = selectFollowupImages(images);

  const buildContents = turns => {
    const out = buildFollowupContents(
      {
        category,
        name,
        price,
        year,
        km,
        url,
        desc,
        images: followupImages,
        previousReport,
        history,
        question,
        photoCount,
        requestDate
      },
      turns
    );
    return out;
  };

  let contents = buildContents(FOLLOWUP_HISTORY_TURNS);
  let shapeRetried = false;
  let transportAttempts = 0;

  for (;;) {
    if (signal && signal.aborted) throw userAbortError();

    const remaining = remainingMs(deadline);
    if (remaining <= 1000) {
      throw deadlineError('FOLLOWUP_TIMEOUT', 'Takip sorusu zaman aşımına uğradı. Lütfen tekrar deneyin.');
    }

    try {
      const data = await callGemini({
        apiKey,
        model,
        systemInstruction,
        contents,
        signal,
        temperature: 0.2,
        responseSchema: FOLLOWUP_RESPONSE_SCHEMA,
        maxOutputTokens: shapeRetried ? 16384 : 12288,
        timeoutMs: remaining
      });

      const cand = extractCandidateOrThrow(data);
      const parsed = parseJsonResponse(candidateText(cand));

      const answer = cleanAnswer(parsed && parsed.cevap);
      if (!answer) {
        throw new GeminiApiError('Model soruya bir yanıt üretemedi. Soruyu farklı biçimde tekrar deneyin.', {
          status: 502,
          code: 'EMPTY_ANSWER',
          retriable: true
        });
      }

      const check = validateReport(parsed && parsed.rapor);
      let report = null;

      if (check.valid) {
        report = check.normalized;

        // Arama durumu ilk analizden devralınır; takip turunda arama yapılmadı.
        if (!searchPerformed) {
          report.piyasa_verisi.yeterli_veri_var_mi = false;
          report.piyasa_verisi.emsal_sayisi = 0;
          if (previousReport && previousReport._arastirma_notu) {
            report._arastirma_notu = previousReport._arastirma_notu;
          }
        } else if (previousReport && previousReport._arastirma_notu) {
          report._arastirma_notu = previousReport._arastirma_notu;
        }
      }

      const usage = data && data.usageMetadata
        ? {
            promptTokens: data.usageMetadata.promptTokenCount || 0,
            outputTokens: data.usageMetadata.candidatesTokenCount || 0,
            totalTokens: data.usageMetadata.totalTokenCount || 0
          }
        : null;

      return { answer, updated: Boolean(report), report, usage, imagesSent: followupImages.length };
    } catch (err) {
      if (isUserAbort(err)) throw err;

      const shapeIssue = ['JSON_PARSE_ERROR', 'MAX_TOKENS', 'NO_CONTENT', 'EMPTY_RESPONSE', 'EMPTY_ANSWER'].includes(
        err.code
      );

      // Bozuk JSON / token taşması: kısa geçmiş ve daha yüksek token bütçesiyle bir kez tekrar dene.
      if (shapeIssue && !shapeRetried) {
        shapeRetried = true;
        contents = buildContents(0);
        logger.warn({ code: err.code }, 'Takip yanıtı şema/token sorunu; kısa geçmişle tekrar denenecek');
        continue;
      }

      if (err.retriable && transportAttempts < config.geminiMaxRetries) {
        const waitMs = Math.min(
          err.retryAfterMs || 1200 * (transportAttempts + 1),
          Math.max(0, remainingMs(deadline) - 2000)
        );
        transportAttempts += 1;
        if (waitMs > 0) await sleep(waitMs, signal);
        continue;
      }

      throw err;
    }
  }
}

/* ---------------- Dinamik model listesi ---------------- */

let modelCache = { at: 0, names: null, apiKey: '' };

function invalidateModelCache() {
  modelCache = { at: 0, names: null, apiKey: '' };
}

async function listAvailableModels(apiKey) {
  if (
    modelCache.names &&
    modelCache.apiKey === apiKey &&
    Date.now() - modelCache.at < MODEL_LIST_TTL_MS
  ) {
    return modelCache.names;
  }
  if (!apiKey) return null;

  try {
    const res = await fetch(`${MODELS_URL}?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const names = (data.models || [])
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
    if (names.length === 0) return null;
    modelCache = { at: Date.now(), names, apiKey };
    return names;
  } catch (err) {
    logger.warn({ err: err.message }, 'Dinamik model listesi alınamadı, yapılandırılmış liste kullanılacak');
    return null;
  }
}

module.exports = {
  runAnalysis,
  runFollowup,
  selectFollowupImages,
  listAvailableModels,
  invalidateModelCache,
  GeminiApiError,
  isUserAbort,
  sanitizeUpstreamMessage
};
