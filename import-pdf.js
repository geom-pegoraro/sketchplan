/**
 * PlanSketcher – import-pdf.js  v3.0
 *
 * Flusso completamente ridisegnato:
 *  1. Upload PDF o immagine (JPG/PNG) → anteprima come sfondo
 *  2. Calibrazione: 2 click sul disegno → inserisci lunghezza reale → definisce px/cm
 *  3. L'immagine diventa overlay sul canvas principale con barra trasparenza regolabile
 *  4. L'utente disegna muri/porte/ecc. sopra l'overlay manualmente
 *  5. Clic "OK – Rimuovi Immagine" → overlay rimosso, rimangono solo gli elementi disegnati
 */

'use strict';

// ============================================================
// STATO IMPORT
// ============================================================

const importState = {
  sourceImage:      null,   // HTMLImageElement pronto
  sourceDataURL:    null,
  sourceWidth:      0,
  sourceHeight:     0,

  calibPt1:         null,
  calibPt2:         null,
  calibLenCm:       0,
  pixelPerCm:       0,

  importCanvas:     null,
  importCtx:        null,
  importPhase:      'idle',
  _fitScale:        1,
  _offX:            0,
  _offY:            0,
  _hoverPos:        null,

  overlay: {
    active:   false,
    opacity:  0.35,
    image:    null,
    x: 0, y: 0,
    w: 0, h: 0,
  },
};

// ============================================================
// INIT
// ============================================================

function initImportScreen() {
  const fileInput = document.getElementById('import-pdf-file');
  fileInput.setAttribute('accept', 'application/pdf,image/jpeg,image/png,image/jpg');
  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    await loadImportFile(file);
  });

  document.getElementById('btn-calib-confirm').addEventListener('click', () => {
    const cm = parseFloat(document.getElementById('input-calib-len').value);
    if (!cm || cm <= 0) { showImportToast('Inserisci una lunghezza valida', 'warn'); return; }
    importState.calibLenCm = cm;
    finalizeCalibration();
  });
  document.getElementById('input-calib-len').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-calib-confirm').click();
  });

  document.getElementById('btn-import-cancel').addEventListener('click', cancelImport);

  // Slider trasparenza
  const slider = document.getElementById('overlay-opacity-slider');
  if (slider) {
    slider.addEventListener('input', () => {
      importState.overlay.opacity = parseFloat(slider.value);
      const valEl = document.getElementById('overlay-opacity-value');
      if (valEl) valEl.textContent = Math.round(importState.overlay.opacity * 100) + '%';
      redraw();
    });
  }

  // Toggle visibilità
  const btnToggle = document.getElementById('btn-overlay-toggle');
  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      importState.overlay.active = !importState.overlay.active;
      btnToggle.textContent = importState.overlay.active ? '👁 Nascondi Sfondo' : '👁 Mostra Sfondo';
      redraw();
    });
  }

  // OK rimuovi immagine
  const btnDone = document.getElementById('btn-overlay-done');
  if (btnDone) btnDone.addEventListener('click', acceptImport);

  // Canvas anteprima
  const ic = document.getElementById('import-canvas');
  importState.importCanvas = ic;
  importState.importCtx    = ic ? ic.getContext('2d') : null;
  if (ic) {
    ic.addEventListener('click',     onImportCanvasClick);
    ic.addEventListener('mousemove', onImportCanvasHover);
    ic.addEventListener('touchstart', onImportCanvasTouch, { passive: false });
  }

  window.addEventListener('resize', resizeImportCanvas);
  resizeImportCanvas();
}

function resizeImportCanvas() {
  const ic   = importState.importCanvas;
  const wrap = document.getElementById('import-canvas-wrap');
  if (!ic || !wrap) return;
  ic.width  = wrap.clientWidth  || window.innerWidth;
  ic.height = wrap.clientHeight || Math.max(300, window.innerHeight - 140);
  renderImportCanvas();
}

// ============================================================
// CARICAMENTO FILE
// ============================================================

async function loadImportFile(file) {
  showImportScreen('import-screen');
  setImportPhase('loading');
  renderImportCanvas();

  try {
    if (file.type === 'application/pdf') {
      await loadPDFAsImage(file);
    } else if (file.type.startsWith('image/')) {
      await loadImageFile(file);
    } else {
      showImportToast('Formato non supportato. Usa PDF, JPG o PNG.', 'error', 5000);
      setImportPhase('idle');
      showImportScreen('home-screen');
    }
  } catch (err) {
    console.error('Import error:', err);
    showImportToast('Errore: ' + (err.message || '').slice(0, 80), 'error', 6000);
    setImportPhase('idle');
    showImportScreen('home-screen');
  }
}

async function loadPDFAsImage(file) {
  const PDFJSCDN     = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  await loadScript(PDFJSCDN);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

  const buf      = await file.arrayBuffer();
  const pdfDoc   = await pdfjsLib.getDocument({ data: buf }).promise;
  const page     = await pdfDoc.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });

  const offC   = document.createElement('canvas');
  offC.width   = viewport.width;
  offC.height  = viewport.height;
  const offCtx = offC.getContext('2d');
  offCtx.fillStyle = '#ffffff';
  offCtx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: offCtx, viewport }).promise;

  const dataURL = offC.toDataURL('image/png', 0.92);
  await setupImportImage(dataURL, viewport.width, viewport.height);
}

async function loadImageFile(file) {
  const dataURL = await new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload  = e => res(e.target.result);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
  const img = await loadImageFromURL(dataURL);
  await setupImportImage(dataURL, img.naturalWidth, img.naturalHeight);
}

async function setupImportImage(dataURL, w, h) {
  const img = await loadImageFromURL(dataURL);
  importState.sourceImage   = img;
  importState.sourceDataURL = dataURL;
  importState.sourceWidth   = w;
  importState.sourceHeight  = h;
  importState.calibPt1      = null;
  importState.calibPt2      = null;
  importState.pixelPerCm    = 0;

  setImportPhase('pick1');
  resizeImportCanvas();
  renderImportCanvas();
  showImportToast('Clicca il PRIMO punto di riferimento sul disegno', 'info', 7000);
}

function loadImageFromURL(url) {
  return new Promise((res, rej) => {
    const img  = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error('Impossibile caricare immagine'));
    img.src     = url;
  });
}

// ============================================================
// CALIBRAZIONE
// ============================================================

function finalizeCalibration() {
  const p1 = importState.calibPt1, p2 = importState.calibPt2;
  if (!p1 || !p2) return;

  const pxDist = Math.sqrt(
    (p2.srcX - p1.srcX) ** 2 + (p2.srcY - p1.srcY) ** 2
  );
  importState.pixelPerCm = pxDist / importState.calibLenCm;

  document.getElementById('import-calib-panel').classList.remove('visible');
  setImportPhase('ready');
  activateOverlay();

  showImportToast(
    'Scala calibrata! Disegna gli elementi. Poi clicca "OK – Rimuovi Immagine".',
    'info', 9000
  );
}

function activateOverlay() {
  if (!importState.sourceImage || !importState.pixelPerCm) return;

  // Rapporto pixel-sorgente → pixel-canvas
  // 1 px sorgente = (1/pixelPerCm) cm = (1/pixelPerCm/100) m
  // Nel canvas: state.scale px = 1m → 1 px sorgente = state.scale/(pixelPerCm*100) px canvas
  const ratio = state.scale / (importState.pixelPerCm * 100);

  importState.overlay.x      = 0;
  importState.overlay.y      = 0;
  importState.overlay.w      = importState.sourceWidth  * ratio;
  importState.overlay.h      = importState.sourceHeight * ratio;
  importState.overlay.image  = importState.sourceImage;
  importState.overlay.active = true;
  importState.overlay.opacity = 0.35;

  // Sincronizza slider
  const slider = document.getElementById('overlay-opacity-slider');
  if (slider) {
    slider.value = importState.overlay.opacity;
    const valEl = document.getElementById('overlay-opacity-value');
    if (valEl) valEl.textContent = Math.round(importState.overlay.opacity * 100) + '%';
  }

  // Mostra controlli overlay
  const btnToggle = document.getElementById('btn-overlay-toggle');
  const btnDone   = document.getElementById('btn-overlay-done');
  const opCtrl    = document.getElementById('overlay-opacity-ctrl');
  if (btnToggle) { btnToggle.textContent = '👁 Nascondi Sfondo'; btnToggle.style.display = 'inline-flex'; }
  if (btnDone)   btnDone.style.display   = 'inline-flex';
  if (opCtrl)    opCtrl.style.display    = 'flex';

  // Vai al canvas
  showScreen('canvas-screen');
  resizeCanvas();

  // Adatta la vista all'immagine
  const pad = 40;
  const iW  = importState.overlay.w + pad * 2;
  const iH  = importState.overlay.h + pad * 2;
  const z   = Math.min(state.canvas.width / iW, state.canvas.height / iH, 2);
  state.zoom    = z;
  state.offsetX = pad / z;
  state.offsetY = pad / z;

  redraw();
}

// ============================================================
// ACCETTA / ANNULLA
// ============================================================

function acceptImport() {
  importState.overlay.active = false;
  importState.overlay.image  = null;
  importState.sourceImage    = null;
  importState.sourceDataURL  = null;
  importState.importPhase    = 'idle';

  const btnToggle = document.getElementById('btn-overlay-toggle');
  const btnDone   = document.getElementById('btn-overlay-done');
  const opCtrl    = document.getElementById('overlay-opacity-ctrl');
  if (btnToggle) btnToggle.style.display = 'none';
  if (btnDone)   btnDone.style.display   = 'none';
  if (opCtrl)    opCtrl.style.display    = 'none';

  const rb = document.getElementById('import-review-bar');
  if (rb) rb.classList.remove('visible');

  saveProject();
  redraw();
  showToast('✓ Immagine rimossa — planimetria completata');
}

function cancelImport() {
  importState.importPhase   = 'idle';
  importState.sourceImage   = null;
  importState.calibPt1      = null;
  importState.calibPt2      = null;
  document.getElementById('import-calib-panel').classList.remove('visible');
  showImportScreen('home-screen');
}

// ============================================================
// RENDER CANVAS ANTEPRIMA
// ============================================================

function renderImportCanvas() {
  const ic  = importState.importCanvas;
  const ctx = importState.importCtx;
  if (!ic || !ctx) return;

  ctx.clearRect(0, 0, ic.width, ic.height);
  ctx.fillStyle = '#0e0e16';
  ctx.fillRect(0, 0, ic.width, ic.height);

  if (importState.importPhase === 'loading') {
    ctx.fillStyle = '#4cc9f0';
    ctx.font = 'bold 16px DM Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Caricamento…', ic.width / 2, ic.height / 2);
    return;
  }

  if (!importState.sourceImage) return;

  const PAD  = 32;
  const sx   = (ic.width  - PAD * 2) / importState.sourceWidth;
  const sy   = (ic.height - PAD * 2) / importState.sourceHeight;
  const fs   = Math.min(sx, sy);
  const drawW = importState.sourceWidth  * fs;
  const drawH = importState.sourceHeight * fs;
  const offX  = (ic.width  - drawW) / 2;
  const offY  = (ic.height - drawH) / 2;

  importState._fitScale = fs;
  importState._offX     = offX;
  importState._offY     = offY;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur  = 24;
  ctx.drawImage(importState.sourceImage, offX, offY, drawW, drawH);
  ctx.shadowBlur  = 0;
  ctx.restore();

  // Punti calibrazione
  const p1 = importState.calibPt1;
  const p2 = importState.calibPt2;
  if (p1) drawCalibPoint(ctx, p1.cx, p1.cy, '#f0a500', '1');
  if (p2) drawCalibPoint(ctx, p2.cx, p2.cy, '#4cc9f0', '2');

  if (p1 && p2) {
    ctx.beginPath();
    ctx.moveTo(p1.cx, p1.cy); ctx.lineTo(p2.cx, p2.cy);
    ctx.strokeStyle = 'rgba(240,165,0,0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]); ctx.stroke(); ctx.setLineDash([]);
    const mx  = (p1.cx + p2.cx) / 2;
    const my  = (p1.cy + p2.cy) / 2;
    const spx = Math.round(Math.sqrt((p2.srcX - p1.srcX) ** 2 + (p2.srcY - p1.srcY) ** 2));
    ctx.font = 'bold 12px DM Mono,monospace';
    ctx.fillStyle = '#f0a500'; ctx.textAlign = 'center';
    ctx.fillText(spx + ' px', mx, my - 10);
  }

  // Crosshair hover
  if (importState._hoverPos &&
      (importState.importPhase === 'pick1' || importState.importPhase === 'pick2')) {
    const { hx, hy } = importState._hoverPos;
    ctx.strokeStyle = 'rgba(240,165,0,0.4)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(hx, 0);  ctx.lineTo(hx, ic.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, hy);  ctx.lineTo(ic.width, hy);  ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawCalibPoint(ctx, x, y, color, label) {
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fillStyle   = color + 'aa';
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.fill(); ctx.stroke();
  ctx.font      = 'bold 11px DM Mono,monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(label, x, y - 15);
}

// ============================================================
// EVENTI CANVAS ANTEPRIMA
// ============================================================

function onImportCanvasClick(e) {
  const rect = importState.importCanvas.getBoundingClientRect();
  registerCalibClick(e.clientX - rect.left, e.clientY - rect.top);
}

function onImportCanvasTouch(e) {
  e.preventDefault();
  if (!e.touches.length) return;
  const rect = importState.importCanvas.getBoundingClientRect();
  registerCalibClick(e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
}

function registerCalibClick(cx, cy) {
  const fs   = importState._fitScale || 1;
  const srcX = (cx - importState._offX) / fs;
  const srcY = (cy - importState._offY) / fs;

  if (importState.importPhase === 'pick1') {
    importState.calibPt1 = { cx, cy, srcX, srcY };
    setImportPhase('pick2');
    renderImportCanvas();
    showImportToast('Ora clicca il SECONDO punto di riferimento', 'info', 5000);

  } else if (importState.importPhase === 'pick2') {
    importState.calibPt2 = { cx, cy, srcX, srcY };
    setImportPhase('calib-input');
    renderImportCanvas();

    const spx = Math.round(Math.sqrt(
      (importState.calibPt2.srcX - importState.calibPt1.srcX) ** 2 +
      (importState.calibPt2.srcY - importState.calibPt1.srcY) ** 2
    ));
    const pdEl = document.getElementById('import-calib-pxdist');
    if (pdEl) pdEl.textContent = spx + ' px';
    document.getElementById('import-calib-panel').classList.add('visible');
    const inp = document.getElementById('input-calib-len');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 100); }
  }
}

function onImportCanvasHover(e) {
  if (importState.importPhase !== 'pick1' && importState.importPhase !== 'pick2') return;
  const rect = importState.importCanvas.getBoundingClientRect();
  importState._hoverPos = { hx: e.clientX - rect.left, hy: e.clientY - rect.top };
  renderImportCanvas();
}

// ============================================================
// HOOK REDRAW — disegna overlay sull'app canvas
// ============================================================

function onRedrawHook(ctx) {
  const ov = importState.overlay;
  if (!ov.active || !ov.image || !ov.image.complete) return;
  if (ov.opacity <= 0) return;

  ctx.save();
  ctx.globalAlpha = ov.opacity;
  ctx.drawImage(ov.image, ov.x, ov.y, ov.w, ov.h);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ============================================================
// UI HELPERS
// ============================================================

function setImportPhase(phase) {
  importState.importPhase = phase;
  const labels = {
    loading:       'Caricamento immagine…',
    pick1:         '① Clicca il PRIMO punto di riferimento',
    pick2:         '② Clicca il SECONDO punto di riferimento',
    'calib-input': '③ Inserisci la lunghezza reale tra i 2 punti',
    ready:         'Disegna sopra l\'immagine sfondo — poi clicca OK',
    idle:          '',
  };
  const el = document.getElementById('import-phase-label');
  if (el) el.textContent = labels[phase] || '';
}

let _importToastTimer = null;
function showImportToast(msg, type = 'info', duration = 3000) {
  const el = document.getElementById('import-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `import-toast visible ${type}`;
  if (_importToastTimer) clearTimeout(_importToastTimer);
  _importToastTimer = setTimeout(() => el.classList.remove('visible'), duration);
}

function showImportScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ============================================================
// loadScript (usato per PDF.js)
// ============================================================
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s   = document.createElement('script');
    s.src     = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error('Script non caricato: ' + src));
    document.head.appendChild(s);
  });
}
