/**
 * PlanSketcher – import-pdf.js  v3.1
 *
 * Fix rispetto a v3.0:
 *  - Zoom e pan nella schermata calibrazione (pinch, scroll, drag)
 *  - Scala corretta: i punti vengono salvati in coordinate IMMAGINE SORGENTE
 *    (indipendenti dallo zoom/pan del canvas di calibrazione)
 *  - Verifica scala: mostra la misura calcolata in overlay dopo calibrazione
 *  - Elementi (porte/finestre/pilastri) hanno dimensioni default in cm → scalati
 *    correttamente tramite state.scale che rimane quello del progetto
 */

'use strict';

// ============================================================
// STATO IMPORT
// ============================================================

const importState = {
  sourceImage:    null,   // HTMLImageElement (immagine sorgente ad alta risoluzione)
  sourceDataURL:  null,
  sourceWidth:    0,      // larghezza in px della sorgente
  sourceHeight:   0,      // altezza in px della sorgente

  // Calibrazione — coordinate in px SORGENTE (invarianti allo zoom)
  calibPt1:       null,   // { srcX, srcY, screenX, screenY }
  calibPt2:       null,
  calibLenCm:     0,
  pixelPerCm:     0,      // px-sorgente per cm reale

  // Canvas di calibrazione con zoom/pan proprio
  importCanvas:   null,
  importCtx:      null,
  importPhase:    'idle',

  // Trasformazione del canvas di calibrazione (zoom/pan indipendente)
  view: {
    zoom:    1,
    offX:    0,   // offset in px schermo (dopo zoom)
    offY:    0,
  },

  // Stato pan
  _panning:       false,
  _panStart:      null,
  _pinchDist:     0,
  _lastTouches:   [],

  _hoverSrcX:     null,   // posizione hover in coordinate sorgente
  _hoverSrcY:     null,

  // Overlay sul canvas principale (dopo calibrazione)
  overlay: {
    active:   false,
    opacity:  0.35,
    image:    null,
    x: 0, y: 0, w: 0, h: 0,
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

  document.getElementById('btn-calib-confirm').addEventListener('click', onCalibConfirm);
  document.getElementById('input-calib-len').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-calib-confirm').click();
  });

  // Ripeti: azzera i punti e torna a pick1
  const btnReset = document.getElementById('btn-calib-reset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      importState.calibPt1 = null;
      importState.calibPt2 = null;
      document.getElementById('import-calib-panel').classList.remove('visible');
      setImportPhase('pick1');
      renderImportCanvas();
      showImportToast('Punti azzerati — clicca il PRIMO punto di riferimento.', 'info', 4000);
    });
  }

  document.getElementById('btn-import-cancel').addEventListener('click', cancelImport);

  // Slider trasparenza overlay
  const slider = document.getElementById('overlay-opacity-slider');
  if (slider) {
    slider.addEventListener('input', () => {
      importState.overlay.opacity = parseFloat(slider.value);
      const valEl = document.getElementById('overlay-opacity-value');
      if (valEl) valEl.textContent = Math.round(importState.overlay.opacity * 100) + '%';
      redraw();
    });
  }

  // Toggle visibilità overlay
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

  // Setup canvas di calibrazione
  const ic = document.getElementById('import-canvas');
  importState.importCanvas = ic;
  importState.importCtx    = ic ? ic.getContext('2d') : null;

  if (ic) {
    // Click (desktop) — solo se non stava facendo pan
    ic.addEventListener('mousedown',  onImportMouseDown);
    ic.addEventListener('mousemove',  onImportMouseMove);
    ic.addEventListener('mouseup',    onImportMouseUp);
    ic.addEventListener('mouseleave', onImportMouseLeave);
    ic.addEventListener('wheel',      onImportWheel, { passive: false });
    // Touch
    ic.addEventListener('touchstart', onImportTouchStart, { passive: false });
    ic.addEventListener('touchmove',  onImportTouchMove,  { passive: false });
    ic.addEventListener('touchend',   onImportTouchEnd,   { passive: false });
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
  fitImageInView();
  renderImportCanvas();
}

/** Adatta la view iniziale per mostrare tutta l'immagine */
function fitImageInView() {
  const ic = importState.importCanvas;
  if (!ic || !importState.sourceImage) return;
  const PAD = 32;
  const sx  = (ic.width  - PAD * 2) / importState.sourceWidth;
  const sy  = (ic.height - PAD * 2) / importState.sourceHeight;
  const z   = Math.min(sx, sy, 1);
  importState.view.zoom = z;
  importState.view.offX = (ic.width  - importState.sourceWidth  * z) / 2;
  importState.view.offY = (ic.height - importState.sourceHeight * z) / 2;
}

// ============================================================
// CONVERSIONI COORDINATE
// ============================================================

/** Coordinate canvas-screen → coordinate immagine-sorgente */
function screenToSrc(sx, sy) {
  const v = importState.view;
  return {
    x: (sx - v.offX) / v.zoom,
    y: (sy - v.offY) / v.zoom,
  };
}

/** Coordinate immagine-sorgente → coordinate canvas-screen */
function srcToScreen(ix, iy) {
  const v = importState.view;
  return {
    x: ix * v.zoom + v.offX,
    y: iy * v.zoom + v.offY,
  };
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
      await loadRawImage(file);
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

  const buf    = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
  const page   = await pdfDoc.getPage(1);

  // IMPORTANTE: usiamo scale 1.0 per avere pixel = punti PDF reali.
  // Useremo scale 3.0 solo per la qualità visiva, ma salviamo la
  // dimensione in punti PDF (scale 1.0) come riferimento per la calibrazione,
  // così pixelPerCm sarà coerente con i pixel sorgente dell'immagine ad alta ris.
  //
  // Strategia: renderizziamo a scale 3.0 per qualità, ma ricordiamo il fattore
  // di render così da convertire correttamente px-immagine → cm reali.
  const RENDER_SCALE = 3.0;
  const viewport     = page.getViewport({ scale: RENDER_SCALE });

  const offC   = document.createElement('canvas');
  offC.width   = viewport.width;
  offC.height  = viewport.height;
  const offCtx = offC.getContext('2d');
  offCtx.fillStyle = '#ffffff';
  offCtx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: offCtx, viewport }).promise;

  const dataURL = offC.toDataURL('image/png', 0.92);
  await setupImportImage(dataURL, offC.width, offC.height);
}

async function loadRawImage(file) {
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
  resizeImportCanvas(); // chiama anche fitImageInView
  renderImportCanvas();
  showImportToast('Usa scroll/pinch per zoomare. Clicca il PRIMO punto di riferimento.', 'info', 8000);
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

function onCalibConfirm() {
  const cm = parseFloat(document.getElementById('input-calib-len').value);
  if (!cm || cm <= 0) { showImportToast('Inserisci una lunghezza valida', 'warn'); return; }
  importState.calibLenCm = cm;
  finalizeCalibration();
}

function finalizeCalibration() {
  const p1 = importState.calibPt1, p2 = importState.calibPt2;
  if (!p1 || !p2) return;

  // Distanza in pixel SORGENTE tra i due punti
  const pxDist = Math.sqrt(
    (p2.srcX - p1.srcX) ** 2 + (p2.srcY - p1.srcY) ** 2
  );
  importState.pixelPerCm = pxDist / importState.calibLenCm;

  document.getElementById('import-calib-panel').classList.remove('visible');
  setImportPhase('ready');
  activateOverlay();

  const scalaCm = Math.round(importState.calibLenCm);
  showImportToast(
    `✓ Scala: ${scalaCm} cm = ${Math.round(pxDist)} px sorgente. Disegna sopra l'immagine sfondo.`,
    'info', 10000
  );
}

function activateOverlay() {
  if (!importState.sourceImage || !importState.pixelPerCm) return;

  // Conversione px-sorgente → px-canvas:
  //   1 px-sorgente = (1 / pixelPerCm) cm
  //   1 cm = state.scale / 100 px-canvas  (state.scale = px per metro → /100 = px per cm)
  //   → ratio = state.scale / 100 / pixelPerCm  (px-canvas per px-sorgente)
  const ratio = (state.scale / 100) / importState.pixelPerCm;

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
    const valEl  = document.getElementById('overlay-opacity-value');
    if (valEl) valEl.textContent = Math.round(importState.overlay.opacity * 100) + '%';
  }

  // Mostra controlli
  const btnToggle = document.getElementById('btn-overlay-toggle');
  const btnDone   = document.getElementById('btn-overlay-done');
  const opCtrl    = document.getElementById('overlay-opacity-ctrl');
  if (btnToggle) { btnToggle.textContent = '👁 Nascondi Sfondo'; btnToggle.style.display = 'inline-flex'; }
  if (btnDone)   btnDone.style.display   = 'inline-flex';
  if (opCtrl)    opCtrl.style.display    = 'flex';

  // Vai al canvas principale
  showScreen('canvas-screen');
  resizeCanvas();

  // Adatta la vista al contenuto
  const pad = 60;
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
  importState.overlay.active = false;
  importState.sourceImage   = null;
  importState.calibPt1      = null;
  importState.calibPt2      = null;
  document.getElementById('import-calib-panel').classList.remove('visible');

  // Nascondi anche i controlli overlay se erano visibili
  const btnToggle = document.getElementById('btn-overlay-toggle');
  const btnDone   = document.getElementById('btn-overlay-done');
  const opCtrl    = document.getElementById('overlay-opacity-ctrl');
  if (btnToggle) btnToggle.style.display = 'none';
  if (btnDone)   btnDone.style.display   = 'none';
  if (opCtrl)    opCtrl.style.display    = 'none';

  showImportScreen('home-screen');
}

// ============================================================
// RENDER CANVAS CALIBRAZIONE
// ============================================================

function renderImportCanvas() {
  const ic  = importState.importCanvas;
  const ctx = importState.importCtx;
  if (!ic || !ctx) return;

  ctx.clearRect(0, 0, ic.width, ic.height);

  // Sfondo a griglia fine
  ctx.fillStyle = '#0e0e16';
  ctx.fillRect(0, 0, ic.width, ic.height);
  drawImportGrid(ctx, ic.width, ic.height);

  if (importState.importPhase === 'loading') {
    ctx.fillStyle = '#4cc9f0';
    ctx.font = 'bold 15px DM Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Caricamento…', ic.width / 2, ic.height / 2);
    return;
  }

  if (!importState.sourceImage) return;

  const v = importState.view;

  // Immagine con trasformazione zoom/pan
  ctx.save();
  // Ombra
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur  = 20;
  ctx.drawImage(
    importState.sourceImage,
    v.offX, v.offY,
    importState.sourceWidth  * v.zoom,
    importState.sourceHeight * v.zoom
  );
  ctx.shadowBlur = 0;
  ctx.restore();

  // Bordo immagine
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(
    v.offX, v.offY,
    importState.sourceWidth  * v.zoom,
    importState.sourceHeight * v.zoom
  );

  // Punti calibrazione (in coordinate schermo)
  const p1 = importState.calibPt1;
  const p2 = importState.calibPt2;

  if (p1) {
    const s1 = srcToScreen(p1.srcX, p1.srcY);
    drawCalibPoint(ctx, s1.x, s1.y, '#f0a500', '1');
  }
  if (p2) {
    const s2 = srcToScreen(p2.srcX, p2.srcY);
    drawCalibPoint(ctx, s2.x, s2.y, '#4cc9f0', '2');
  }

  if (p1 && p2) {
    const s1 = srcToScreen(p1.srcX, p1.srcY);
    const s2 = srcToScreen(p2.srcX, p2.srcY);
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
    ctx.strokeStyle = 'rgba(240,165,0,0.9)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([8, 4]); ctx.stroke(); ctx.setLineDash([]);

    // Etichetta distanza in px-sorgente
    const pxDist = Math.round(Math.sqrt(
      (p2.srcX - p1.srcX) ** 2 + (p2.srcY - p1.srcY) ** 2
    ));
    const mx = (s1.x + s2.x) / 2;
    const my = (s1.y + s2.y) / 2;
    ctx.font = 'bold 12px DM Mono,monospace';
    ctx.fillStyle = '#f0a500'; ctx.textAlign = 'center';
    // Sfondo per leggibilità
    ctx.fillStyle = 'rgba(14,14,22,0.8)';
    ctx.fillRect(mx - 30, my - 22, 60, 18);
    ctx.fillStyle = '#f0a500';
    ctx.fillText(pxDist + ' px', mx, my - 8);

    // Se calibrazione già confermata, mostra anche la misura reale
    if (importState.pixelPerCm > 0) {
      const realCm = Math.round(pxDist / importState.pixelPerCm);
      ctx.fillStyle = 'rgba(14,14,22,0.8)';
      ctx.fillRect(mx - 35, my + 6, 70, 18);
      ctx.fillStyle = '#4cc9f0';
      ctx.fillText(`= ${realCm} cm`, mx, my + 20);
    }
  }

  // Crosshair hover in coordinate schermo
  if (importState._hoverSrcX !== null &&
      (importState.importPhase === 'pick1' || importState.importPhase === 'pick2')) {
    const hs = srcToScreen(importState._hoverSrcX, importState._hoverSrcY);
    ctx.strokeStyle = 'rgba(240,165,0,0.5)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(hs.x, 0);       ctx.lineTo(hs.x, ic.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, hs.y);        ctx.lineTo(ic.width, hs.y);  ctx.stroke();
    ctx.setLineDash([]);

    // Coordinata hover
    ctx.font = '10px DM Mono,monospace';
    ctx.fillStyle = 'rgba(240,165,0,0.8)';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${Math.round(importState._hoverSrcX)}, ${Math.round(importState._hoverSrcY)} px`,
      hs.x + 6, hs.y - 6
    );
  }

  // HUD zoom
  ctx.font = '10px DM Mono,monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(importState.view.zoom * 100)}%  scroll=zoom  drag=pan`, ic.width - 8, ic.height - 8);
}

function drawImportGrid(ctx, w, h) {
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth   = 1;
  const gs = 40;
  for (let x = 0; x < w; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}

function drawCalibPoint(ctx, x, y, color, label) {
  // Cerchio esterno
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fillStyle   = color + '33';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.stroke();

  // Croce interna
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();

  // Etichetta
  ctx.font      = 'bold 11px DM Mono,monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  // Sfondo
  ctx.fillStyle = 'rgba(14,14,22,0.85)';
  ctx.fillRect(x - 7, y - 26, 14, 16);
  ctx.fillStyle = color;
  ctx.fillText(label, x, y - 14);
}

// ============================================================
// EVENTI MOUSE — zoom/pan + click calibrazione
// ============================================================

let _mouseDownPos  = null;   // posizione mousedown in px schermo
let _didPan        = false;  // se durante mousedown si è spostato abbastanza → è un pan

function onImportMouseDown(e) {
  if (e.button !== 0) return;
  const pos = getImportCanvasPos(e);
  _mouseDownPos = pos;
  _didPan       = false;
  importState._panning  = true;
  importState._panStart = { x: pos.x - importState.view.offX, y: pos.y - importState.view.offY };
  importState.importCanvas.style.cursor = 'grabbing';
}

function onImportMouseMove(e) {
  const pos = getImportCanvasPos(e);

  // Aggiorna hover in coordinate sorgente
  const src = screenToSrc(pos.x, pos.y);
  importState._hoverSrcX = src.x;
  importState._hoverSrcY = src.y;

  if (importState._panning && importState._panStart) {
    const dx = pos.x - (_mouseDownPos ? _mouseDownPos.x : pos.x);
    const dy = pos.y - (_mouseDownPos ? _mouseDownPos.y : pos.y);
    if (!_didPan && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) _didPan = true;

    if (_didPan) {
      importState.view.offX = pos.x - importState._panStart.x;
      importState.view.offY = pos.y - importState._panStart.y;
    }
  }

  renderImportCanvas();
}

function onImportMouseUp(e) {
  const pos = getImportCanvasPos(e);
  importState._panning  = false;
  importState.importCanvas.style.cursor = 'crosshair';

  // Solo se non era un pan → registra punto calibrazione
  if (!_didPan) {
    registerCalibClick(pos.x, pos.y);
  }
  _mouseDownPos = null;
  _didPan       = false;
}

function onImportMouseLeave() {
  importState._panning = false;
  importState._hoverSrcX = null;
  importState._hoverSrcY = null;
  importState.importCanvas.style.cursor = 'crosshair';
  renderImportCanvas();
}

function onImportWheel(e) {
  e.preventDefault();
  const pos    = getImportCanvasPos(e);
  const delta  = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomImportAt(pos.x, pos.y, delta);
}

function zoomImportAt(cx, cy, factor) {
  const v      = importState.view;
  const newZ   = Math.max(0.1, Math.min(20, v.zoom * factor));
  const scaleD = newZ / v.zoom;
  v.offX = cx - scaleD * (cx - v.offX);
  v.offY = cy - scaleD * (cy - v.offY);
  v.zoom = newZ;
  renderImportCanvas();
}

function getImportCanvasPos(e) {
  const rect = importState.importCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ============================================================
// EVENTI TOUCH — pinch zoom + pan + tap calibrazione
// ============================================================

function onImportTouchStart(e) {
  e.preventDefault();
  importState._lastTouches = Array.from(e.touches);
  if (e.touches.length === 1) {
    const t   = e.touches[0];
    const pos = getTouchCanvasPos(t);
    _mouseDownPos = pos;
    _didPan       = false;
    importState._panStart = {
      x: pos.x - importState.view.offX,
      y: pos.y - importState.view.offY,
    };
  } else if (e.touches.length === 2) {
    importState._pinchDist = pinchDist(e.touches[0], e.touches[1]);
  }
}

function onImportTouchMove(e) {
  e.preventDefault();
  if (e.touches.length === 1 && importState._panStart) {
    const t   = e.touches[0];
    const pos = getTouchCanvasPos(t);
    const dx  = pos.x - (_mouseDownPos ? _mouseDownPos.x : pos.x);
    const dy  = pos.y - (_mouseDownPos ? _mouseDownPos.y : pos.y);
    if (!_didPan && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) _didPan = true;
    if (_didPan) {
      importState.view.offX = pos.x - importState._panStart.x;
      importState.view.offY = pos.y - importState._panStart.y;
    }
  } else if (e.touches.length === 2) {
    const newDist = pinchDist(e.touches[0], e.touches[1]);
    if (importState._pinchDist > 0) {
      const cx = (getTouchCanvasPos(e.touches[0]).x + getTouchCanvasPos(e.touches[1]).x) / 2;
      const cy = (getTouchCanvasPos(e.touches[0]).y + getTouchCanvasPos(e.touches[1]).y) / 2;
      zoomImportAt(cx, cy, newDist / importState._pinchDist);
    }
    importState._pinchDist = newDist;
    _didPan = true; // considera pinch come movimento → no tap
  }
  renderImportCanvas();
}

function onImportTouchEnd(e) {
  e.preventDefault();
  if (!_didPan && importState._lastTouches.length === 1) {
    const t   = importState._lastTouches[0];
    const pos = getTouchCanvasPos(t);
    registerCalibClick(pos.x, pos.y);
  }
  importState._lastTouches = [];
  importState._pinchDist   = 0;
  importState._panStart    = null;
  _mouseDownPos = null;
  _didPan       = false;
}

function getTouchCanvasPos(touch) {
  const rect = importState.importCanvas.getBoundingClientRect();
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

function pinchDist(t1, t2) {
  return Math.sqrt((t1.clientX - t2.clientX) ** 2 + (t1.clientY - t2.clientY) ** 2);
}

// ============================================================
// REGISTRA PUNTO CALIBRAZIONE
// ============================================================

function registerCalibClick(screenX, screenY) {
  if (importState.importPhase !== 'pick1' && importState.importPhase !== 'pick2') return;

  // Salva in coordinate SORGENTE (invarianti al zoom/pan)
  const src = screenToSrc(screenX, screenY);

  // Clamp all'interno dell'immagine
  const clamped = {
    srcX: Math.max(0, Math.min(importState.sourceWidth  - 1, src.x)),
    srcY: Math.max(0, Math.min(importState.sourceHeight - 1, src.y)),
  };

  if (importState.importPhase === 'pick1') {
    importState.calibPt1 = clamped;
    setImportPhase('pick2');
    renderImportCanvas();
    showImportToast('Punto 1 impostato. Ora clicca il SECONDO punto di riferimento.', 'info', 5000);

  } else if (importState.importPhase === 'pick2') {
    importState.calibPt2 = clamped;
    setImportPhase('calib-input');
    renderImportCanvas();

    const pxDist = Math.round(Math.sqrt(
      (clamped.srcX - importState.calibPt1.srcX) ** 2 +
      (clamped.srcY - importState.calibPt1.srcY) ** 2
    ));
    const pdEl = document.getElementById('import-calib-pxdist');
    if (pdEl) pdEl.textContent = pxDist + ' px';
    document.getElementById('import-calib-panel').classList.add('visible');
    const inp = document.getElementById('input-calib-len');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 100); }
    showImportToast('Inserisci la distanza reale tra i 2 punti in cm.', 'info', 6000);
  }
}

// ============================================================
// HOOK REDRAW — disegna overlay sul canvas principale dell'app
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
    pick1:         '① Scorri/zoom per navigare — clicca il PRIMO punto di riferimento',
    pick2:         '② Clicca il SECONDO punto di riferimento',
    'calib-input': '③ Inserisci la distanza reale tra i 2 punti',
    ready:         'Disegna sopra l\'immagine sfondo — poi clicca "OK – Rimuovi Immagine"',
    idle:          '',
  };
  const el = document.getElementById('import-phase-label');
  if (el) el.textContent = labels[phase] || '';
}

let _importToastTimer = null;
function showImportToast(msg, type = 'info', duration = 3500) {
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
// loadScript
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
