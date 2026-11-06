'use strict';

// ---------- Constants ----------
const MAX_OUT_WIDTH = 1280;      // final width (never upscaled)
const JPEG_QUALITY = 0.9;
const PREVIEW_MAX_EDGE = 2560;   // longest edge of the on-screen preview bitmap
const MAX_CANVAS_AREA = 16_000_000; // stay below Safari's ~16.7MP canvas limit
const MIN_CROP_DISPLAY_PX = 16;  // minimum crop size, in screen pixels
const HISTORY_MAX = 12;
const LS = { settings: 'cropper.backend', ratio: 'cropper.ratio', custom: 'cropper.custom', history: 'cropper.history' };

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const stage = $('stage'), dropzone = $('dropzone'), frame = $('frame'), previewCanvas = $('preview');
const cropEl = $('crop'), shadeEl = $('shade'), busy = $('busy'), busyText = $('busyText'), dragOverlay = $('dragOverlay');
const fileInput = $('fileInput'), newBtn = $('newBtn'), settingsBtn = $('settingsBtn');
const ratiosEl = $('ratios'), customRow = $('customRow'), customW = $('customW'), customH = $('customH'), swapBtn = $('swapBtn');
const dimSource = $('dimSource'), dimCrop = $('dimCrop'), dimOut = $('dimOut'), dimWarn = $('dimWarn');
const uploadBtn = $('uploadBtn'), downloadBtn = $('downloadBtn'), progress = $('progress'), progressBar = $('progressBar');
const statusEl = $('status'), resultEl = $('result'), resultUrl = $('resultUrl'), copyBtn = $('copyBtn'), openLink = $('openLink');
const historyPanel = $('historyPanel'), historyEl = $('history');
const settingsDlg = $('settings'), settingsForm = $('settingsForm'), cfgEndpoint = $('cfgEndpoint'), cfgKey = $('cfgKey');

// ---------- State ----------
const state = {
  source: null,   // full-resolution ImageBitmap / HTMLImageElement
  W: 0, H: 0,     // source size
  fileName: '',
  crop: { x: 0, y: 0, w: 0, h: 0 }, // in source pixels
  ratioKey: localStorage.getItem(LS.ratio) || '4:5',
  scale: 1,       // screen px per source px
  busy: false,
};

const custom = JSON.parse(localStorage.getItem(LS.custom) || '{"w":16,"h":9}');
customW.value = custom.w;
customH.value = custom.h;

// ---------- Helpers ----------
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function currentRatio() {
  switch (state.ratioKey) {
    case 'free': return null;
    case 'custom': {
      const w = parseFloat(customW.value), h = parseFloat(customH.value);
      return w > 0 && h > 0 ? w / h : null;
    }
    default: {
      const [w, h] = state.ratioKey.split(':').map(Number);
      return w / h;
    }
  }
}

function setBusy(text) {
  state.busy = !!text;
  busy.hidden = !text;
  if (text) busyText.textContent = text;
  updateButtons();
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'small' + (kind ? ' ' + kind : '');
}

const DEFAULT_ENDPOINT = 'api/upload.php';
function getSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS.settings)) || {}; } catch {}
  return { endpoint: s.endpoint || DEFAULT_ENDPOINT, key: s.key || '' };
}

// ---------- Decoding ----------
function isTiff(file) {
  return file.type === 'image/tiff' || /\.tiff?$/i.test(file.name);
}

function decodeTiffInWorker(file) {
  return new Promise(async (resolve, reject) => {
    const worker = new Worker('tiff-worker.js');
    worker.onmessage = async (e) => {
      worker.terminate();
      const { error, width, height, data } = e.data;
      if (error) return reject(new Error('TIFF decode failed: ' + error));
      try {
        const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
        resolve(await createImageBitmap(imageData));
      } catch (err) { reject(err); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'TIFF worker failed')); };
    const buf = await file.arrayBuffer();
    worker.postMessage(buf, [buf]);
  });
}

function decodeViaImgElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { img.decode().catch(() => {}).finally(() => resolve(img)); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This browser cannot decode this image format.')); };
    img.src = url;
  });
}

async function decodeFile(file) {
  // createImageBitmap decodes off the main thread and applies EXIF orientation.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    if (isTiff(file)) return decodeTiffInWorker(file);
    return decodeViaImgElement(file);
  }
}

const sizeOf = (src) => ({ w: src.naturalWidth || src.width, h: src.naturalHeight || src.height });

// ---------- High-quality resampling ----------
// Draws a region of `src` into a dw×dh canvas. Large reductions are done in successive
// halvings, which avoids the aliasing/moire that a single big drawImage downscale produces.
function resample(src, sx, sy, sw, sh, dw, dh) {
  let w = dw, h = dh;
  while (w * 2 <= sw && h * 2 <= sh && (w * 2) * (h * 2) <= MAX_CANVAS_AREA) { w *= 2; h *= 2; }

  let canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  let ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // flatten transparency onto white (JPEG output)
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);

  while (w > dw) {
    const nw = w / 2, nh = h / 2;
    const next = document.createElement('canvas');
    next.width = nw; next.height = nh;
    const nctx = next.getContext('2d');
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(canvas, 0, 0, w, h, 0, 0, nw, nh);
    canvas.width = canvas.height = 0; // free memory early
    canvas = next; w = nw; h = nh;
  }
  return canvas;
}

// ---------- Loading an image ----------
async function openFile(file) {
  if (!file || state.busy) return;
  if (!file.type.startsWith('image/') && !/\.(tiff?|heic|heif|avif|jpe?g|png|webp|gif|bmp)$/i.test(file.name)) {
    setStatus('That doesn’t look like an image file.', 'error');
    return;
  }
  setStatus('');
  resultEl.hidden = true;
  setBusy(`Decoding ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);
  try {
    const src = await decodeFile(file);
    const { w, h } = sizeOf(src);
    if (!w || !h) throw new Error('Image has no dimensions.');

    if (state.source && state.source.close) state.source.close();
    state.source = src;
    state.W = w; state.H = h;
    state.fileName = file.name.replace(/\.[^.]+$/, '');

    setBusy('Preparing preview…');
    await new Promise(requestAnimationFrame);
    const s = Math.min(1, PREVIEW_MAX_EDGE / Math.max(w, h));
    const pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
    const pv = resample(src, 0, 0, w, h, pw, ph);
    previewCanvas.width = pw; previewCanvas.height = ph;
    previewCanvas.getContext('2d').drawImage(pv, 0, 0);
    pv.width = pv.height = 0;

    dropzone.hidden = true;
    frame.hidden = false;
    newBtn.hidden = false;
    state.crop = { x: 0, y: 0, w, h };
    layout();
    applyRatio();
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Could not open this image.', 'error');
  } finally {
    setBusy(null);
  }
}

function resetToDropzone() {
  if (state.source && state.source.close) state.source.close();
  state.source = null;
  frame.hidden = true;
  dropzone.hidden = false;
  newBtn.hidden = true;
  resultEl.hidden = true;
  setStatus('');
  fileInput.value = '';
  updateInfo();
}

// ---------- Layout / rendering ----------
function layout() {
  if (!state.source) return;
  const pad = 24;
  const aw = Math.max(50, stage.clientWidth - pad * 2);
  const ah = Math.max(50, stage.clientHeight - pad * 2);
  state.scale = Math.min(aw / state.W, ah / state.H);
  const fw = state.W * state.scale, fh = state.H * state.scale;
  frame.style.width = fw + 'px';
  frame.style.height = fh + 'px';
  frame.style.left = (stage.clientWidth - fw) / 2 + 'px';
  frame.style.top = (stage.clientHeight - fh) / 2 + 'px';
  renderCrop();
}

function renderCrop() {
  const { x, y, w, h } = state.crop, s = state.scale;
  for (const el of [cropEl, shadeEl]) {
    el.style.left = x * s + 'px';
    el.style.top = y * s + 'px';
    el.style.width = w * s + 'px';
    el.style.height = h * s + 'px';
  }
  updateInfo();
}

function outputRect() {
  const { W, H } = state;
  let cw = Math.max(1, Math.round(state.crop.w));
  let ch = Math.max(1, Math.round(state.crop.h));
  const cx = clamp(Math.round(state.crop.x), 0, W - cw);
  const cy = clamp(Math.round(state.crop.y), 0, H - ch);
  const ow = Math.min(MAX_OUT_WIDTH, cw);
  const r = currentRatio();
  const oh = Math.max(1, Math.round(r ? ow / r : ch * ow / cw));
  return { cx, cy, cw, ch, ow, oh };
}

function updateInfo() {
  if (!state.source) {
    dimSource.textContent = dimCrop.textContent = dimOut.textContent = '—';
    dimWarn.hidden = true;
    updateButtons();
    return;
  }
  const o = outputRect();
  dimSource.textContent = `${state.W} × ${state.H}`;
  dimCrop.textContent = `${o.cw} × ${o.ch}`;
  dimOut.textContent = `${o.ow} × ${o.oh}`;
  if (o.cw < MAX_OUT_WIDTH) {
    dimWarn.hidden = false;
    dimWarn.textContent = `Crop is narrower than ${MAX_OUT_WIDTH}px, so the output keeps its ${o.cw}px width (no upscaling).`;
  } else {
    dimWarn.hidden = true;
  }
  updateButtons();
}

function updateButtons() {
  const ready = !!state.source && !state.busy;
  uploadBtn.disabled = !ready;
  downloadBtn.disabled = !ready;
}

new ResizeObserver(layout).observe(stage);

// ---------- Ratio ----------
function renderRatioButtons() {
  ratiosEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.ratio === state.ratioKey));
  customRow.hidden = state.ratioKey !== 'custom';
}

// Fit the largest crop with the current ratio, centred on the current crop centre.
function applyRatio() {
  if (!state.source) return;
  const r = currentRatio();
  const { W, H, crop } = state;
  if (r) {
    const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
    const w = Math.min(W, H * r), h = w / r;
    state.crop = { x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w, h };
  }
  renderCrop();
}

function maximizeCrop() {
  if (!state.source) return;
  if (!currentRatio()) state.crop = { x: 0, y: 0, w: state.W, h: state.H };
  applyRatio();
}

ratiosEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.ratioKey = b.dataset.ratio;
  localStorage.setItem(LS.ratio, state.ratioKey);
  renderRatioButtons();
  applyRatio();
});

function onCustomChange() {
  localStorage.setItem(LS.custom, JSON.stringify({ w: customW.value, h: customH.value }));
  if (state.ratioKey === 'custom') applyRatio();
}
customW.addEventListener('input', onCustomChange);
customH.addEventListener('input', onCustomChange);
swapBtn.addEventListener('click', () => {
  [customW.value, customH.value] = [customH.value, customW.value];
  onCustomChange();
});

renderRatioButtons();

// ---------- Crop interaction ----------
let drag = null;

function pointerToImage(e, clampToImage = true) {
  const rect = frame.getBoundingClientRect();
  let x = (e.clientX - rect.left) / state.scale;
  let y = (e.clientY - rect.top) / state.scale;
  if (clampToImage) { x = clamp(x, 0, state.W); y = clamp(y, 0, state.H); }
  return { x, y };
}

frame.addEventListener('pointerdown', (e) => {
  if (!state.source || e.button !== 0) return;
  e.preventDefault();
  const handle = e.target.dataset && e.target.dataset.h;
  const mode = handle || (e.target.closest('.crop') ? 'move' : 'new');
  const start = { ...state.crop };
  const p0 = pointerToImage(e, mode !== 'move');
  drag = { mode, start, p0, moved: false, startClient: { x: e.clientX, y: e.clientY } };

  if (mode === 'new') {
    drag.anchor = p0;
  } else if (mode.length === 2) { // corner: anchor at the opposite corner
    drag.anchor = {
      x: mode.includes('w') ? start.x + start.w : start.x,
      y: mode.includes('n') ? start.y + start.h : start.y,
    };
    drag.sx = mode.includes('w') ? -1 : 1;
    drag.sy = mode.includes('n') ? -1 : 1;
  }
  frame.setPointerCapture(e.pointerId);
  frame.classList.add('dragging');
});

frame.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startClient.x, e.clientY - drag.startClient.y) < 3) return;
  drag.moved = true;

  const { W, H } = state;
  const r = currentRatio();
  const min = MIN_CROP_DISPLAY_PX / state.scale;
  const s = drag.start;
  const mode = drag.mode;

  if (mode === 'move') {
    const p = pointerToImage(e, false);
    state.crop = {
      x: clamp(s.x + p.x - drag.p0.x, 0, W - s.w),
      y: clamp(s.y + p.y - drag.p0.y, 0, H - s.h),
      w: s.w, h: s.h,
    };
  } else if (mode === 'new' || mode.length === 2) {
    const p = pointerToImage(e);
    const a = drag.anchor;
    // New crops follow the pointer in any direction; corner handles keep their direction.
    const sx = mode === 'new' ? (p.x < a.x ? -1 : 1) : drag.sx;
    const sy = mode === 'new' ? (p.y < a.y ? -1 : 1) : drag.sy;
    const maxW = sx > 0 ? W - a.x : a.x;
    const maxH = sy > 0 ? H - a.y : a.y;
    let w = Math.max(0, (p.x - a.x) * sx);
    let h = Math.max(0, (p.y - a.y) * sy);
    if (r) {
      w = Math.max(w, h * r);
      const maxAllowed = Math.min(maxW, maxH * r);
      w = clamp(w, Math.min(min * Math.max(1, r), maxAllowed), maxAllowed);
      h = w / r;
    } else {
      w = clamp(w, Math.min(min, maxW), maxW);
      h = clamp(h, Math.min(min, maxH), maxH);
    }
    state.crop = { x: sx > 0 ? a.x : a.x - w, y: sy > 0 ? a.y : a.y - h, w, h };
  } else {
    // Edge handles
    const p = pointerToImage(e);
    let { x, y, w, h } = s;
    if (mode === 'e' || mode === 'w') {
      const ax = mode === 'e' ? s.x : s.x + s.w;
      const maxW = mode === 'e' ? W - ax : ax;
      w = mode === 'e' ? p.x - ax : ax - p.x;
      if (r) {
        const cy = s.y + s.h / 2;
        const maxAllowed = Math.min(maxW, 2 * Math.min(cy, H - cy) * r);
        w = clamp(w, Math.min(min * Math.max(1, r), maxAllowed), maxAllowed);
        h = w / r;
        y = cy - h / 2;
      } else {
        w = clamp(w, min, maxW);
      }
      x = mode === 'e' ? ax : ax - w;
    } else {
      const ay = mode === 's' ? s.y : s.y + s.h;
      const maxH = mode === 's' ? H - ay : ay;
      h = mode === 's' ? p.y - ay : ay - p.y;
      if (r) {
        const cx = s.x + s.w / 2;
        const maxAllowed = Math.min(maxH, (2 * Math.min(cx, W - cx)) / r);
        h = clamp(h, Math.min(min * Math.max(1, 1 / r), maxAllowed), maxAllowed);
        w = h * r;
        x = cx - w / 2;
      } else {
        h = clamp(h, min, maxH);
      }
      y = mode === 's' ? ay : ay - h;
    }
    state.crop = { x, y, w, h };
  }
  renderCrop();
});

function endDrag() {
  if (!drag) return;
  // A click on the dark area without dragging keeps the existing crop.
  if (drag.mode === 'new' && !drag.moved) state.crop = drag.start;
  drag = null;
  frame.classList.remove('dragging');
  renderCrop();
}
frame.addEventListener('pointerup', endDrag);
frame.addEventListener('pointercancel', endDrag);
cropEl.addEventListener('dblclick', maximizeCrop);

// Arrow keys nudge the crop (1 screen px, or 10 with Shift).
window.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, dialog')) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!uploadBtn.disabled) upload(); return; }
  if (!state.source) return;
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const d = dirs[e.key];
  if (!d) return;
  e.preventDefault();
  const step = (e.shiftKey ? 10 : 1) / state.scale;
  const c = state.crop;
  state.crop = { ...c, x: clamp(c.x + d[0] * step, 0, state.W - c.w), y: clamp(c.y + d[1] * step, 0, state.H - c.h) };
  renderCrop();
});

// ---------- File input / drag & drop / paste ----------
fileInput.addEventListener('change', () => openFile(fileInput.files[0]));
newBtn.addEventListener('click', resetToDropzone);

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dragOverlay.hidden = false; });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dragOverlay.hidden = true; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dragOverlay.hidden = true;
  openFile(e.dataTransfer.files[0]);
});
window.addEventListener('paste', (e) => {
  if (e.target.closest && e.target.closest('input')) return;
  const item = Array.from(e.clipboardData?.items || []).find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (item) { e.preventDefault(); openFile(item.getAsFile()); }
});

// ---------- Export ----------
async function renderOutput() {
  const o = outputRect();
  const canvas = resample(state.source, o.cx, o.cy, o.cw, o.ch, o.ow, o.oh);
  const blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('JPEG encoding failed'))), 'image/jpeg', JPEG_QUALITY));
  canvas.width = canvas.height = 0;
  return { blob, w: o.ow, h: o.oh };
}

function outputName(w) {
  const base = (state.fileName || 'image').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
  return `${base}-${w}w.jpg`;
}

downloadBtn.addEventListener('click', async () => {
  if (downloadBtn.disabled) return;
  setBusy('Rendering…');
  try {
    await new Promise(requestAnimationFrame);
    const { blob, w } = await renderOutput();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = outputName(w);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    setBusy(null);
  }
});

// ---------- Upload (via the PHP backend, which signs and forwards to Cloudinary) ----------
function uploadToBackend(blob, name, settings, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', blob, name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', settings.endpoint);
    xhr.setRequestHeader('X-Upload-Key', settings.key);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data && data.url) resolve(data);
      else if (data && data.error) reject(new Error(data.error));
      else if (xhr.status === 404) reject(new Error(`Upload endpoint not found: ${settings.endpoint}`));
      else reject(new Error(`Upload failed (HTTP ${xhr.status}). Is PHP running at ${settings.endpoint}?`));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading (or a CORS problem if the backend is on another domain).'));
    xhr.send(fd);
  });
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    resultUrl.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
}

async function upload() {
  if (uploadBtn.disabled) return;
  const settings = getSettings();
  if (!settings.key) {
    openSettings();
    setStatus('Enter your upload access key first.', 'error');
    return;
  }
  resultEl.hidden = true;
  setStatus('');
  setBusy('Rendering…');
  try {
    await new Promise(requestAnimationFrame);
    const { blob, w, h } = await renderOutput();
    setBusy(null);
    uploadBtn.disabled = downloadBtn.disabled = true;
    state.busy = true;
    progress.hidden = false;
    progressBar.style.width = '0%';
    setStatus(`Uploading ${(blob.size / 1024).toFixed(0)} KB…`);

    const data = await uploadToBackend(blob, outputName(w), settings, (f) => { progressBar.style.width = (f * 100).toFixed(1) + '%'; });
    const url = data.url;

    resultUrl.value = url;
    openLink.href = url;
    resultEl.hidden = false;
    const copied = await copyToClipboard(url);
    resultEl.querySelector('label').textContent = copied ? 'URL (copied to clipboard)' : 'URL';
    setStatus(`Uploaded ${w} × ${h}`, 'ok');
    addHistory({ url, w, h, name: state.fileName, t: Date.now() });
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Upload failed.', 'error');
  } finally {
    progress.hidden = true;
    setBusy(null);
  }
}
uploadBtn.addEventListener('click', upload);

copyBtn.addEventListener('click', async () => {
  const ok = await copyToClipboard(resultUrl.value);
  copyBtn.textContent = ok ? 'Copied!' : 'Failed';
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
});
resultUrl.addEventListener('focus', () => resultUrl.select());

// ---------- History ----------
function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS.history)) || []; } catch { return []; }
}
function addHistory(item) {
  const list = [item, ...getHistory().filter((i) => i.url !== item.url)].slice(0, HISTORY_MAX);
  localStorage.setItem(LS.history, JSON.stringify(list));
  renderHistory();
}
function thumbUrl(url) {
  return url.replace('/image/upload/', '/image/upload/c_fill,w_88,h_88/');
}
function renderHistory() {
  const list = getHistory();
  historyPanel.hidden = !list.length;
  historyEl.innerHTML = '';
  for (const item of list) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = thumbUrl(item.url);
    img.alt = '';
    img.loading = 'lazy';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name || 'image';
    name.title = item.url;
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.textContent = `${item.w} × ${item.h} · ${new Date(item.t).toLocaleDateString()}`;
    meta.append(name, sub);
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      const ok = await copyToClipboard(item.url);
      btn.textContent = ok ? 'Copied!' : 'Failed';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
    li.append(img, meta, btn);
    historyEl.append(li);
  }
}
renderHistory();

// ---------- Settings ----------
function openSettings() {
  const s = getSettings();
  cfgEndpoint.value = s.endpoint;
  cfgKey.value = s.key;
  settingsDlg.showModal();
}
settingsBtn.addEventListener('click', openSettings);
settingsForm.addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'save') {
    localStorage.setItem(LS.settings, JSON.stringify({
      endpoint: cfgEndpoint.value.trim() || DEFAULT_ENDPOINT,
      key: cfgKey.value.trim(),
    }));
    setStatus('Settings saved.', 'ok');
  }
});

if (!getSettings().key) setStatus('Tip: open ⚙ Settings and enter your upload access key.');
updateInfo();
