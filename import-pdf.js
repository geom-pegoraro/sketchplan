/**
 * PlanSketcher – import-pdf.js  v2.0
 *
 * Estrazione VETTORIALE diretta dai path PDF.js — 100% gratuito, nessuna API esterna.
 *
 * Flusso:
 *  1. Upload PDF → rasterizzazione per anteprima + estrazione operatori vettoriali
 *  2. Calibrazione: selezione 2 punti + lunghezza reale → scala px/cm
 *  3. Estrazione geometrica:
 *     - Linee / segmenti → candidati muri
 *     - Clustering per spessore → muri (coppie di linee parallele)
 *     - Archi bezier → porte
 *     - Pattern linee ravvicinate perpendicolari al muro → finestre
 *     - Rettangoli con linee interne dense → scale
 *  4. Rendering automatico + review con overlay PDF trasparente
 *  5. Accetta / Modifica / Elimina
 */

'use strict';

// ============================================================
// STATO IMPORT
// ============================================================

const importState = {
  pdfDoc:         null,
  pdfPage:        null,
  pdfCanvas:      null,
  pdfCtx:         null,
  pdfImageData:   null,
  pdfWidth:       0,
  pdfHeight:      0,
  pdfViewport:    null,
  rawOps:         null,   // { lines, curves, rects } estratti da PDF.js
  calibPt1:       null,
  calibPt2:       null,
  calibLenCm:     0,
  pixelPerCm:     0,
  importCanvas:   null,
  importCtx:      null,
  importPhase:    'idle',
  _fitScale:      1,
  pdfOffX:        0,
  pdfOffY:        0,
  _hoverPos:      null,
  pdfOverlay:     null,
  overlayVisible: true,
  _cachedOverlayImg: null,
};

const PDFJSCDN     = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ============================================================
// INIT UI
// ============================================================

function initImportScreen() {
  document.getElementById('import-pdf-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file || file.type !== 'application/pdf') {
      showImportToast('Seleziona un file PDF valido', 'warn'); return;
    }
    e.target.value = '';
    await loadPDF(file);
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
  document.getElementById('btn-review-accept').addEventListener('click', acceptImport);
  document.getElementById('btn-review-edit').addEventListener('click', editWithOverlay);
  document.getElementById('btn-review-discard').addEventListener('click', discardImport);
  document.getElementById('btn-overlay-toggle').addEventListener('click', togglePdfOverlay);
  document.getElementById('btn-overlay-done').addEventListener('click', acceptImport);

  const ic = document.getElementById('import-canvas');
  importState.importCanvas = ic;
  importState.importCtx    = ic.getContext('2d');
  ic.addEventListener('click',     onImportCanvasClick);
  ic.addEventListener('mousemove', onImportCanvasHover);

  window.addEventListener('resize', resizeImportCanvas);
  resizeImportCanvas();
}

function resizeImportCanvas() {
  const ic   = importState.importCanvas;
  const wrap = document.getElementById('import-canvas-wrap');
  if (!ic || !wrap) return;
  ic.width  = wrap.clientWidth;
  ic.height = wrap.clientHeight;
  renderImportCanvas();
}

// ============================================================
// CARICAMENTO PDF + ESTRAZIONE VETTORIALE
// ============================================================

async function loadPDF(file) {
  showImportScreen('import-screen');
  setImportPhase('loading');

  try {
    await loadScript(PDFJSCDN);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    importState.pdfDoc = pdfDoc;

    const page     = await pdfDoc.getPage(1);
    importState.pdfPage = page;

    // Viewport 2× per anteprima
    const viewport = page.getViewport({ scale: 2.0 });
    importState.pdfViewport = viewport;
    importState.pdfWidth    = viewport.width;
    importState.pdfHeight   = viewport.height;

    // Rasterizza per anteprima
    const offC = document.createElement('canvas');
    offC.width  = viewport.width;
    offC.height = viewport.height;
    const offCtx = offC.getContext('2d');
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvasContext: offCtx, viewport }).promise;
    importState.pdfCanvas    = offC;
    importState.pdfCtx       = offCtx;
    importState.pdfImageData = offC.toDataURL('image/png', 0.92);

    // Estrai operatori vettoriali
    showImportToast('Estrazione geometria vettoriale...', 'info', 8000);
    const ops = await extractVectorOps(page, viewport);
    importState.rawOps = ops;

    setImportPhase('pick1');
    importState.calibPt1 = null;
    importState.calibPt2 = null;
    resizeImportCanvas();
    renderImportCanvas();
    showImportToast('Clicca il PRIMO punto di riferimento sul disegno', 'info', 7000);

  } catch (err) {
    console.error('PDF load error:', err);
    showImportToast('Errore: ' + err.message.slice(0, 80), 'error', 6000);
    setImportPhase('idle');
    showImportScreen('home-screen');
  }
}

// ============================================================
// ESTRAZIONE — APPROCCIO IBRIDO: VETTORI + PIXEL ANALYSIS
// ============================================================

/**
 * Prova prima l'estrazione vettoriale (PDF con path reali).
 * Se il PDF contiene principalmente immagini rasterizzate (imageXObject),
 * cade in automatico sull'analisi pixel del canvas renderizzato.
 * Tutto locale, nessuna API esterna.
 */
async function extractVectorOps(page, viewport) {
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const OPS = pdfjsLib.OPS;

  // Conta quante linee vettoriali reali ci sono vs immagini
  let realLines = 0, hasImage = false;
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] === OPS.paintImageXObject) hasImage = true;
    if (fnArray[i] === OPS.constructPath) {
      const subOps = argsArray[i][0];
      realLines += subOps.filter(op => op === OPS.lineTo).length;
    }
    if (fnArray[i] === OPS.lineTo) realLines++;
  }

  // Se ci sono poche linee vettoriali ma c'è un'immagine → usa pixel analysis
  // Soglia: almeno 20 linee vettoriali per considerare il PDF "vettoriale"
  if (hasImage && realLines < 20) {
    console.log('[Import] PDF raster rilevato (' + realLines + ' linee vec), uso pixel analysis');
    return extractFromPixels(page, viewport);
  }

  console.log('[Import] PDF vettoriale rilevato (' + realLines + ' linee), uso estrazione vettoriale');
  return extractVectorPaths(opList, viewport, OPS);
}

// ── Estrazione vettoriale (PDF con path reali) ─────────────

async function extractVectorPaths(opList, viewport, OPS) {
  const { fnArray, argsArray } = opList;
  const vt = viewport.transform;

  function vpTransform(x, y) {
    return { x: vt[0]*x + vt[2]*y + vt[4], y: vt[1]*x + vt[3]*y + vt[5] };
  }

  const lines = [], curves = [], rects = [];
  let curX = 0, curY = 0, pathStartX = 0, pathStartY = 0, currentLW = 1;
  let ctm = [1,0,0,1,0,0];
  const ctmStack = [];

  function ctmTransform(x, y) {
    return vpTransform(ctm[0]*x + ctm[2]*y + ctm[4], ctm[1]*x + ctm[3]*y + ctm[5]);
  }

  function processSubOps(subOps, subArgs) {
    let ai = 0;
    for (const subOp of subOps) {
      if (subOp === OPS.moveTo) {
        const p = ctmTransform(subArgs[ai], subArgs[ai+1]);
        curX = p.x; curY = p.y; pathStartX = curX; pathStartY = curY; ai += 2;
      } else if (subOp === OPS.lineTo) {
        const p = ctmTransform(subArgs[ai], subArgs[ai+1]);
        lines.push({ x1:curX, y1:curY, x2:p.x, y2:p.y, lw:currentLW });
        curX = p.x; curY = p.y; ai += 2;
      } else if (subOp === OPS.curveTo) {
        const p1 = ctmTransform(subArgs[ai], subArgs[ai+1]);
        const p2 = ctmTransform(subArgs[ai+2], subArgs[ai+3]);
        const p3 = ctmTransform(subArgs[ai+4], subArgs[ai+5]);
        curves.push({ p0:{x:curX,y:curY}, p1, p2, p3, lw:currentLW });
        curX = p3.x; curY = p3.y; ai += 6;
      } else if (subOp === OPS.curveTo2) {
        const p2 = ctmTransform(subArgs[ai], subArgs[ai+1]);
        const p3 = ctmTransform(subArgs[ai+2], subArgs[ai+3]);
        curves.push({ p0:{x:curX,y:curY}, p1:{x:curX,y:curY}, p2, p3, lw:currentLW });
        curX = p3.x; curY = p3.y; ai += 4;
      } else if (subOp === OPS.curveTo3) {
        const p1 = ctmTransform(subArgs[ai], subArgs[ai+1]);
        const p3 = ctmTransform(subArgs[ai+2], subArgs[ai+3]);
        curves.push({ p0:{x:curX,y:curY}, p1, p2:p3, p3, lw:currentLW });
        curX = p3.x; curY = p3.y; ai += 4;
      } else if (subOp === OPS.rectangle) {
        const [rx,ry,rw,rh] = [subArgs[ai],subArgs[ai+1],subArgs[ai+2],subArgs[ai+3]];
        const p0=ctmTransform(rx,ry), p1=ctmTransform(rx+rw,ry);
        const p2=ctmTransform(rx+rw,ry+rh), p3=ctmTransform(rx,ry+rh);
        lines.push({x1:p0.x,y1:p0.y,x2:p1.x,y2:p1.y,lw:currentLW});
        lines.push({x1:p1.x,y1:p1.y,x2:p2.x,y2:p2.y,lw:currentLW});
        lines.push({x1:p2.x,y1:p2.y,x2:p3.x,y2:p3.y,lw:currentLW});
        lines.push({x1:p3.x,y1:p3.y,x2:p0.x,y2:p0.y,lw:currentLW});
        const xs=[p0.x,p1.x,p2.x,p3.x], ys=[p0.y,p1.y,p2.y,p3.y];
        const rx2=Math.min(...xs), ry2=Math.min(...ys);
        rects.push({x:rx2,y:ry2,w:Math.max(...xs)-rx2,h:Math.max(...ys)-ry2,lw:currentLW});
        ai += 4;
      } else if (subOp === OPS.closePath || subOp === OPS.endPath) {
        if (Math.abs(curX-pathStartX)>0.5||Math.abs(curY-pathStartY)>0.5)
          lines.push({x1:curX,y1:curY,x2:pathStartX,y2:pathStartY,lw:currentLW});
        curX = pathStartX; curY = pathStartY;
      }
    }
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i] || [];
    if      (fn === OPS.setLineWidth) { currentLW = args[0]; }
    else if (fn === OPS.save)         { ctmStack.push([...ctm]); }
    else if (fn === OPS.restore)      { if (ctmStack.length) ctm = ctmStack.pop(); }
    else if (fn === OPS.transform) {
      const [a,b,c,d,e,f] = args;
      ctm = [ctm[0]*a+ctm[2]*b, ctm[1]*a+ctm[3]*b,
             ctm[0]*c+ctm[2]*d, ctm[1]*c+ctm[3]*d,
             ctm[0]*e+ctm[2]*f+ctm[4], ctm[1]*e+ctm[3]*f+ctm[5]];
    }
    else if (fn === OPS.constructPath) {
      processSubOps(args[0], args[1]);
    }
    else if (fn === OPS.moveTo) {
      const p = ctmTransform(args[0], args[1]);
      curX=p.x; curY=p.y; pathStartX=curX; pathStartY=curY;
    }
    else if (fn === OPS.lineTo) {
      const p = ctmTransform(args[0], args[1]);
      lines.push({x1:curX,y1:curY,x2:p.x,y2:p.y,lw:currentLW});
      curX=p.x; curY=p.y;
    }
    else if (fn === OPS.curveTo) {
      const p1=ctmTransform(args[0],args[1]), p2=ctmTransform(args[2],args[3]), p3=ctmTransform(args[4],args[5]);
      curves.push({p0:{x:curX,y:curY},p1,p2,p3,lw:currentLW}); curX=p3.x; curY=p3.y;
    }
    else if (fn === OPS.curveTo2) {
      const p2=ctmTransform(args[0],args[1]), p3=ctmTransform(args[2],args[3]);
      curves.push({p0:{x:curX,y:curY},p1:{x:curX,y:curY},p2,p3,lw:currentLW}); curX=p3.x; curY=p3.y;
    }
    else if (fn === OPS.curveTo3) {
      const p1=ctmTransform(args[0],args[1]), p3=ctmTransform(args[2],args[3]);
      curves.push({p0:{x:curX,y:curY},p1,p2:p3,p3,lw:currentLW}); curX=p3.x; curY=p3.y;
    }
    else if (fn === OPS.closePath || fn === OPS.endPath) {
      if (Math.abs(curX-pathStartX)>0.5||Math.abs(curY-pathStartY)>0.5)
        lines.push({x1:curX,y1:curY,x2:pathStartX,y2:pathStartY,lw:currentLW});
      curX=pathStartX; curY=pathStartY;
    }
    else if (fn === OPS.rectangle) {
      const [rx,ry,rw,rh]=args;
      const p0=ctmTransform(rx,ry),p1=ctmTransform(rx+rw,ry),p2=ctmTransform(rx+rw,ry+rh),p3=ctmTransform(rx,ry+rh);
      lines.push({x1:p0.x,y1:p0.y,x2:p1.x,y2:p1.y,lw:currentLW});
      lines.push({x1:p1.x,y1:p1.y,x2:p2.x,y2:p2.y,lw:currentLW});
      lines.push({x1:p2.x,y1:p2.y,x2:p3.x,y2:p3.y,lw:currentLW});
      lines.push({x1:p3.x,y1:p3.y,x2:p0.x,y2:p0.y,lw:currentLW});
      const xs=[p0.x,p1.x,p2.x,p3.x],ys=[p0.y,p1.y,p2.y,p3.y];
      const rx2=Math.min(...xs),ry2=Math.min(...ys);
      rects.push({x:rx2,y:ry2,w:Math.max(...xs)-rx2,h:Math.max(...ys)-ry2,lw:currentLW});
    }
  }
  return { lines, curves, rects };
}

// ── Analisi pixel (PDF con immagini rasterizzate) ──────────

/**
 * Analisi pixel locale sul canvas renderizzato — per PDF con immagini rasterizzate.
 *
 * Invece di cercare coppie di linee parallele (logica vettoriale),
 * cerca direttamente BANDE di pixel scuri continue:
 *   - Bande orizzontali → muri orizzontali
 *   - Bande verticali   → muri verticali
 * Il centro della banda è l'asse del muro, lo spessore è la banda stessa.
 */
async function extractFromPixels(page, viewport) {
  const canvas = importState.pdfCanvas;
  if (!canvas) return { lines: [], curves: [], rects: [], isPixelMode: true };

  const ctx  = canvas.getContext('2d');
  const W    = canvas.width;
  const H    = canvas.height;
  const data = ctx.getImageData(0, 0, W, H).data; // RGBA

  // ── 1. Mappa binaria: 1 = pixel scuro (muro) ──
  const DARK_THRESH = 100; // luminosità < 100/255
  const binary = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
    binary[i] = (0.299*r + 0.587*g + 0.114*b) < DARK_THRESH ? 1 : 0;
  }

  // ── 2. Proiezioni ──
  const hProj = new Float32Array(H); // pixel scuri per riga
  const vProj = new Float32Array(W); // pixel scuri per colonna
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (binary[y*W + x]) { hProj[y]++; vProj[x]++; }

  // ── 3. Parametri adattivi ──
  const MIN_FILL_H = W * 0.03; // 3% larghezza → muri >= ~66cm
  const MIN_FILL_V = H * 0.03;
  const MIN_BAND_W = 4;        // min 4px spessore (esclude linee frame 1-2px)
  const MAX_BAND_W = Math.round(importState.pixelPerCm * 60); // max 60cm spessore

  // ── 4. Trova bande scure nelle proiezioni ──
  const hBands = findBands(hProj, MIN_FILL_H, MIN_BAND_W, MAX_BAND_W);
  const vBands = findBands(vProj, MIN_FILL_V, MIN_BAND_W, MAX_BAND_W);

  // ── 5. Converti bande in linee (asse medio + estensione) ──
  const lines = [];

  for (const band of hBands) {
    const midY  = (band.start + band.end) / 2;
    const thick = band.end - band.start;
    // Estensione orizzontale: trova il range [xStart, xEnd] con pixel scuri in questa banda
    let xStart = W, xEnd = 0;
    for (let y = band.start; y <= band.end; y++)
      for (let x = 0; x < W; x++)
        if (binary[y*W+x]) { if (x < xStart) xStart=x; if (x > xEnd) xEnd=x; }
    if (xEnd - xStart < 10) continue;
    // Spezza la banda in sotto-segmenti (gestisce muri con aperture/porte)
    const segments = findContiguousRanges(binary, W, band.start, band.end, 'H');
    for (const seg of segments) {
      lines.push({ x1:seg.a, y1:midY, x2:seg.b, y2:midY, lw:thick });
    }
  }

  for (const band of vBands) {
    const midX  = (band.start + band.end) / 2;
    const thick = band.end - band.start;
    const segments = findContiguousRanges(binary, W, band.start, band.end, 'V', H);
    for (const seg of segments) {
      lines.push({ x1:midX, y1:seg.a, x2:midX, y2:seg.b, lw:thick });
    }
  }

  // ── 6. Deduplicazione: rimuovi linee troppo vicine (stesso muro rilevato due volte) ──
  const deduplicated = deduplicateLines(lines, importState.pixelPerCm * 5);

  // ── 7. Cerca rettangoli densi (scale) ──
  const rects = findDenseRects(binary, W, H);

  console.log('[PixelAnalysis] hBands:', hBands.length, '| vBands:', vBands.length,
              '| linee:', deduplicated.length, '| scale:', rects.length);

  return { lines: deduplicated, curves: [], rects, isPixelMode: true };
}

/**
 * Trova bande continue in una proiezione.
 * Filtra bande troppo sottili (frame) e troppo spesse (aree riempite).
 */
function findBands(proj, minFill, minWidth, maxWidth) {
  const bands = [];
  let inBand = false, bandStart = 0;
  for (let i = 0; i < proj.length; i++) {
    if (proj[i] >= minFill) {
      if (!inBand) { inBand = true; bandStart = i; }
    } else {
      if (inBand) {
        const w = i - bandStart;
        if (w >= minWidth && w <= maxWidth) bands.push({ start: bandStart, end: i-1 });
        inBand = false;
      }
    }
  }
  if (inBand) {
    const w = proj.length - bandStart;
    if (w >= minWidth && w <= maxWidth) bands.push({ start: bandStart, end: proj.length-1 });
  }
  return bands;
}

/**
 * Nella banda [bandStart..bandEnd], trova i segmenti contigui di pixel scuri
 * lungo l'asse perpendicolare (H=orizzontale, V=verticale).
 * Gap fino a 20px vengono ignorati (porte/finestre).
 */
function findContiguousRanges(binary, W, bandStart, bandEnd, axis, H) {
  const GAP_TOLERANCE = 20; // gap max in px (aperture porte/finestre)
  const MIN_SEG = 15;       // segmento minimo

  const len = axis === 'H' ? W : (H || W);
  const density = new Float32Array(len);

  if (axis === 'H') {
    for (let y = bandStart; y <= bandEnd; y++)
      for (let x = 0; x < W; x++)
        if (binary[y*W+x]) density[x]++;
  } else {
    for (let x = bandStart; x <= bandEnd; x++)
      for (let y = 0; y < (H||W); y++)
        if (binary[y*W+x]) density[y]++;
  }

  const thickness = bandEnd - bandStart + 1;
  const threshold = thickness * 0.3; // 30% della banda deve essere scura

  // Trova segmenti con gap tolerance
  const segments = [];
  let segStart = -1, lastDark = -1;
  for (let i = 0; i < len; i++) {
    if (density[i] >= threshold) {
      if (segStart < 0) segStart = i;
      lastDark = i;
    } else if (segStart >= 0 && i - lastDark > GAP_TOLERANCE) {
      if (lastDark - segStart >= MIN_SEG) segments.push({ a: segStart, b: lastDark });
      segStart = -1;
    }
  }
  if (segStart >= 0 && lastDark - segStart >= MIN_SEG)
    segments.push({ a: segStart, b: lastDark });

  return segments;
}

/**
 * Rimuove linee duplicate (stesso asse, posizione troppo vicina).
 */
function deduplicateLines(lines, minDist) {
  const out = [];
  for (const l of lines) {
    const isH = Math.abs(l.y2 - l.y1) < 2;
    const isDup = out.some(o => {
      const oIsH = Math.abs(o.y2 - o.y1) < 2;
      if (isH !== oIsH) return false;
      if (isH) return Math.abs(l.y1 - o.y1) < minDist;
      else     return Math.abs(l.x1 - o.x1) < minDist;
    });
    if (!isDup) out.push(l);
  }
  return out;
}

/** Cerca zone rettangolari dense di pixel scuri (candidate scale) */
function findDenseRects(binary, W, H) {
  const rects = [];
  const STEP = 20, MIN_S = 40;
  const MAX_S = Math.min(W, H) * 0.35;
  for (let y = 0; y < H - MIN_S; y += STEP) {
    for (let x = 0; x < W - MIN_S; x += STEP) {
      for (let h = MIN_S; h < MAX_S && y+h < H; h += STEP) {
        for (let w = MIN_S; w < MAX_S && x+w < W; w += STEP) {
          let dark = 0, total = 0;
          const ss = Math.max(2, Math.floor(Math.min(w,h)/8));
          for (let sy = y; sy < y+h; sy += ss)
            for (let sx = x; sx < x+w; sx += ss)
              { if (binary[sy*W+sx]) dark++; total++; }
          const fill = dark / Math.max(total,1);
          if (fill > 0.2 && fill < 0.75) {
            rects.push({ x, y, w, h, lw: 1 });
            x += w; break;
          }
        }
      }
    }
  }
  return rects;
}

// ============================================================
// RENDER CANVAS IMPORT
// ============================================================

function renderImportCanvas() {
  const ic  = importState.importCanvas;
  const ctx = importState.importCtx;
  if (!ic || !ctx) return;

  ctx.clearRect(0, 0, ic.width, ic.height);
  ctx.fillStyle = '#0e0e16';
  ctx.fillRect(0, 0, ic.width, ic.height);
  if (!importState.pdfCanvas) return;

  const PAD = 32;
  const sx = (ic.width  - PAD*2) / importState.pdfWidth;
  const sy = (ic.height - PAD*2) / importState.pdfHeight;
  const fitScale = Math.min(sx, sy, 1);
  const drawW = importState.pdfWidth  * fitScale;
  const drawH = importState.pdfHeight * fitScale;
  const offX  = (ic.width  - drawW) / 2;
  const offY  = (ic.height - drawH) / 2;
  importState.pdfOffX   = offX;
  importState.pdfOffY   = offY;
  importState._fitScale = fitScale;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 20;
  ctx.drawImage(importState.pdfCanvas, offX, offY, drawW, drawH);
  ctx.shadowBlur = 0; ctx.restore();

  const p1 = importState.calibPt1;
  const p2 = importState.calibPt2;
  if (p1) drawCalibPoint(ctx, p1.cx, p1.cy, '#f0a500', '1');
  if (p2) drawCalibPoint(ctx, p2.cx, p2.cy, '#4cc9f0', '2');

  if (p1 && p2) {
    ctx.beginPath();
    ctx.moveTo(p1.cx,p1.cy); ctx.lineTo(p2.cx,p2.cy);
    ctx.strokeStyle='rgba(240,165,0,0.8)'; ctx.lineWidth=2;
    ctx.setLineDash([8,4]); ctx.stroke(); ctx.setLineDash([]);
    const mx=(p1.cx+p2.cx)/2, my=(p1.cy+p2.cy)/2;
    const d=Math.round(Math.sqrt((p2.cx-p1.cx)**2+(p2.cy-p1.cy)**2));
    ctx.font='bold 12px DM Mono,monospace'; ctx.fillStyle='#f0a500';
    ctx.textAlign='center'; ctx.fillText(d+' px', mx, my-10);
  }

  if (importState._hoverPos && (importState.importPhase==='pick1'||importState.importPhase==='pick2')) {
    const {hx,hy}=importState._hoverPos;
    ctx.strokeStyle='rgba(240,165,0,0.35)'; ctx.lineWidth=1;
    ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(hx,0); ctx.lineTo(hx,ic.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,hy); ctx.lineTo(ic.width,hy);  ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawCalibPoint(ctx, x, y, color, label) {
  ctx.beginPath(); ctx.arc(x,y,8,0,Math.PI*2);
  ctx.fillStyle=color+'aa'; ctx.strokeStyle=color; ctx.lineWidth=2;
  ctx.fill(); ctx.stroke();
  ctx.font='bold 11px DM Mono,monospace'; ctx.fillStyle=color;
  ctx.textAlign='center'; ctx.fillText(label,x,y-14);
}

// ============================================================
// EVENTI CANVAS IMPORT
// ============================================================

function onImportCanvasClick(e) {
  const rect = importState.importCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const fitScale = importState._fitScale || 1;
  const pdfX = (cx - importState.pdfOffX) / fitScale;
  const pdfY = (cy - importState.pdfOffY) / fitScale;

  if (importState.importPhase === 'pick1') {
    importState.calibPt1 = { cx, cy, pdfX, pdfY };
    setImportPhase('pick2');
    renderImportCanvas();
    showImportToast('Ora clicca il SECONDO punto di riferimento', 'info', 5000);

  } else if (importState.importPhase === 'pick2') {
    importState.calibPt2 = { cx, cy, pdfX, pdfY };
    setImportPhase('calib-input');
    renderImportCanvas();
    const d = Math.round(Math.sqrt(
      (importState.calibPt2.pdfX - importState.calibPt1.pdfX)**2 +
      (importState.calibPt2.pdfY - importState.calibPt1.pdfY)**2
    ));
    document.getElementById('import-calib-pxdist').textContent = d + ' px';
    document.getElementById('import-calib-panel').classList.add('visible');
    document.getElementById('input-calib-len').focus();
  }
}

function onImportCanvasHover(e) {
  if (importState.importPhase!=='pick1' && importState.importPhase!=='pick2') return;
  const rect = importState.importCanvas.getBoundingClientRect();
  importState._hoverPos = { hx: e.clientX-rect.left, hy: e.clientY-rect.top };
  renderImportCanvas();
}

// ============================================================
// CALIBRAZIONE
// ============================================================

function finalizeCalibration() {
  const p1=importState.calibPt1, p2=importState.calibPt2;
  if (!p1||!p2) return;
  const pxDist = Math.sqrt((p2.pdfX-p1.pdfX)**2+(p2.pdfY-p1.pdfY)**2);
  importState.pixelPerCm = pxDist / importState.calibLenCm;
  document.getElementById('import-calib-panel').classList.remove('visible');
  setImportPhase('analyzing');
  setTimeout(() => extractAndBuild(), 60);
}

// ============================================================
// PIPELINE DI ESTRAZIONE GEOMETRICA
// ============================================================

async function extractAndBuild() {
  document.getElementById('import-ai-progress').classList.add('visible');
  // Step 0 (PDF caricato) e 1 (Scala calibrata) già completati
  updateAISteps(2); await sleep(30);

  try {
    const { lines, curves, rects, isPixelMode } = importState.rawOps;
    const pxCm = importState.pixelPerCm;

    updateAISteps(2); await sleep(20);

    let walls, doors = [], windows = [];

    if (isPixelMode) {
      // ── Modalità pixel: le linee estratte SONO già i muri ──
      // Ogni linea rappresenta l'asse di un muro con lw=spessore in px
      updateAISteps(3); await sleep(20);
      walls = lines
        .filter(l => {
          const len = Math.sqrt((l.x2-l.x1)**2+(l.y2-l.y1)**2);
          return len >= pxCm * 30; // almeno 30cm
        })
        .map(l => ({
          x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
          thicknessPx: l.lw,
          thicknessCm: Math.round(Math.max(5, Math.min(50, l.lw / pxCm))),
        }));
      // In pixel mode porte e finestre non vengono rilevate automaticamente
      // (l'utente le aggiunge manualmente durante la fase di review con overlay PDF)
      updateAISteps(4); await sleep(20);

    } else {
      // ── Modalità vettoriale: pipeline completa ──
      const minLenPx = pxCm * 3;
      const validLines = lines.filter(l => !l.isCurve && segLen(l) >= minLenPx);
      const snapped = validLines.map(l => snapLineAngle(l, 6));

      updateAISteps(3); await sleep(20);
      walls = detectWalls(snapped, pxCm);

      updateAISteps(4); await sleep(20);
      doors   = detectDoors(curves, walls, pxCm);
      windows = detectWindows(snapped, walls, pxCm);
    }

    // ── Scale (comune a entrambe le modalità) ──
    updateAISteps(5); await sleep(20);
    const stairs = detectStairs(rects, lines, pxCm);

    // ── Costruzione ──
    updateAISteps(6); await sleep(30);
    document.getElementById('import-ai-progress').classList.remove('visible');
    buildElementsFromVector({ walls, doors, windows, stairs, isPixelMode });

  } catch(err) {
    console.error('Vector extraction error:', err);
    document.getElementById('import-ai-progress').classList.remove('visible');
    showImportToast('Errore estrazione: ' + err.message.slice(0,80), 'error', 6000);
    setImportPhase('pick1'); renderImportCanvas();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function updateAISteps(active) {
  const steps = document.querySelectorAll('#import-ai-progress .ai-step');
  steps.forEach((s,i) => {
    s.classList.remove('active','pulse','dim');
    if      (i < active)  s.classList.add('active');
    else if (i === active) s.classList.add('pulse');
    else                   s.classList.add('dim');
  });
}

// ──────────────────────────────────────────────
// GEOMETRIA HELPERS
// ──────────────────────────────────────────────

function segLen(l) {
  return Math.sqrt((l.x2-l.x1)**2+(l.y2-l.y1)**2);
}
function segAngleDeg(l) {
  return Math.atan2(l.y2-l.y1, l.x2-l.x1)*180/Math.PI;
}
function segMidpoint(l) {
  return { x:(l.x1+l.x2)/2, y:(l.y1+l.y2)/2 };
}
function normAngle(deg) {
  let a=((deg%180)+180)%180;
  if(a>=90) a-=180;
  return a;
}
function ptDist(a,b) {
  return Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2);
}
function ptToSegDist(p, a, b) {
  const dx=b.x-a.x, dy=b.y-a.y, lenSq=dx*dx+dy*dy;
  if(lenSq===0) return ptDist(p,a);
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/lenSq));
  return ptDist(p,{x:a.x+t*dx, y:a.y+t*dy});
}

function snapLineAngle(l, tol) {
  const angle=segAngleDeg(l), na=normAngle(angle);
  const len=segLen(l);
  let snap=na;
  if(Math.abs(na)<=tol) snap=0;
  else if(Math.abs(Math.abs(na)-90)<=tol) snap=na>0?90:-90;
  else return l;
  const rad=snap*Math.PI/180;
  const cx=(l.x1+l.x2)/2, cy=(l.y1+l.y2)/2;
  return {...l,
    x1:cx-Math.cos(rad)*len/2, y1:cy-Math.sin(rad)*len/2,
    x2:cx+Math.cos(rad)*len/2, y2:cy+Math.sin(rad)*len/2,
  };
}

function areParallel(l1, l2, tolDeg=8) {
  const a1=normAngle(segAngleDeg(l1)), a2=normAngle(segAngleDeg(l2));
  const diff=Math.abs(a1-a2);
  return diff<tolDeg || diff>180-tolDeg;
}

function parallelDist(l1, l2) {
  const ang=segAngleDeg(l1)*Math.PI/180;
  const nx=-Math.sin(ang), ny=Math.cos(ang);
  const m1=segMidpoint(l1), m2=segMidpoint(l2);
  return Math.abs((m2.x-m1.x)*nx+(m2.y-m1.y)*ny);
}

function parallelOverlap(l1, l2) {
  const ang=segAngleDeg(l1)*Math.PI/180;
  const ux=Math.cos(ang), uy=Math.sin(ang);
  const proj=pt=>(pt.x-l1.x1)*ux+(pt.y-l1.y1)*uy;
  const aE=segLen(l1);
  const bS=Math.min(proj({x:l2.x1,y:l2.y1}),proj({x:l2.x2,y:l2.y2}));
  const bE=Math.max(proj({x:l2.x1,y:l2.y1}),proj({x:l2.x2,y:l2.y2}));
  return Math.min(aE,bE)-Math.max(0,bS);
}

function averageSegment(l1, l2) {
  const ang=segAngleDeg(l1)*Math.PI/180;
  const ux=Math.cos(ang), uy=Math.sin(ang);
  const m1=segMidpoint(l1), m2=segMidpoint(l2);
  const cx=(m1.x+m2.x)/2, cy=(m1.y+m2.y)/2;
  const len=Math.max(segLen(l1),segLen(l2));
  return { x1:cx-ux*len/2, y1:cy-uy*len/2, x2:cx+ux*len/2, y2:cy+uy*len/2 };
}

// ──────────────────────────────────────────────
// RILEVAMENTO MURI
// ──────────────────────────────────────────────

function detectWalls(lines, pxCm) {
  const maxThick=pxCm*50, minThick=pxCm*3;
  const minLen=pxCm*15, minOverlap=pxCm*10;
  const walls=[], used=new Set();
  const sorted=[...lines].sort((a,b)=>segLen(b)-segLen(a));

  for(let i=0;i<sorted.length;i++) {
    if(used.has(i)) continue;
    const l1=sorted[i];
    if(segLen(l1)<minLen) continue;

    let bestJ=null, bestScore=-1;
    for(let j=i+1;j<sorted.length;j++) {
      if(used.has(j)) continue;
      const l2=sorted[j];
      if(!areParallel(l1,l2,8)) continue;
      const d=parallelDist(l1,l2);
      if(d<minThick||d>maxThick) continue;
      const ov=parallelOverlap(l1,l2);
      if(ov<minOverlap) continue;
      const score=ov/Math.max(d,1);
      if(score>bestScore) { bestScore=score; bestJ=j; }
    }

    if(bestJ!==null) {
      used.add(i); used.add(bestJ);
      const l2=sorted[bestJ];
      const axis=averageSegment(l1,l2);
      const thick=parallelDist(l1,l2);
      walls.push({
        x1:axis.x1, y1:axis.y1, x2:axis.x2, y2:axis.y2,
        thicknessPx:thick, thicknessCm:thick/pxCm,
      });
    }
  }
  return walls;
}

// ──────────────────────────────────────────────
// RILEVAMENTO PORTE (archi bezier)
// ──────────────────────────────────────────────

function detectDoors(curves, walls, pxCm) {
  const doors=[];
  if(!curves||curves.length===0) return doors;

  // Raggruppa curve vicine (stessa porta)
  const groups=[];
  const used=new Set();
  for(let i=0;i<curves.length;i++) {
    if(used.has(i)) continue;
    const g=[curves[i]]; used.add(i);
    for(let j=i+1;j<curves.length;j++) {
      if(used.has(j)) continue;
      const d=Math.min(ptDist(curves[i].p3,curves[j].p0),ptDist(curves[i].p0,curves[j].p3));
      if(d<50) { g.push(curves[j]); used.add(j); }
    }
    groups.push(g);
  }

  for(const g of groups) {
    const pts=g.flatMap(c=>[c.p0,c.p1,c.p2,c.p3]);
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of pts) {
      minX=Math.min(minX,p.x); minY=Math.min(minY,p.y);
      maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y);
    }
    const w=maxX-minX, h=maxY-minY;
    const r=Math.max(w,h), rCm=r/pxCm;
    if(rCm<45||rCm>140) continue;

    const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
    const wall=findNearestWallPdf({x:cx,y:cy}, walls, pxCm*40);
    if(!wall) continue;
    doors.push({ cx, cy, widthCm:rCm, wall });
  }
  return doors;
}

// ──────────────────────────────────────────────
// RILEVAMENTO FINESTRE
// ──────────────────────────────────────────────

function detectWindows(lines, walls, pxCm) {
  const windows=[];
  for(const wall of walls) {
    const wa = normAngle(segAngleDeg(wall));
    // Linee perpendicolari al muro: |normAngle(la - wa + 90)| < tol
    const perpLines=lines.filter(l=>{
      const la  = normAngle(segAngleDeg(l));
      const diff = Math.abs(normAngle(la - wa + 90)); // vicino a 0 → perpendicolare
      if(diff > 12) return false;
      const len=segLen(l), lenCm=len/pxCm;
      if(lenCm<40||lenCm>220) return false;
      const mid=segMidpoint(l);
      const d=ptToSegDist(mid,{x:wall.x1,y:wall.y1},{x:wall.x2,y:wall.y2});
      return d < wall.thicknessPx * 1.8;
    });
    if(perpLines.length<2) continue;

    // Raggruppa per posizione
    const clusters=clusterByPos(perpLines, pxCm*6);
    for(const cl of clusters) {
      if(cl.length<2) continue;
      const avgLen=cl.reduce((s,l)=>s+segLen(l),0)/cl.length;
      const mids=cl.map(segMidpoint);
      const cx=mids.reduce((s,p)=>s+p.x,0)/mids.length;
      const cy=mids.reduce((s,p)=>s+p.y,0)/mids.length;
      windows.push({ cx, cy, widthCm:avgLen/pxCm, wall });
    }
  }
  return windows;
}

function clusterByPos(lines, maxDist) {
  const groups=[], used=new Set();
  for(let i=0;i<lines.length;i++) {
    if(used.has(i)) continue;
    const m1=segMidpoint(lines[i]);
    const g=[lines[i]]; used.add(i);
    for(let j=i+1;j<lines.length;j++) {
      if(used.has(j)) continue;
      if(ptDist(m1,segMidpoint(lines[j]))<maxDist){ g.push(lines[j]); used.add(j); }
    }
    groups.push(g);
  }
  return groups;
}

// ──────────────────────────────────────────────
// RILEVAMENTO SCALE
// ──────────────────────────────────────────────

function detectStairs(rects, lines, pxCm) {
  const stairs=[];
  const minW=pxCm*70, maxW=pxCm*300;
  const minH=pxCm*100, maxH=pxCm*500;

  for(const r of rects) {
    if(r.w<minW||r.w>maxW||r.h<minH||r.h>maxH) continue;
    const inner=lines.filter(l=>{
      const m=segMidpoint(l);
      return m.x>r.x+2&&m.x<r.x+r.w-2&&m.y>r.y+2&&m.y<r.y+r.h-2;
    });
    if(inner.length<3) continue;
    stairs.push({
      cx:r.x+r.w/2, cy:r.y+r.h/2,
      widthCm:r.w/pxCm, heightCm:r.h/pxCm,
      steps:Math.max(3,inner.length), angle:0,
    });
  }
  return stairs;
}

function findNearestWallPdf(pt, walls, maxDist) {
  let best=null, bestD=maxDist;
  for(const w of walls) {
    const d=ptToSegDist(pt,{x:w.x1,y:w.y1},{x:w.x2,y:w.y2});
    if(d<bestD){ bestD=d; best=w; }
  }
  return best;
}

// ============================================================
// COSTRUZIONE ELEMENTI SUL CANVAS PLANSKETCHER
// ============================================================

function pdfPxToCanvas(pdfPx) {
  return (pdfPx / importState.pixelPerCm) * (state.scale / 100);
}

function buildElementsFromVector({ walls: pdfWalls, doors, windows, stairs: pdfStairs, isPixelMode }) {
  // Bounding box PDF
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const w of pdfWalls){
    minX=Math.min(minX,w.x1,w.x2); minY=Math.min(minY,w.y1,w.y2);
    maxX=Math.max(maxX,w.x1,w.x2); maxY=Math.max(maxY,w.y1,w.y2);
  }

  if(!isFinite(minX)) {
    document.getElementById('import-ai-progress').classList.remove('visible');
    showImportToast('Nessun muro rilevato. Prova a ricalibrare o verifica il PDF.', 'warn', 6000);
    setImportPhase('pick1'); renderImportCanvas(); return;
  }

  // Origine canvas = centro visibile
  const cvs=state.canvas;
  const ocx=cvs.width/(2*state.zoom)-state.offsetX;
  const ocy=cvs.height/(2*state.zoom)-state.offsetY;
  const bbW=pdfPxToCanvas(maxX-minX), bbH=pdfPxToCanvas(maxY-minY);
  const dxOff=ocx-bbW/2, dyOff=ocy-bbH/2;

  function toCv(px,py) {
    return { x:pdfPxToCanvas(px-minX)+dxOff, y:pdfPxToCanvas(py-minY)+dyOff };
  }

  // ── Muri ──
  const newWalls=pdfWalls.map(w=>{
    const s=toCv(w.x1,w.y1), e=toCv(w.x2,w.y2);
    return {
      id:`w_v_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      start:s, end:e,
      thickness:Math.max(5,Math.min(60,Math.round(w.thicknessCm))),
      axis:'center', state:'existing',
    };
  }).filter(w=>Math.sqrt((w.end.x-w.start.x)**2+(w.end.y-w.start.y)**2)>3);

  // ── Porte e finestre ──
  const newOpenings=[];
  for(const d of doors) {
    const pt=toCv(d.cx,d.cy);
    const near=findNearestWallCanvas(pt,newWalls);
    if(!near) continue;
    newOpenings.push({
      id:`o_v_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      type:'door', wallId:near.wall.id, t:near.t,
      width:Math.round(d.widthCm), height:210,
      state:'existing', flip:false, rotate:0,
    });
  }
  for(const w of windows) {
    const pt=toCv(w.cx,w.cy);
    const near=findNearestWallCanvas(pt,newWalls);
    if(!near) continue;
    newOpenings.push({
      id:`o_v_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      type:'window', wallId:near.wall.id, t:near.t,
      width:Math.round(w.widthCm), height:120,
      state:'existing', flip:false, rotate:0,
    });
  }

  // ── Scale ──
  const newStairs=pdfStairs.map(s=>{
    const pt=toCv(s.cx,s.cy);
    return {
      id:`s_v_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      x:pt.x, y:pt.y,
      width:Math.round(s.widthCm), height:Math.round(s.heightCm),
      steps:s.steps, dir:'up', angle:0, state:'existing', color:'default',
    };
  });

  state.walls=newWalls; state.openings=newOpenings;
  state.stairs=newStairs; state.columns=[]; state.texts=[];
  pushHistory();

  setImportPhase('review');
  setupPdfOverlay();
  showImportScreen('canvas-screen');
  document.getElementById('import-review-bar').classList.add('visible');

  // Aggiorna messaggio review bar in base alla modalità
  const reviewMsg = document.querySelector('.review-msg');
  if (reviewMsg) {
    if (isPixelMode) {
      reviewMsg.textContent = 'Muri rilevati da immagine. Aggiungi porte/finestre manualmente con overlay PDF.';
    } else {
      reviewMsg.textContent = 'Controlla gli elementi riconosciuti. Tutto ok?';
    }
  }

  resizeCanvas();
  fitViewToProject();
  redraw();

  const tot = newWalls.length + newOpenings.length + newStairs.length;
  if (isPixelMode) {
    showToast(`${newWalls.length} muri rilevati · usa overlay PDF per aggiungere porte e finestre`);
  } else {
    showToast(`${newWalls.length} muri · ${newOpenings.length} serramenti · ${newStairs.length} scale rilevati`);
  }
}

function findNearestWallCanvas(pt, walls) {
  let best=null, bestD=Infinity;
  for(const w of walls){
    const dx=w.end.x-w.start.x, dy=w.end.y-w.start.y;
    const lenSq=dx*dx+dy*dy; if(lenSq===0) continue;
    let t=((pt.x-w.start.x)*dx+(pt.y-w.start.y)*dy)/lenSq;
    t=Math.max(0.05,Math.min(0.95,t));
    const d=ptDist(pt,{x:w.start.x+t*dx, y:w.start.y+t*dy});
    if(d<bestD){ bestD=d; best={wall:w,t}; }
  }
  return bestD<120?best:null;
}

function fitViewToProject() {
  if(!state.walls.length) return;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  state.walls.forEach(w=>{
    minX=Math.min(minX,w.start.x,w.end.x); minY=Math.min(minY,w.start.y,w.end.y);
    maxX=Math.max(maxX,w.start.x,w.end.x); maxY=Math.max(maxY,w.start.y,w.end.y);
  });
  const pad=80, bbW=maxX-minX+pad*2, bbH=maxY-minY+pad*2;
  const z=Math.min(state.canvas.width/bbW, state.canvas.height/bbH, 2);
  state.zoom=z;
  state.offsetX=(state.canvas.width/z-bbW)/2-minX+pad;
  state.offsetY=(state.canvas.height/z-bbH)/2-minY+pad;
}

// ============================================================
// OVERLAY PDF
// ============================================================

function setupPdfOverlay() {
  importState.pdfOverlay={opacity:0.22};
  importState.overlayVisible=true;
  const img=new Image();
  img.onload=()=>{ importState._cachedOverlayImg=img; redraw(); };
  img.src=importState.pdfImageData;
  document.getElementById('btn-overlay-toggle').textContent='Nascondi PDF';
}

function togglePdfOverlay() {
  importState.overlayVisible=!importState.overlayVisible;
  document.getElementById('btn-overlay-toggle').textContent=
    importState.overlayVisible?'Nascondi PDF':'Mostra PDF';
  redraw();
}

function drawPdfOverlayOnCanvas(ctx) {
  if(!importState.pdfOverlay||!importState.overlayVisible) return;
  if(importState.importPhase!=='review') return;
  if(!importState._cachedOverlayImg||!importState._cachedOverlayImg.complete) return;
  if(!state.walls.length) return;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  state.walls.forEach(w=>{
    minX=Math.min(minX,w.start.x,w.end.x); minY=Math.min(minY,w.start.y,w.end.y);
    maxX=Math.max(maxX,w.start.x,w.end.x); maxY=Math.max(maxY,w.start.y,w.end.y);
  });
  if(!isFinite(minX)) return;
  ctx.save();
  ctx.globalAlpha=importState.pdfOverlay.opacity;
  ctx.drawImage(importState._cachedOverlayImg, minX, minY, maxX-minX, maxY-minY);
  ctx.globalAlpha=1; ctx.restore();
}

// ============================================================
// AZIONI REVIEW
// ============================================================

function acceptImport() {
  importState.importPhase='idle';
  importState.pdfOverlay=null; importState._cachedOverlayImg=null;
  document.getElementById('import-review-bar').classList.remove('visible');
  document.getElementById('btn-overlay-toggle').style.display='none';
  document.getElementById('btn-overlay-done').style.display='none';
  saveProject(); redraw();
  showToast('Planimetria importata e salvata');
}

function editWithOverlay() {
  document.getElementById('import-review-bar').classList.remove('visible');
  document.getElementById('btn-overlay-toggle').style.display='inline-flex';
  document.getElementById('btn-overlay-done').style.display='inline-flex';
  redraw();
  showToast('Modifica il disegno. Clicca Fine quando hai finito.');
}

function discardImport() {
  if(!confirm('Eliminare tutti gli elementi importati e tornare alla home?')) return;
  importState.importPhase='idle';
  importState.pdfOverlay=null; importState._cachedOverlayImg=null;
  state.walls=[]; state.openings=[]; state.stairs=[]; state.columns=[]; state.texts=[];
  state.history=[]; state.historyIndex=-1;
  document.getElementById('import-review-bar').classList.remove('visible');
  document.getElementById('btn-overlay-toggle').style.display='none';
  document.getElementById('btn-overlay-done').style.display='none';
  showImportScreen('home-screen'); refreshRecent();
}

function cancelImport() {
  importState.importPhase='idle'; importState.pdfDoc=null;
  importState.pdfCanvas=null; importState.pdfImageData=null;
  importState.rawOps=null; importState.calibPt1=null; importState.calibPt2=null;
  document.getElementById('import-calib-panel').classList.remove('visible');
  document.getElementById('import-ai-progress').classList.remove('visible');
  showImportScreen('home-screen');
}

// ============================================================
// HELPERS UI
// ============================================================

function showImportScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setImportPhase(phase) {
  importState.importPhase=phase;
  const labels={
    loading:'Caricamento PDF...',
    pick1:'Seleziona punto 1 di riferimento',
    pick2:'Seleziona punto 2 di riferimento',
    'calib-input':'Inserisci la lunghezza reale',
    analyzing:'Estrazione geometria in corso...',
    review:'Revisione elementi rilevati',
    idle:'',
  };
  const el=document.getElementById('import-phase-label');
  if(el) el.textContent=labels[phase]||'';
}

let _importToastTimer=null;
function showImportToast(msg, type='info', duration=3000) {
  const el=document.getElementById('import-toast');
  if(!el) return;
  el.textContent=msg; el.className=`import-toast visible ${type}`;
  if(_importToastTimer) clearTimeout(_importToastTimer);
  _importToastTimer=setTimeout(()=>el.classList.remove('visible'), duration);
}

// ============================================================
// HOOK REDRAW (chiamato da app.js)
// ============================================================

function onRedrawHook(ctx) {
  if(importState.importPhase==='review'&&importState.pdfOverlay) {
    drawPdfOverlayOnCanvas(ctx);
  }
}
