'use strict';

/* ================= Yardımcılar ================= */
const $ = id => document.getElementById(id);

function safeLocalStorageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeLocalStorageSet(key, val) {
  try { window.localStorage.setItem(key, val); return true; } catch { return false; }
}
function safeLocalStorageRemove(key) {
  try { window.localStorage.removeItem(key); } catch { /* yut */ }
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (key === 'ariaLabel') n.setAttribute('aria-label', value);
    else if (key === 'ariaLive') n.setAttribute('aria-live', value);
    else if (key === 'ariaHidden') n.setAttribute('aria-hidden', value);
    else if (key === 'role') n.setAttribute('role', value);
    else if (key === 'style' && typeof value === 'string') n.setAttribute('style', value);
    else n[key] = value;
  });
  if (kids.length) n.append(...kids);
  return n;
}
function list(items, ordered) {
  const l = el(ordered ? 'ol' : 'ul');
  (items || []).forEach(t => l.append(el('li', { textContent: String(t) })));
  if (!items || items.length === 0) {
    l.append(el('li', { textContent: 'Belirtilmedi.', style: 'color:var(--mut)' }));
  }
  return l;
}
function section(title, ...kids) {
  return el('div', { className: 'card' }, el('h3', { textContent: title }), ...kids);
}
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeExternalLink(href, text) {
  const a = el('a', { textContent: text || href, target: '_blank', rel: 'noopener noreferrer' });
  try {
    const u = new URL(href, window.location.href);
    if (u.protocol === 'http:' || u.protocol === 'https:') a.href = u.toString();
    else a.removeAttribute('target');
  } catch { /* geçersiz URL - href atanmaz */ }
  return a;
}

/* ================= İstemci kimliği ================= */
function getClientId() {
  let id = safeLocalStorageGet('ieks_client_id');
  if (!id || !/^[A-Za-z0-9._:-]{8,128}$/.test(id)) {
    id = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : 'c-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    safeLocalStorageSet('ieks_client_id', id);
  }
  return id;
}
const CLIENT_ID = getClientId();

/* ================= Genel hata yakalama ================= */
window.addEventListener('error', e => showErr('Beklenmeyen bir hata oluştu: ' + (e.message || 'bilinmiyor')));
window.addEventListener('unhandledrejection', e => {
  const reason = e.reason;
  showErr('Beklenmeyen bir hata oluştu: ' + (reason && reason.message ? reason.message : String(reason)));
});

function showStatus(t) {
  const s = $('status');
  s.className = 'status';
  s.textContent = t;
}
function showErr(t) {
  const s = $('status');
  s.className = 'status err';
  s.textContent = t;
}
function hideStatus() { $('status').classList.add('hide'); }

function showNote(node, text) {
  node.textContent = text;
  node.classList.remove('hide');
}
function hideNote(node) { node.classList.add('hide'); }

/* ================= Sunucu durumu ve model listesi ================= */
async function loadServerInfo() {
  const note = $('serverNote');
  try {
    const [modelsRes, readyRes] = await Promise.all([
      fetch('/api/models', { headers: { accept: 'application/json' } }),
      fetch('/api/ready', { headers: { accept: 'application/json' } })
    ]);

    if (!modelsRes.ok) throw new Error(`Model listesi alınamadı (HTTP ${modelsRes.status})`);
    const modelsData = await modelsRes.json();
    const models = Array.isArray(modelsData.models) ? modelsData.models : [];

    if (models.length === 0) {
      $('go').disabled = true;
      showNote(note, '⚠️ Sunucuda kullanılabilir Gemini modeli bulunamadı. .env dosyasındaki GEMINI_ALLOWED_MODELS ayarını kontrol edin.');
      return;
    }

    const sel = $('model');
    sel.innerHTML = '';
    models.forEach(m => sel.append(el('option', { value: m, textContent: m })));
    sel.value = models.includes(modelsData.default) ? modelsData.default : models[0];

    let ready = null;
    try { ready = await readyRes.json(); } catch { ready = null; }
    if (!readyRes.ok || !ready || !ready.hasApiKey) {
      showNote(note, '⚠️ Gemini API anahtarı tanımlı değil. Aşağıdaki "Gemini API anahtarı" kartından anahtarınızı girip kaydedin; analiz hemen kullanılabilir.');
    } else {
      hideNote(note);
      $('go').disabled = false;
    }
  } catch (err) {
    $('go').disabled = true;
    showNote(note, '⚠️ Sunucuya ulaşılamıyor (' + err.message + '). Backend çalışıyor mu? (npm start)');
  }
}
loadServerInfo();

/* ================= API anahtarı ayarları ================= */
let apiKeyStatus = null;
let apiKeyBusy = false;

function showApiKeyNote(text, ok) {
  const node = $('apiKeyNote');
  node.textContent = text;
  node.className = 'fetch-note' + (ok ? ' ok' : '');
}

function hideApiKeyNote() {
  const node = $('apiKeyNote');
  node.textContent = '';
  node.className = 'fetch-note hide';
}

function apiKeyStatusText(status) {
  if (!status || !status.configured) {
    return 'Tanımlı değil. Analiz yapabilmek için aşağıdan anahtarınızı girip kaydedin.';
  }
  if (status.source === 'stored') {
    let text = `Sistemde kayıtlı: ${status.masked}`;
    if (status.updatedAt) {
      const d = new Date(status.updatedAt);
      if (!Number.isNaN(d.getTime())) text += ` · ${d.toLocaleString('tr-TR')}`;
    }
    if (status.envFallback) text += ' · Silerseniz .env dosyasındaki anahtar kullanılır.';
    return text;
  }
  return `Sunucu .env dosyasından kullanılıyor: ${status.masked}. Arayüzden kaydederseniz bu anahtarın yerine geçer.`;
}

function renderApiKeyStatus(status) {
  apiKeyStatus = status || null;
  const configured = Boolean(status && status.configured);
  $('apiKeyStatusText').textContent = apiKeyStatusText(status);
  $('apiKeySave').textContent = configured ? 'Değiştir' : 'Kaydet';
  $('apiKeyInput').placeholder = configured ? 'Yeni anahtar (mevcut anahtarı değiştirir)' : 'AIza… veya AQ.…';
  $('apiKeyDelete').disabled = apiKeyBusy || !(status && status.canDelete);
}

function setApiKeyBusy(on) {
  apiKeyBusy = on;
  $('apiKeyInput').disabled = on;
  $('apiKeySave').disabled = on;
  $('apiKeyTest').disabled = on;
  $('apiKeyDelete').disabled = on || !(apiKeyStatus && apiKeyStatus.canDelete);
}

async function loadApiKeyStatus() {
  try {
    const res = await fetch('/api/settings/api-key', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderApiKeyStatus(data);
    return data;
  } catch (err) {
    $('apiKeyStatusText').textContent = 'Anahtar durumu alınamadı: ' + err.message;
    return null;
  }
}

async function readApiKeyResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `İstek başarısız (HTTP ${res.status}).`);
    error.code = data.code;
    throw error;
  }
  return data;
}

$('apiKeyInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('apiKeySave').click();
  }
});

$('apiKeySave').addEventListener('click', async () => {
  if (apiKeyBusy) return;
  const key = $('apiKeyInput').value.trim();
  if (!key) {
    showApiKeyNote('⚠️ Önce API anahtarını girin.', false);
    $('apiKeyInput').focus();
    return;
  }

  setApiKeyBusy(true);
  hideApiKeyNote();
  try {
    const res = await fetch('/api/settings/api-key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ apiKey: key })
    });
    const data = await readApiKeyResponse(res);
    $('apiKeyInput').value = '';
    renderApiKeyStatus(data);
    showApiKeyNote('✅ API anahtarı kaydedildi. Analiz için hazır.', true);
    await loadServerInfo();
  } catch (err) {
    showApiKeyNote('⚠️ ' + err.message, false);
  } finally {
    setApiKeyBusy(false);
    renderApiKeyStatus(apiKeyStatus);
  }
});

$('apiKeyTest').addEventListener('click', async () => {
  if (apiKeyBusy) return;
  const draft = $('apiKeyInput').value.trim();

  setApiKeyBusy(true);
  showApiKeyNote('Anahtar test ediliyor…', true);
  try {
    const res = await fetch('/api/settings/api-key/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(draft ? { apiKey: draft } : {})
    });
    const data = await readApiKeyResponse(res);
    const testOk = data.valid === true && data.reason !== 'QUOTA_LIMITED';
    let message = data.message || 'Test tamamlandı.';
    if (draft && data.valid === true) message += ' Kaydetmek için "Kaydet" düğmesine basın.';
    showApiKeyNote((testOk ? '✅ ' : '⚠️ ') + message, testOk);
  } catch (err) {
    showApiKeyNote('⚠️ ' + err.message, false);
  } finally {
    setApiKeyBusy(false);
    renderApiKeyStatus(apiKeyStatus);
  }
});

$('apiKeyDelete').addEventListener('click', async () => {
  if (apiKeyBusy || !apiKeyStatus || !apiKeyStatus.canDelete) return;
  if (!window.confirm('Sistemde kayıtlı Gemini API anahtarı silinsin mi?')) return;

  setApiKeyBusy(true);
  hideApiKeyNote();
  try {
    const res = await fetch('/api/settings/api-key', {
      method: 'DELETE',
      headers: { accept: 'application/json' }
    });
    const data = await readApiKeyResponse(res);
    $('apiKeyInput').value = '';
    renderApiKeyStatus(data);
    showApiKeyNote(
      data.configured
        ? 'Kayıtlı anahtar silindi. Sunucu .env dosyasındaki anahtar kullanılıyor.'
        : 'Kayıtlı anahtar silindi. Analiz için yeni bir anahtar girin.',
      true
    );
    await loadServerInfo();
  } catch (err) {
    showApiKeyNote('⚠️ ' + err.message, false);
  } finally {
    setApiKeyBusy(false);
    renderApiKeyStatus(apiKeyStatus);
  }
});

loadApiKeyStatus();

/* ================= Kategori sekmeleri (klavye erişilebilir) ================= */
let cat = 'vasita';
const tabs = Array.from(document.querySelectorAll('.tab'));

function setCat(c) {
  cat = c;
  tabs.forEach(t => {
    const on = t.dataset.cat === c;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  $('vasitaFields').classList.toggle('hide', c !== 'vasita');
  $('form').setAttribute('aria-labelledby', c === 'vasita' ? 'tab-vasita' : 'tab-ikinciel');
  $('photoHint').textContent = c === 'vasita'
    ? 'Ön, arka, iki yan, motor bölmesi, bagaj, kapı sütunları, şasi etiketi, kilometre göstergesi, lastikler.'
    : 'Arka, alt, köşeler, vidalar, etiket/seri no/IMEI, ekran açıkken ve kapalıyken.';
  clearFieldErrors();
  saveDraft();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => setCat(t.dataset.cat));
  t.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      setCat(next.dataset.cat);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setCat(t.dataset.cat);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = tabs[e.key === 'Home' ? 0 : tabs.length - 1];
      next.focus();
      setCat(next.dataset.cat);
    }
  });
});

/* ================= Form taslağı (localStorage) ================= */
const DRAFT_KEY = 'ieks_draft_v1';
const DRAFT_FIELDS = ['name', 'price', 'year', 'km', 'desc', 'url'];
let draftTimer = null;

function saveDraft() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const draft = { category: cat, fields: {} };
    DRAFT_FIELDS.forEach(f => { const n = $(f); if (n) draft.fields[f] = n.value; });
    safeLocalStorageSet(DRAFT_KEY, JSON.stringify(draft));
  }, 250);
}

function restoreDraft() {
  const raw = safeLocalStorageGet(DRAFT_KEY);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    if (draft && draft.fields) {
      DRAFT_FIELDS.forEach(f => {
        if (typeof draft.fields[f] === 'string' && $(f)) $(f).value = draft.fields[f];
      });
    }
    if (draft && (draft.category === 'vasita' || draft.category === 'ikinciel')) cat = draft.category;
  } catch { /* bozuk taslak yok sayılır */ }
}

DRAFT_FIELDS.forEach(f => {
  const n = $(f);
  if (n) n.addEventListener('input', saveDraft);
});

/* ================= Fotoğraf yükleme ================= */
const MAX_PHOTOS = 8;
const MAX_FILE_BYTES = 15 * 1024 * 1024; // küçültmeden önceki ham dosya sınırı
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PARALLEL_UPLOADS = 3;

let images = [];            // { dataUrl, b64, mimeType }
let pendingCount = 0;       // işlenmekte olan dosya sayısı (8 sınırına dahil)
let uploadGeneration = 0;   // Temizle sonrası eski asenkron işlemleri geçersiz kılar

function totalPhotoSlots() { return images.length + pendingCount; }

function resize(file, max = 1400) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      reject(new Error(`"${file.name}" desteklenmeyen bir dosya türü (${file.type || 'bilinmiyor'}). Yalnızca JPEG, PNG veya WEBP yükleyin.`));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      reject(new Error(`"${file.name}" çok büyük (${(file.size / 1024 / 1024).toFixed(1)}MB). En fazla ${MAX_FILE_BYTES / 1024 / 1024}MB olmalı.`));
      return;
    }
    const img = new Image();
    let url;
    try {
      url = URL.createObjectURL(file);
    } catch {
      reject(new Error(`"${file.name}" okunamadı.`));
      return;
    }
    const cleanup = () => { try { URL.revokeObjectURL(url); } catch { /* yut */ } };
    img.onload = () => {
      try {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * s));
        const h = Math.max(1, Math.round(img.height * s));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('Canvas bağlamı oluşturulamadı.');
        ctx.drawImage(img, 0, 0, w, h);
        // Canvas'a yeniden çizim EXIF (konum, cihaz) verisini de temizler.
        const dataUrl = c.toDataURL('image/jpeg', 0.85);
        if (!dataUrl || dataUrl === 'data:,') throw new Error('Görsel dönüştürülemedi.');
        cleanup();
        resolve({ dataUrl, b64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
      } catch (err) {
        cleanup();
        reject(new Error(`"${file.name}" işlenemedi: ${err.message}`));
      }
    };
    img.onerror = () => { cleanup(); reject(new Error(`"${file.name}" bozuk veya okunamayan bir görsel.`)); };
    img.src = url;
  });
}

function renderThumbs() {
  const box = $('thumbs');
  box.innerHTML = '';
  images.forEach((im, i) => {
    const d = el('div', { className: 'thumb' });
    const img = el('img', { src: im.dataUrl, alt: `Fotoğraf ${i + 1}` });
    const x = el('button', {
      type: 'button',
      className: 'rm',
      textContent: '×',
      title: 'Kaldır',
      ariaLabel: `Fotoğraf ${i + 1}'i kaldır`
    });
    x.onclick = () => { images.splice(i, 1); renderThumbs(); };
    d.append(img, x);
    box.append(d);
  });
  for (let i = 0; i < pendingCount; i++) {
    box.append(el('div', { className: 'thumb pending', textContent: 'Yükleniyor…' }));
  }
  $('files').setAttribute('aria-label', `Fotoğraflar, ${images.length} / ${MAX_PHOTOS} yüklendi`);
}

$('files').addEventListener('change', async e => {
  const filesArr = Array.from(e.target.files || []);
  e.target.value = ''; // aynı dosyayı tekrar seçebilmek için
  await addFiles(filesArr);
});

async function addFiles(filesArr) {
  if (filesArr.length === 0) return;
  const myGeneration = uploadGeneration;

  clearFieldError('photos');
  const freeSlots = MAX_PHOTOS - totalPhotoSlots();
  if (freeSlots <= 0) {
    setFieldError('photos', `En fazla ${MAX_PHOTOS} fotoğraf yükleyebilirsiniz.`);
    return;
  }
  const toProcess = filesArr.slice(0, freeSlots);
  if (filesArr.length > freeSlots) {
    setFieldError('photos', `En fazla ${MAX_PHOTOS} fotoğraf yükleyebilirsiniz; ${filesArr.length - freeSlots} dosya eklenmedi.`);
  }

  const queue = toProcess.slice();
  pendingCount += queue.length;
  renderThumbs();

  const worker = async () => {
    while (queue.length > 0) {
      const file = queue.shift();
      let result = null;
      let err = null;
      try {
        result = await resize(file);
      } catch (e2) {
        err = e2;
      }
      // Bu sırada Temizle'ye basıldıysa sonucu yok say.
      if (myGeneration !== uploadGeneration) return;
      pendingCount = Math.max(0, pendingCount - 1);
      if (err) {
        setFieldError('photos', err.message);
      } else if (images.length < MAX_PHOTOS) {
        images.push(result);
      }
      renderThumbs();
    }
  };

  await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, queue.length) }, worker));
}

/* ================= İlan linkinden ön izleme ================= */
let previewInFlight = null;
let previewGeneration = 0;
let lastPreviewedUrl = '';
let previewFilled = { name: '', price: '', desc: '' };

function showFetchNote(text, ok) {
  const node = $('fetchNote');
  node.textContent = text;
  node.className = 'fetch-note' + (ok ? ' ok' : '');
}

function hideFetchNote() {
  const node = $('fetchNote');
  node.textContent = '';
  node.className = 'fetch-note hide';
}

function fillPreviewField(id, value, maxLen) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  if (!text) return false;

  const node = $(id);
  if (!node) return false;
  const current = node.value.trim();
  const previousAutoValue = previewFilled[id] || '';
  // Kullanıcının kendi yazdığı metni ezme; yalnızca boş alanı veya önceki
  // otomatik doldurmayı güncelle.
  if (current && current !== previousAutoValue) return false;

  node.value = text.slice(0, maxLen);
  previewFilled[id] = node.value;
  clearFieldError(id);
  return true;
}

function addPreviewImages(list) {
  if (!Array.isArray(list) || list.length === 0) return 0;

  const maxBase64Chars = Math.ceil((3 * 1024 * 1024 * 4) / 3) + 8;
  const existing = new Set(images.map(im => im.b64.slice(0, 64)));
  let added = 0;
  let overLimit = false;

  for (const item of list) {
    if (!item || typeof item.data !== 'string' || typeof item.mimeType !== 'string') continue;
    if (!ALLOWED_TYPES.includes(item.mimeType)) continue;
    if (!item.data || item.data.length > maxBase64Chars) continue;

    if (images.length >= MAX_PHOTOS) {
      overLimit = true;
      continue;
    }

    const key = item.data.slice(0, 64);
    if (existing.has(key)) continue;
    existing.add(key);

    images.push({
      dataUrl: `data:${item.mimeType};base64,${item.data}`,
      b64: item.data,
      mimeType: item.mimeType
    });
    added++;
  }

  if (added > 0) {
    clearFieldError('photos');
    renderThumbs();
  }
  if (overLimit) {
    setFieldError('photos', `En fazla ${MAX_PHOTOS} fotoğraf eklenebilir; bazı ilan fotoğrafları alınmadı.`);
  }
  return added;
}

async function previewListing(options = {}) {
  const silent = Boolean(options.silent);
  const url = $('url').value.trim();

  if (!url) {
    setFieldError('url', 'Önce bir ilan linki girin.');
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    setFieldError('url', 'Geçerli bir http:// veya https:// bağlantısı girin.');
    return null;
  }

  if (previewInFlight) {
    if (!silent) showFetchNote('İlan linki zaten taranıyor; lütfen bekleyin.', false);
    return previewInFlight;
  }

  const generation = previewGeneration;
  const button = $('fetchListing');
  const buttonText = button.textContent;
  button.disabled = true;
  button.textContent = 'Taranıyor…';
  showFetchNote(
    silent ? 'Analiz öncesi ilan linki taranıyor; başlık, fiyat ve fotoğraflar alınıyor…' : 'İlan linki taranıyor; başlık, fiyat ve fotoğraflar alınıyor…',
    true
  );

  previewInFlight = (async () => {
    try {
      const res = await fetch('/api/listing/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID },
        body: JSON.stringify({ url })
      });
      const data = await res.json().catch(() => ({}));

      // Bu sırada Temizle'ye basıldıysa geç gelen yanıtı uygulama.
      if (generation !== previewGeneration) return null;

      if (!res.ok) {
        const message = data.error || `İlan linki taranamadı (HTTP ${res.status}).`;
        if (res.status === 400) setFieldError('url', message);
        showFetchNote('⚠️ ' + message + ' Bilgileri elle girmeye devam edebilirsiniz.', false);
        return null;
      }

      lastPreviewedUrl = url;

      let filled = 0;
      if (fillPreviewField('name', data.title, 160)) filled++;
      if (fillPreviewField('price', data.price, 32)) filled++;
      if (fillPreviewField('desc', data.description, 6000)) filled++;
      const added = addPreviewImages(data.images);

      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      const summary = [];
      if (filled > 0) summary.push(`${filled} alan dolduruldu`);
      if (added > 0) summary.push(`${added} fotoğraf eklendi`);
      if (summary.length === 0) summary.push('yeni bilgi bulunamadı');

      let note = `✅ İlan sayfası tarandı: ${summary.join(', ')}.`;
      if (warnings.length > 0) note += ' ' + warnings.join(' ');
      if (added === 0 && (!Array.isArray(data.images) || data.images.length === 0)) {
        note += ' Fotoğrafları elle ekleyebilirsiniz.';
      }
      showFetchNote(note, true);
      saveDraft();
      return data;
    } catch (err) {
      if (generation !== previewGeneration) return null;
      showFetchNote(
        '⚠️ İlan linki taranamadı: ' + err.message + ' Bilgileri elle girmeye devam edebilirsiniz.',
        false
      );
      return null;
    } finally {
      if (generation === previewGeneration) {
        previewInFlight = null;
        button.disabled = false;
        button.textContent = buttonText;
      }
    }
  })();

  return previewInFlight;
}

$('fetchListing').addEventListener('click', () => previewListing());

/* ================= Alan doğrulama (istemci tarafı) ================= */
function setFieldError(field, msg) {
  const box = $('err-' + field);
  if (box) { box.textContent = msg; box.classList.remove('hide'); }
  const input = $(field);
  if (input) input.classList.add('invalid');
  if (input && input.setAttribute) input.setAttribute('aria-invalid', 'true');
}
function clearFieldError(field) {
  const box = $('err-' + field);
  if (box) { box.textContent = ''; box.classList.add('hide'); }
  const input = $(field);
  if (input) input.classList.remove('invalid');
  if (input && input.removeAttribute) input.removeAttribute('aria-invalid');
}
function clearFieldErrors() {
  ['name', 'price', 'year', 'km', 'url', 'desc', 'photos', 'kvkk'].forEach(clearFieldError);
}
['name', 'price', 'year', 'km', 'url', 'desc'].forEach(f => {
  const n = $(f);
  if (n) n.addEventListener('input', () => clearFieldError(f));
});
$('kvkk').addEventListener('change', () => clearFieldError('kvkk'));

function parseTurkishNumberClient(raw) {
  if (typeof raw !== 'string') return NaN;
  let s = raw.trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (!/^-?[0-9.,]+$/.test(s)) return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) s = s.replace(/\./g, '').replace(',', '.');
  else if (hasComma) s = s.replace(',', '.');
  else if (hasDot) {
    const parts = s.split('.');
    const looksThousands = parts.length > 1 && parts.slice(1).every(p => p.length === 3) && parts[0].length <= 3;
    if (looksThousands) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function validateFormClient() {
  clearFieldErrors();
  let ok = true;

  const name = $('name').value.trim();
  if (!name) { setFieldError('name', 'Ürün / araç adı zorunludur.'); ok = false; }
  else if (name.length > 160) { setFieldError('name', 'Ürün / araç adı en fazla 160 karakter olabilir.'); ok = false; }

  const priceRaw = $('price').value.trim();
  const price = parseTurkishNumberClient(priceRaw);
  if (!priceRaw) { setFieldError('price', 'İlan fiyatı zorunludur.'); ok = false; }
  else if (Number.isNaN(price)) { setFieldError('price', 'Geçerli bir sayı girin (örn: 21000 veya 21.000).'); ok = false; }
  else if (price <= 0) { setFieldError('price', 'Fiyat sıfır veya negatif olamaz.'); ok = false; }
  else if (price > 1_000_000_000) { setFieldError('price', 'Fiyat mantık dışı derecede büyük.'); ok = false; }

  if (cat === 'vasita') {
    const year = Number($('year').value);
    const curYear = new Date().getFullYear();
    if (!$('year').value.trim()) { setFieldError('year', 'Model yılı zorunludur.'); ok = false; }
    else if (!Number.isInteger(year) || year < 1950 || year > curYear + 1) {
      setFieldError('year', `1950–${curYear + 1} arasında bir yıl girin.`);
      ok = false;
    }

    const km = Number($('km').value);
    if (!$('km').value.trim()) { setFieldError('km', 'Kilometre zorunludur.'); ok = false; }
    else if (!Number.isInteger(km) || km < 0) { setFieldError('km', 'Kilometre negatif olamaz.'); ok = false; }
    else if (km > 2_000_000) { setFieldError('km', 'Kilometre mantık dışı derecede büyük.'); ok = false; }
  }

  const urlRaw = $('url').value.trim();
  if (urlRaw) {
    try {
      const u = new URL(urlRaw);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    } catch {
      setFieldError('url', 'Geçerli bir http:// veya https:// bağlantısı girin.');
      ok = false;
    }
  }

  const desc = $('desc').value;
  if (desc.length > 6000) { setFieldError('desc', 'İlan açıklaması en fazla 6000 karakter olabilir.'); ok = false; }

  if (totalPhotoSlots() > MAX_PHOTOS) {
    setFieldError('photos', `En fazla ${MAX_PHOTOS} fotoğraf olabilir.`);
    ok = false;
  }
  if (pendingCount > 0) {
    setFieldError('photos', 'Fotoğraflar hâlâ işleniyor, lütfen bekleyin.');
    ok = false;
  }
  if (!$('kvkk').checked) {
    setFieldError('kvkk', 'Analiz için KVKK bilgilendirmesini onaylamanız gerekir.');
    ok = false;
  }

  return ok;
}

/* ================= İş / bağlantı durumu ================= */
let currentEventSource = null;
let currentJobId = null;
let currentJobToken = null;
let polling = false;
let analyzing = false;
let analyzeStarting = false;

// Her yeni analiz/temizleme/geçmiş açma işlemi bu sayacı artırır. Geç dönen
// async yanıtlar (takip sorusu, gecikmeli rapor render'ı) eski nesle aitse yok sayılır.
let renderGeneration = 0;
let followupAbort = null;
let progHideTimer = null;

function closeStream() {
  if (currentEventSource) {
    try { currentEventSource.close(); } catch { /* yut */ }
    currentEventSource = null;
  }
  polling = false;
}

function setAnalyzingState(on) {
  analyzing = on;
  $('go').disabled = on;
  $('go').textContent = on ? 'Analiz ediliyor…' : 'Analiz et';
  $('cancel').classList.toggle('hide', !on);
}

function resetAll() {
  invalidateRenders();
  closeStream();
  if (currentJobId && currentJobToken) {
    fetch(`/api/analyze/${currentJobId}/cancel`, {
      method: 'POST',
      headers: { 'x-job-token': currentJobToken }
    }).catch(() => {});
  }
  currentJobId = null;
  currentJobToken = null;
  reportCtx = { ask: null, items: [], historyId: null, busy: false, maxFollowups: null };
  setAnalyzingState(false);
  uploadGeneration++; // bekleyen fotoğraf işlemlerini geçersiz kıl
  pendingCount = 0;
  images = [];
  previewGeneration++; // uçuştaki ilan önizlemesini geçersiz kıl
  previewInFlight = null;
  lastPreviewedUrl = '';
  previewFilled = { name: '', price: '', desc: '' };
  $('fetchListing').disabled = false;
  $('fetchListing').textContent = 'İlan linkinden getir';
  hideFetchNote();
  renderThumbs();
  $('form').reset();
  $('apiKeyInput').value = '';
  hideApiKeyNote();
  safeLocalStorageRemove(DRAFT_KEY);
  clearFieldErrors();
  $('out').innerHTML = '';
  $('compareOut').innerHTML = '';
  hideStatus();
  hideNote($('quotaNote'));
  stopProgress(false);
  setCat(cat);
  renderThumbs();
}
$('resetBtn').onclick = resetAll;

async function cancelCurrentJob() {
  const id = currentJobId;
  const token = currentJobToken;
  if (!id || !token) return;

  invalidateRenders();
  closeStream();
  try {
    await fetch(`/api/analyze/${id}/cancel`, { method: 'POST', headers: { 'x-job-token': token } });
  } catch { /* yut */ }

  currentJobId = null;
  currentJobToken = null;
  setAnalyzingState(false);
  stopProgress(false);
  showStatus('Analiz iptal edildi.');
}
$('cancel').onclick = cancelCurrentJob;

window.addEventListener('beforeunload', e => {
  if (!analyzing) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ================= İlerleme paneli ================= */
const STAGE_INFO = {
  queued:         { pct: 2,  label: 'Sıraya alındı, önceki analizler tamamlanıyor' },
  prepare:        { pct: 8,  label: 'İlan bilgileri ve fotoğraflar hazırlanıyor' },
  requesting:     { pct: 25, label: 'Gemini modeline istek gönderiliyor (arama + görsel inceleme)' },
  retrying:       { pct: 32, label: 'Geçici bir sorun oluştu, tekrar deneniyor' },
  search_skipped: { pct: 34, label: 'Google araması bu anahtarda kullanılamıyor; analiz aramasız sürdürülüyor' },
  processing:     { pct: 60, label: 'Model yanıtı işleniyor' },
  repairing:      { pct: 72, label: 'Rapor şeması düzeltiliyor (tek onarım denemesi)' },
  validating:     { pct: 86, label: 'Rapor alanları doğrulanıyor' },
  finalizing:     { pct: 95, label: 'Rapor hazırlanıyor' },
  done:           { pct: 100, label: 'Tamamlandı' }
};
const STAGE_ORDER = ['queued', 'prepare', 'requesting', 'retrying', 'search_skipped', 'processing', 'repairing', 'validating', 'finalizing', 'done'];
// Ara aşamalar (retrying / search_skipped) adım listesinde ayrı satır olarak gösterilmez;
// kendi etiketleriyle ilerleme başlığında görünür ve ilgili adımı vurgular.
const STAGE_ALIAS = { retrying: 'requesting', search_skipped: 'requesting' };
const VISIBLE_STAGES = STAGE_ORDER.filter(s => !(s in STAGE_ALIAS));

let progStartTime = null;
let progElapsedTimer = null;

function startProgress() {
  if (progHideTimer) {
    clearTimeout(progHideTimer);
    progHideTimer = null;
  }
  $('prog').classList.remove('hide');
  hideStatus();
  $('pSteps').innerHTML = '';
  VISIBLE_STAGES.forEach(s => {
    const li = el('li', {}, el('span', { className: 'ic', textContent: '○' }), el('span', { textContent: STAGE_INFO[s].label }));
    li.dataset.stage = s;
    $('pSteps').append(li);
  });
  progStartTime = Date.now();
  updateProgressStage('queued');
  if (progElapsedTimer) clearInterval(progElapsedTimer);
  progElapsedTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - progStartTime) / 1000);
    $('pEta').textContent = `Geçen süre: ${secs} sn`;
  }, 500);
}

function updateProgressStage(stage) {
  const info = STAGE_INFO[stage] || STAGE_INFO.prepare;
  $('pBar').style.width = info.pct + '%';
  $('pPct').textContent = '%' + info.pct;
  $('pTitle').textContent = info.label;
  $('pSub').textContent = 'Ekranı kapatma; analiz bitince rapor burada görünecek. İstersen İptal ile durdurabilirsin.';
  const bar = document.querySelector('.bar');
  if (bar) bar.setAttribute('aria-valuenow', String(info.pct));

  const idx = VISIBLE_STAGES.indexOf(STAGE_ALIAS[stage] || stage);
  Array.from($('pSteps').children).forEach((li, i) => {
    const done = idx >= 0 && i < idx;
    const now = idx >= 0 && i === idx;
    li.className = done ? 'done' : now ? 'now' : '';
    li.firstChild.textContent = done ? '✓' : now ? '▶' : '○';
  });
}

function stopProgress(ok) {
  if (progElapsedTimer) {
    clearInterval(progElapsedTimer);
    progElapsedTimer = null;
  }
  if (progHideTimer) {
    clearTimeout(progHideTimer);
    progHideTimer = null;
  }
  if (ok) {
    updateProgressStage('done');
    const gen = renderGeneration;
    progHideTimer = setTimeout(() => {
      progHideTimer = null;
      // Bu arada yeni bir analiz başladıysa yeni ilerleme panelini gizleme.
      if (gen === renderGeneration) $('prog').classList.add('hide');
    }, 600);
  } else {
    $('prog').classList.add('hide');
  }
}

/* ================= Analiz akışı ================= */
$('form').addEventListener('submit', e => e.preventDefault());
$('go').addEventListener('click', analyze);

function buildPayload() {
  const payload = {
    category: cat,
    name: $('name').value.trim(),
    price: $('price').value.trim(),
    desc: $('desc').value.trim(),
    url: $('url').value.trim() || undefined,
    model: $('model').value,
    images: images.map(im => ({ mimeType: im.mimeType, data: im.b64 })),
    kvkkOnay: true
  };
  if (cat === 'vasita') {
    payload.year = Number($('year').value);
    payload.km = Number($('km').value);
  }
  return payload;
}

async function analyze() {
  if (analyzing || analyzeStarting) return;
  if (!validateFormClient()) {
    showErr('Lütfen formdaki hataları düzeltin.');
    return;
  }

  // Link verilmişse ve bu link daha önce taranmadıysa analizden hemen önce
  // ilan sayfasını tara: başlık/açıklama/fiyat boşluklarını doldur, fotoğrafları ekle.
  const urlValue = $('url').value.trim();
  if (urlValue && lastPreviewedUrl !== urlValue) {
    const flowGeneration = renderGeneration;
    analyzeStarting = true;
    try {
      showStatus('Analiz öncesi ilan linki taranıyor…');
      await previewListing({ silent: true });
      if (flowGeneration !== renderGeneration) return;
      if (!validateFormClient()) {
        showErr('Lütfen formdaki hataları düzeltin.');
        return;
      }
      hideStatus();
    } finally {
      analyzeStarting = false;
    }
  }

  const payload = buildPayload();

  invalidateRenders();
  reportCtx = { ask: null, items: [], historyId: null, busy: false, maxFollowups: null };
  const gen = renderGeneration;
  setAnalyzingState(true);
  $('out').innerHTML = '';
  hideStatus();
  hideNote($('quotaNote'));
  startProgress();

  try {
    const startRes = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID },
      body: JSON.stringify(payload)
    });
    const startData = await startRes.json().catch(() => ({}));

    // Bu sırada Temizle/yeni analiz/geçmiş açma olduysa geç gelen yanıtı yok say.
    if (gen !== renderGeneration) {
      if (startRes.ok && startData.jobId && startData.token) {
        fetch(`/api/analyze/${encodeURIComponent(startData.jobId)}/cancel`, {
          method: 'POST',
          headers: { 'x-job-token': startData.token }
        }).catch(() => {});
      }
      return;
    }

    if (!startRes.ok) {
      if (startData.code === 'VALIDATION_ERROR' && Array.isArray(startData.fields)) {
        startData.fields.forEach(f => setFieldError(f.field, f.message));
      }
      if (startData.code === 'MISSING_API_KEY') {
        showApiKeyNote('⚠️ ' + (startData.error || 'Analiz için önce Gemini API anahtarını girin.'), false);
        $('apiKeyInput').focus();
        $('apiKeyCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (startRes.status === 429) {
        const retryAfter = Number(startRes.headers.get('retry-after')) || 60;
        showNote($('quotaNote'), startData.error || `Çok fazla istek gönderdiniz. ${retryAfter} saniye sonra tekrar deneyin.`);
      }
      throw new Error(startData.error || `İstek başlatılamadı (HTTP ${startRes.status}).`);
    }
    if (!startData.jobId || !startData.token) {
      throw new Error('Sunucu geçerli bir iş kimliği döndürmedi.');
    }

    currentJobId = startData.jobId;
    currentJobToken = startData.token;
    listenToJob(currentJobId, currentJobToken);
  } catch (err) {
    if (gen !== renderGeneration) return;
    stopProgress(false);
    setAnalyzingState(false);
    currentJobId = null;
    currentJobToken = null;
    showErr('Hata: ' + err.message);
  }
}

function jobStreamUrl(jobId, token) {
  return `/api/analyze/${encodeURIComponent(jobId)}/stream?token=${encodeURIComponent(token)}`;
}

function listenToJob(jobId, token) {
  const es = new EventSource(jobStreamUrl(jobId, token));
  currentEventSource = es;

  es.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (jobId !== currentJobId) return;
    handleJobMessage(jobId, msg);
  };

  es.onerror = () => {
    try { es.close(); } catch { /* yut */ }
    if (currentEventSource === es) currentEventSource = null;
    if (jobId !== currentJobId) return;
    // SSE kopmuş olabilir: polling ile sonucu almaya devam et.
    startPolling(jobId, token);
  };
}

async function startPolling(jobId, token) {
  if (polling || jobId !== currentJobId) return;
  polling = true;
  const deadline = Date.now() + 10 * 60 * 1000; // SSE kopsa bile sonsuza kadar polling yapma

  while (polling && jobId === currentJobId) {
    if (Date.now() > deadline) {
      polling = false;
      failAnalysis('Analiz sonucu zamanında alınamadı. Lütfen yeni bir analiz başlatın.');
      return;
    }
    try {
      const res = await fetch(`/api/analyze/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`, {
        headers: { accept: 'application/json' }
      });
      if (res.status === 403 || res.status === 404) {
        polling = false;
        failAnalysis('Analiz işine erişilemedi veya işin süresi doldu.');
        return;
      }
      if (res.ok) {
        const job = await res.json();
        if (job.status === 'done') { polling = false; completeAnalysis(job.result, job.maxFollowups); return; }
        if (job.status === 'error') { polling = false; failAnalysis(job.error ? job.error.message : 'Bilinmeyen hata.'); return; }
        if (job.status === 'cancelled') { polling = false; cancelUi(); return; }
        if (job.stage) updateProgressStage(job.stage);
      }
    } catch { /* ağ hatası: tekrar dene */ }
    await delay(2000);
  }
}

function handleJobMessage(jobId, msg) {
  if (msg.type === 'stage') {
    updateProgressStage(msg.stage);
  } else if (msg.type === 'done') {
    completeAnalysis(msg.result, msg.maxFollowups);
  } else if (msg.type === 'error') {
    failAnalysis(msg.error && msg.error.message ? msg.error.message : 'Bilinmeyen hata.');
  } else if (msg.type === 'cancelled') {
    cancelUi();
  }
}

function clearJobState() {
  closeStream();
  currentJobId = null;
  currentJobToken = null;
  setAnalyzingState(false);
}

function completeAnalysis(result, maxFollowups) {
  if (!result || !result.report) {
    failAnalysis('Sunucu geçersiz bir rapor döndürdü.');
    return;
  }
  const jobId = currentJobId;
  const jobToken = currentJobToken;
  invalidateRenders();
  const gen = renderGeneration;
  clearJobState();
  stopProgress(true);
  setTimeout(() => {
    // 500 ms içinde Temizle/yeni analiz/geçmiş açma olduysa eski raporu basma.
    if (gen !== renderGeneration) return;
    reportCtx = {
      ask: jobId && jobToken ? { jobId, token: jobToken } : null,
      items: [],
      historyId: null,
      busy: false,
      maxFollowups: typeof maxFollowups === 'number' ? maxFollowups : null
    };
    render(result.report, result.sources || [], result.queries || [], result.searchPerformed, {
      savedAt: new Date(),
      model: result.model,
      usage: result.usage
    });
    $('out').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 500);
}

function failAnalysis(message) {
  invalidateRenders();
  clearJobState();
  stopProgress(false);
  showErr('Hata: ' + message);
}

function cancelUi() {
  // Kullanıcı İptal/Temizle'ye bastığı için ayrıca hata göstermiyoruz.
  invalidateRenders();
  clearJobState();
  stopProgress(false);
}

/* ================= Kopyalama (Clipboard API + yedek) ================= */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* yedek */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ================= Rapor export (PDF / JSON) ================= */
function slugify(text) {
  return String(text || 'rapor')
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9ğüşöçı]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'rapor';
}

function downloadJson(report, sources) {
  const payload = { olusturma: new Date().toISOString(), report, sources };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `eksper-${slugify(report.urun_tam_adi)}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function reportToText(report) {
  const k = report.nihai_karar || {};
  const p = report.piyasa_verisi || {};
  const lines = [
    `Ürün: ${report.urun_tam_adi || '-'}`,
    `Karar: ${k.durum || '-'} (${k.puan || '-'})`,
    `Hüküm: ${k.tek_cumlelik_hukum || '-'}`,
    `İlan fiyatı: ${p.ilan_fiyati || '-'}`,
    `İkinci el aralığı: ${p.ortalama_ikinci_el_araligi || '-'}`,
    `Fiyat durumu: ${p.fiyat_durumu || '-'}`,
    '',
    'Kusurlar:',
    ...(report.tespit_edilen_kusurlar_ve_kor_noktalar || []).map(x => `- ${x}`),
    '',
    'Satıcıya sorulacak sorular:',
    ...(report.saticiya_sorulacak_kanit_sorulari || []).map((q, i) => `${i + 1}. ${q}`)
  ];
  return lines.join('\n');
}

/* ================= Rapor render ================= */
/**
 * Takip sorusu oturumu. `ask` null ise soru sorulamaz (geçmişten açılan rapor).
 * items: [{ question, answer, updated }]
 */
let reportCtx = { ask: null, items: [], historyId: null, busy: false, maxFollowups: null };
let activeMeta = {};
let activeReportCache = null;
let activeSourcesCache = [];
let activeQueriesCache = [];
let activeSearchPerformedCache = null;

/** Uçuştaki takip isteğini iptal eder ve eski async render'ları geçersiz kılar. */
function invalidateRenders() {
  renderGeneration += 1;
  if (followupAbort) {
    try { followupAbort.abort(); } catch { /* yut */ }
    followupAbort = null;
  }
}

function render(d, sources, queries, searchPerformed, meta = {}) {
  const out = $('out');
  out.innerHTML = '';
  d = d || {};

  const k = d.nihai_karar || {};
  const p = d.piyasa_verisi || {};
  const durum = (k.durum || '').toUpperCase();
  const color = durum.includes('ALINMAZ') ? 'var(--red)'
    : durum.includes('YÜKSEK') ? 'var(--org)'
      : durum.includes('TEST') ? 'var(--yel)'
        : durum.includes('FIRSAT') ? 'var(--grn)' : 'var(--acc)';

  const badge = el('span', { className: 'badge', textContent: k.durum || '—' });
  badge.style.background = color;
  badge.style.color = '#111';

  const metaBits = [];
  if (meta.savedAt) metaBits.push(new Date(meta.savedAt).toLocaleString('tr-TR'));
  if (meta.model) metaBits.push(meta.model);
  if (meta.usage && meta.usage.totalTokens) metaBits.push(`${meta.usage.totalTokens} token`);

  const actions = el('div', { className: 'report-actions no-print' });
  const printBtn = el('button', { type: 'button', className: 'sec', textContent: '🖨️ PDF / Yazdır' });
  printBtn.onclick = () => window.print();
  const jsonBtn = el('button', { type: 'button', className: 'sec', textContent: '⬇️ JSON indir' });
  jsonBtn.onclick = () => downloadJson(d, sources || []);
  const copyBtn = el('button', { type: 'button', className: 'sec', textContent: '📋 Özeti kopyala' });
  copyBtn.onclick = async () => {
    const ok = await copyText(reportToText(d));
    copyBtn.textContent = ok ? 'Kopyalandı ✓' : 'Kopyalanamadı';
    setTimeout(() => { copyBtn.textContent = '📋 Özeti kopyala'; }, 1800);
  };
  actions.append(printBtn, jsonBtn, copyBtn);

  out.append(
    el('div', { className: 'card' },
      el('div', { className: 'verdict' }, badge, el('span', { className: 'score', textContent: k.puan || '' })),
      el('p', { textContent: k.tek_cumlelik_hukum || '', style: 'font-size:16px;font-weight:600;margin:12px 0 0' }),
      metaBits.length ? el('p', { className: 'hint', textContent: metaBits.join(' · ') }) : '',
      actions
    )
  );

  if (d._arastirma_notu || searchPerformed === false) {
    out.append(el('div', { className: 'card' }, el('p', {
      className: 'warn',
      textContent: '⚠️ ' + (d._arastirma_notu || 'Bu analizde doğrulanmış piyasa araması yapılamadı; aşağıdaki piyasa verisi tahminîdir.')
    })));
  }

  const marketRows = [
    ['Ürün', d.urun_tam_adi || ''],
    ['İlan fiyatı', p.ilan_fiyati || ''],
    ['İkinci el aralığı', p.ortalama_ikinci_el_araligi || ''],
    ['Fiyat durumu', p.fiyat_durumu || '']
  ];
  if (typeof p.emsal_sayisi === 'number') marketRows.splice(3, 0, ['Kullanılan emsal sayısı', String(p.emsal_sayisi)]);
  const kv = el('div', { className: 'kv' });
  marketRows.forEach(([a, b]) => kv.append(el('span', { textContent: a }), el('span', { textContent: b })));
  out.append(section('📊 Piyasa verisi', kv));

  out.append(section('🔍 Kusurlar ve kör noktalar', list(d.tespit_edilen_kusurlar_ve_kor_noktalar)));
  out.append(section('⚠️ Metin çelişkileri ve kronik riskler', list(d.metin_celiskileri_ve_kronik_riskler)));

  const qs = d.saticiya_sorulacak_kanit_sorulari || [];
  const qCopy = el('button', { type: 'button', className: 'sec no-print', textContent: 'Soruları kopyala' });
  qCopy.style.marginTop = '10px';
  qCopy.onclick = async () => {
    const ok = await copyText(qs.map((q, i) => `${i + 1}. ${q}`).join('\n'));
    qCopy.textContent = ok ? 'Kopyalandı ✓' : 'Kopyalanamadı, elle seçip kopyalayın';
    setTimeout(() => { qCopy.textContent = 'Soruları kopyala'; }, 1800);
  };
  out.append(section('❓ Satıcıya sorulacak kanıt soruları', list(qs, true), qCopy));

  if ((sources && sources.length) || (queries && queries.length)) {
    const ul = el('ul');
    const seen = new Set();
    (sources || []).forEach(s => {
      if (!s.uri || seen.has(s.uri)) return;
      seen.add(s.uri);
      ul.append(el('li', {}, safeExternalLink(s.uri, s.title || s.uri)));
    });
    out.append(section('🌐 Araştırma kaynakları',
      queries && queries.length ? el('div', { className: 'hint', textContent: 'Aramalar: ' + queries.join(' · ') }) : '',
      ul.children.length ? ul : el('p', { className: 'hint', textContent: 'Tıklanabilir kaynak bağlantısı bulunamadı.' })));
  }

  out.append(el('div', { className: 'card no-print' },
    el('details', {},
      el('summary', { textContent: 'Analiz notları (düşünce alanı) ve ham JSON' }),
      el('p', { textContent: d.analiz_ozeti_dusunceler || '' }),
      el('pre', { textContent: JSON.stringify(d, null, 2) })
    )));

  activeMeta = { savedAt: meta.savedAt, model: meta.model, usage: meta.usage };
  activeReportCache = d;
  activeSourcesCache = sources || [];
  activeQueriesCache = queries || [];
  activeSearchPerformedCache = searchPerformed;

  // Takip soruları: cevap verilen sorular + (soru sorulabiliyorsa) giriş alanı.
  appendFollowupCard(out);

  // Rapor tamamlanınca geçmişe kaydet (tekilleştirme: aynı rapor 2 kez eklenmez).
  if (meta.autoSave !== false) reportCtx.historyId = saveToHistory(d, sources || [], queries || [], searchPerformed, meta);
}

/* ================= Takip soruları ================= */
function appendFollowupCard(out) {
  const items = Array.isArray(reportCtx.items) ? reportCtx.items : [];
  const canAsk = Boolean(reportCtx.ask && reportCtx.ask.jobId && reportCtx.ask.token);

  if (!canAsk && items.length === 0) return;

  const card = el('div', { className: 'card no-print' });
  card.append(el('h3', { textContent: '💬 Rapora soru sor' }));

  if (canAsk) {
    const max = reportCtx.maxFollowups || 10;
    card.append(
      el('p', {
        className: 'hint',
        textContent: `Raporla ilgili ek soru sorun; model yanıtlar ve gerekirse analizi günceller (bu analiz için en fazla ${max} soru).`
      })
    );
  } else {
    card.append(el('p', { className: 'hint', textContent: 'Bu rapora sorulan takip soruları (salt okunur).' }));
  }

  if (items.length > 0) {
    const listBox = el('div', { className: 'qa' });
    items.forEach(item => {
      const row = el('div', { className: 'qa-item' },
        el('div', { className: 'qa-q', textContent: '🙋 ' + item.question }),
        el('div', { className: 'qa-a', textContent: item.answer })
      );
      if (item.updated) row.append(el('div', { className: 'hint', textContent: '✓ Rapor bu cevaba göre güncellendi.' }));
      listBox.append(row);
    });
    card.append(listBox);
  }

  if (canAsk) {
    const count = items.length;
    const max = reportCtx.maxFollowups || 10;
    if (count >= max) {
      card.append(
        el('p', { className: 'warn', textContent: `Bu analiz için soru sınırına (${max}) ulaşıldı. Yeni soru için yeni bir analiz başlatın.` })
      );
    } else {
      const input = el('textarea', {
        id: 'followupInput',
        rows: 2,
        maxLength: 1000,
        placeholder: 'Örn: Tramer kaydı temiz çıkarsa fiyat ve karar nasıl değişir?'
      });
      const send = el('button', { type: 'button', id: 'followupSend', textContent: 'Sor' });
      const errBox = el('div', { className: 'field-err hide', id: 'followupErr' });
      const statusBox = el('div', { className: 'hint', id: 'followupStatus', ariaLive: 'polite' });

      send.onclick = () => sendFollowup(input, send, errBox, statusBox);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          send.click();
        }
      });

      card.append(
        el('label', { htmlFor: 'followupInput', textContent: 'Sorunuz' }),
        input,
        el('div', { className: 'report-actions' }, send, el('span', { className: 'hint', textContent: 'İpucu: Ctrl+Enter ile gönder' })),
        errBox,
        statusBox
      );
    }
  }

  out.append(card);
}

async function sendFollowup(input, button, errBox, statusBox) {
  const ctx = reportCtx;
  if (!ctx.ask || ctx.busy) return;

  const gen = renderGeneration;
  const question = (input.value || '').trim();
  errBox.classList.add('hide');
  errBox.textContent = '';

  if (!question) {
    errBox.textContent = 'Soru boş olamaz.';
    errBox.classList.remove('hide');
    input.focus();
    return;
  }
  if (question.length > 1000) {
    errBox.textContent = 'Soru en fazla 1000 karakter olabilir.';
    errBox.classList.remove('hide');
    return;
  }

  ctx.busy = true;
  button.disabled = true;
  button.textContent = 'Yanıtlanıyor…';
  statusBox.textContent = 'Model sorunuzu yanıtlıyor… (10–40 sn sürebilir)';

  const controller = new AbortController();
  followupAbort = controller;

  try {
    const res = await fetch(`/api/analyze/${encodeURIComponent(ctx.ask.jobId)}/followup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-job-token': ctx.ask.token },
      body: JSON.stringify({ question }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));

    // Bu sırada Temizle/yeni analiz/geçmiş açma olduysa eski cevabı çizme.
    if (gen !== renderGeneration) return;

    if (!res.ok) {
      if (data.code === 'JOB_NOT_FOUND') {
        throw new Error('Bu analizin süresi doldu; takip sorusu gönderilemiyor. Lütfen yeni bir analiz başlatın.');
      }
      if (data.code === 'FOLLOWUP_LIMIT') {
        throw new Error(data.error || 'Soru sınırına ulaşıldı.');
      }
      if (data.code === 'FOLLOWUP_TIMEOUT') {
        throw new Error(data.error || 'Takip sorusu zaman aşımına uğradı. Lütfen tekrar deneyin.');
      }
      throw new Error(data.error || `Soru yanıtlanamadı (HTTP ${res.status}).`);
    }

    if (typeof data.maxFollowups === 'number') ctx.maxFollowups = data.maxFollowups;
    ctx.items = [...ctx.items, { question, answer: data.answer, updated: Boolean(data.updated) }];
    ctx.busy = false;

    // Rapor güncellendiyse yeni rapor, aksi hâlde mevcut rapor yeniden çizilir.
    render(data.report || activeReportCache, activeSourcesCache, activeQueriesCache, activeSearchPerformedCache, {
      ...activeMeta
    });

    const freshInput = $('followupInput');
    if (freshInput) {
      freshInput.value = '';
      freshInput.focus();
    }
  } catch (err) {
    if (gen !== renderGeneration) return;
    if (err && err.name === 'AbortError') {
      // Temizle/yeni analiz zaten arayüzü sıfırladı; burada hata gösterme.
      ctx.busy = false;
      return;
    }
    ctx.busy = false;
    button.disabled = false;
    button.textContent = 'Sor';
    errBox.textContent = err.message;
    errBox.classList.remove('hide');
    statusBox.textContent = '';
  } finally {
    if (followupAbort === controller) followupAbort = null;
  }
}


/* ================= Rapor geçmişi (localStorage) ================= */
const HISTORY_KEY = 'ieks_history_v1';
const MAX_HISTORY = 20;
let historyEntries = [];
const compareSel = new Set();

function loadHistory() {
  const raw = safeLocalStorageGet(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(x => x && x.report) : [];
  } catch {
    return [];
  }
}

function persistHistory() {
  // localStorage kotası dolabilir: en yeni kayıtlardan başlayıp sığana kadar küçült.
  let entries = historyEntries.slice(0, MAX_HISTORY);
  while (entries.length > 0) {
    if (safeLocalStorageSet(HISTORY_KEY, JSON.stringify(entries))) {
      historyEntries = entries;
      return true;
    }
    entries = entries.slice(0, -1); // en eski kaydı at
  }
  safeLocalStorageRemove(HISTORY_KEY);
  historyEntries = [];
  return false;
}

function newId() {
  return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : 'h-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function saveToHistory(report, sources, queries, searchPerformed, meta = {}) {
  const name = report.urun_tam_adi || 'Adsız rapor';
  const score = (report.nihai_karar || {}).puan || '';
  const decision = (report.nihai_karar || {}).durum || '';

  // Takip sorusuyla güncellenen rapor yeni kayıt oluşturmaz; mevcut kaydı tazeler.
  const updating = historyEntries.find(h => h.id === reportCtx.historyId);
  const entry = {
    id: updating ? updating.id : newId(),
    savedAt: updating ? updating.savedAt : new Date().toISOString(),
    name,
    score,
    decision,
    model: meta.model || null,
    report,
    sources,
    queries,
    searchPerformed,
    followups: Array.isArray(reportCtx.items) ? reportCtx.items.slice() : []
  };

  let rest = historyEntries.filter(h => h.id !== entry.id);
  if (!updating) {
    // Aynı rapor tekrar kaydedilmesin.
    rest = rest.filter(h => !(h.name === name && h.score === score && h.decision === decision));
  }

  historyEntries = [entry, ...rest].slice(0, MAX_HISTORY);
  const saved = persistHistory();
  renderHistory();
  return saved && historyEntries.some(h => h.id === entry.id) ? entry.id : null;
}

function renderHistory() {
  const card = $('historyCard');
  const box = $('historyList');
  historyEntries = loadHistory();
  box.innerHTML = '';

  if (historyEntries.length === 0) {
    card.classList.add('hide');
    return;
  }
  card.classList.remove('hide');
  $('historyCount').textContent = `(${historyEntries.length})`;

  historyEntries.forEach(h => {
    const row = el('div', { className: 'history-row' });

    const check = el('input', {
      type: 'checkbox',
      checked: compareSel.has(h.id),
      ariaLabel: `${h.name} raporunu karşılaştırmaya ekle`
    });
    check.disabled = !compareSel.has(h.id) && compareSel.size >= 2;
    check.onchange = () => {
      if (check.checked) compareSel.add(h.id);
      else compareSel.delete(h.id);
      renderHistory();
    };

    const label = el('div', { className: 'history-main' },
      el('strong', { textContent: h.name }),
      el('span', { className: 'hint', textContent: new Date(h.savedAt).toLocaleString('tr-TR') + (h.score ? ` · ${h.score}` : '') + (h.decision ? ` · ${h.decision}` : '') })
    );

    const openBtn = el('button', { type: 'button', className: 'sec', textContent: 'Aç' });
    openBtn.onclick = () => {
      invalidateRenders();
      reportCtx = {
        ask: null,
        items: Array.isArray(h.followups) ? h.followups.slice() : [],
        historyId: h.id,
        busy: false,
        maxFollowups: null
      };
      render(h.report, h.sources || [], h.queries || [], h.searchPerformed, {
        savedAt: h.savedAt,
        model: h.model,
        autoSave: false
      });
      $('out').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const delBtn = el('button', { type: 'button', className: 'sec danger', textContent: 'Sil', ariaLabel: `${h.name} raporunu sil` });
    delBtn.onclick = () => {
      historyEntries = historyEntries.filter(x => x.id !== h.id);
      compareSel.delete(h.id);
      if (reportCtx.historyId === h.id) reportCtx.historyId = null;
      persistHistory();
      renderHistory();
      $('compareOut').innerHTML = '';
    };

    row.append(check, label, openBtn, delBtn);
    box.append(row);
  });

  $('compareBtn').disabled = compareSel.size !== 2;
  $('compareBtn').textContent = compareSel.size === 2 ? 'Seçilen 2 raporu karşılaştır' : 'Seçilenleri karşılaştır (2 seçin)';
}

function renderCompare() {
  const out = $('compareOut');
  out.innerHTML = '';
  const picked = historyEntries.filter(h => compareSel.has(h.id));
  if (picked.length !== 2) return;

  const [a, b] = picked;
  const rows = [
    ['Ürün', a.report.urun_tam_adi, b.report.urun_tam_adi],
    ['Tarih', new Date(a.savedAt).toLocaleDateString('tr-TR'), new Date(b.savedAt).toLocaleDateString('tr-TR')],
    ['Karar', (a.report.nihai_karar || {}).durum, (b.report.nihai_karar || {}).durum],
    ['Puan', (a.report.nihai_karar || {}).puan, (b.report.nihai_karar || {}).puan],
    ['İlan fiyatı', (a.report.piyasa_verisi || {}).ilan_fiyati, (b.report.piyasa_verisi || {}).ilan_fiyati],
    ['İkinci el aralığı', (a.report.piyasa_verisi || {}).ortalama_ikinci_el_araligi, (b.report.piyasa_verisi || {}).ortalama_ikinci_el_araligi],
    ['Fiyat durumu', (a.report.piyasa_verisi || {}).fiyat_durumu, (b.report.piyasa_verisi || {}).fiyat_durumu],
    ['Kusur sayısı', String((a.report.tespit_edilen_kusurlar_ve_kor_noktalar || []).length), String((b.report.tespit_edilen_kusurlar_ve_kor_noktalar || []).length)]
  ];

  const table = el('table', { className: 'compare' });
  table.append(el('thead', {}, el('tr', {}, el('th', { textContent: 'Alan' }), el('th', { textContent: 'A' }), el('th', { textContent: 'B' }))));
  const tbody = el('tbody');
  rows.forEach(([label, va, vb]) => {
    tbody.append(el('tr', {},
      el('th', { textContent: label, scope: 'row' }),
      el('td', { textContent: va || '—' }),
      el('td', { textContent: vb || '—' })
    ));
  });
  table.append(tbody);
  out.append(el('h4', { textContent: 'Karşılaştırma' }), table);
}

$('compareBtn').onclick = renderCompare;
$('clearHistoryBtn').onclick = () => {
  if (!window.confirm('Tarayıcıdaki tüm rapor geçmişi silinecek. Emin misiniz?')) return;
  historyEntries = [];
  compareSel.clear();
  reportCtx.historyId = null; // açık rapor silinen kayda geri yazılmasın
  persistHistory();
  renderHistory();
  $('compareOut').innerHTML = '';
};

/* ================= Başlatma ================= */
restoreDraft();
setCat(cat);
renderThumbs();
renderHistory();

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* PWA opsiyonel */ });
  });
}
