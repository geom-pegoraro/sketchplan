/**
 * PlanSketcher – app.js  v3.0
 *
 * Novità rispetto a v2.0:
 * - Pannello proprietà laterale (niente più modal per muro/serramento/pilastro/testo)
 * - Nuove Opere: muri rossi, serramenti rossi, foro nel muro evidenziato in giallo
 * - Demolizioni: click su serramento → diventa giallo, foro si riempie in rosso
 *   (il "fill wall" ha lo stesso spessore del muro adiacente)
 * - Porta: aggiunta linea verticale del montante; supporto flip e rotate (tap su serramento)
 * - PDF comparativa: colori reali (demo=giallo, new=rosso); tavola sinottica con colori
 * - Render PDF "existing": solo elementi stato 'existing' in grigio scuro
 * - Render PDF "project": existing (grigio) + new (rosso), senza demo
 * - Render PDF "comparative": tutto con i propri colori
 */

'use strict';

const DB_NAME       = 'PlanSketcherDB';
const DB_VERSION    = 1;
const STORE_NAME    = 'projects';
const SNAP_THRESHOLD = 20;
const ANGLE_SNAP    = 90;  // Solo snap a 0°/90°/180°/270°
const GRID_SIZE     = 20;

// ============================================================
// STATO GLOBALE
// ============================================================

let state = {
  projectId: null,
  projectName: 'Nuovo Progetto',
  scale: 100,
  canvas: null,
  ctx: null,
  width: 0, height: 0,
  offsetX: 0, offsetY: 0,
  zoom: 1,
  activeTool: 'wall',
  activeState: 'existing',
  walls: [], openings: [], columns: [], texts: [], stairs: [],
  isDrawing: false,
  drawStart: null, drawCurrent: null,
  pendingWall: null,
  lastTouches: [], lastPinchDist: 0, lastPanPos: null,
  history: [], historyIndex: -1,
  // Drag state for moving openings
  isDragging: false,
  draggedOpening: null,
  dragStartPos: null,
  dragOriginalT: null,
  settings: {
    snapAngle: true,
    showGrid: true,
    wallSnap: true,
    defaultThickness: 20,
    darkCanvas: false,
    profName: '',
    profTitle: '',
    profAddress: '',
  },
  // Proprietà correnti (dal pannello laterale)
  propWallThickness: 20,
  propWallAxis: 'center',
  propDoorWidth: 80,
  propDoorHeight: 210,
  propDoorFlip: false,
  propDoorRotate: 0,    // 0 o 1 (flip asse)
  propWindowWidth: 100,
  propWindowHeight: 120,
  propColW: 30,
  propColH: 30,
  propTextLabel: '',
  propTextSize: 14,
  propStairW: 100,
  propStairH: 240,
  propStairSteps: 12,
  propStairDir: 'up',  // 'up' | 'down'
  propStairColor: 'default', // 'default' | 'yellow'
};

// ============================================================
// COLORI
// ============================================================

/**
 * Colori per PDF:
 *  - 'existing'    → existing+demo in nero
 *  - 'project'     → existing+new in nero
 *  - 'comparative' → existing=NERO (priorità max), demo=giallo, new=rosso
 */
function getPDFColors(elementState, tableType) {
  if (tableType === 'comparative') {
    switch (elementState) {
      case 'existing': return { fill: '#1a1a2e', stroke: '#1a1a2e' };
      case 'demo':     return { fill: '#f5c518', stroke: '#f5c518' };
      case 'new':      return { fill: '#e63946', stroke: '#e63946' };
      default:         return { fill: '#1a1a2e', stroke: '#1a1a2e' };
    }
  }
  // 'existing' e 'project': tutto in nero
  return { fill: '#1a1a2e', stroke: '#1a1a2e' };
}

/** Colori canvas (non PDF) — in dark mode gli elementi scuri diventano grigio chiaro */
function getColors(elementState, forPDF) {
  const dark = !forPDF && state.settings.darkCanvas;
  switch (elementState) {
    case 'demo': return { fill: '#f5c518', stroke: '#f5c518' };
    case 'new':  return { fill: '#e63946', stroke: '#e63946' };
    default:     return dark
      ? { fill: '#d4d8e8', stroke: '#d4d8e8' }   // grigio-bianco su sfondo scuro
      : { fill: '#1a1a2e', stroke: '#1a1a2e' };   // nero su sfondo chiaro
  }
}

// ============================================================
// DATABASE
// ============================================================

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_NAME))
        d.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror   = e => reject(e);
  });
}

function saveProject() {
  if (!db || !state.projectId) return;
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put({
    id: state.projectId, name: state.projectName, scale: state.scale,
    walls: state.walls, openings: state.openings,
    columns: state.columns, texts: state.texts, stairs: state.stairs || [], savedAt: Date.now(),
  });
}

async function loadAllProjects() {
  return new Promise(resolve => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = e => resolve(e.target.result || []);
    req.onerror   = () => resolve([]);
  });
}

async function deleteProject(id) {
  return new Promise(resolve => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
  });
}

function loadProjectData(data) {
  state.projectId   = data.id;
  state.projectName = data.name;
  state.scale       = data.scale || 100;
  state.walls       = data.walls    || [];
  state.openings    = data.openings || [];
  state.columns     = data.columns  || [];
  state.texts       = data.texts    || [];
  state.stairs      = data.stairs   || [];
  state.history = []; state.historyIndex = -1;
  document.getElementById('project-name-label').textContent = state.projectName;
  redraw(); pushHistory();
}

setInterval(() => { if (state.projectId) saveProject(); }, 30000);

// ============================================================
// UNDO / REDO
// ============================================================

function snapshot() {
  return JSON.stringify({ walls: state.walls, openings: state.openings, columns: state.columns, texts: state.texts, stairs: state.stairs || [] });
}
function pushHistory() {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshot());
  state.historyIndex = state.history.length - 1;
}
function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  const d = JSON.parse(state.history[state.historyIndex]);
  Object.assign(state, d); redraw(); saveProject();
}
function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  const d = JSON.parse(state.history[state.historyIndex]);
  Object.assign(state, d); redraw(); saveProject();
}

// ============================================================
// MATH
// ============================================================

function dist(a, b) { return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2); }

/**
 * Puntamento Polare:
 * Angoli attrattori ogni ANGLE_SNAP gradi (0, 45, 90, 135, 180…).
 * Se il cursore è entro POLAR_ATTRACT_DEG° da un angolo standard,
 * lo snap scatta; altrimenti il cursore è libero.
 * Restituisce { snapped, angleDeg }
 *   snapped = null  → nessuno snap, disegno libero
 *   snapped = {x,y} → vettore agganciato all'angolo polare
 */
const POLAR_ATTRACT_DEG = 8;

function getPolarSnap(dx, dy) {
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1) return { snapped: null, angleDeg: 0 };
  const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  const nearest  = Math.round(angleDeg / ANGLE_SNAP) * ANGLE_SNAP;
  const diff     = Math.abs(((angleDeg - nearest) + 540) % 360 - 180);
  if (diff <= POLAR_ATTRACT_DEG) {
    const rad = nearest * Math.PI / 180;
    return { snapped: { x: d * Math.cos(rad), y: d * Math.sin(rad) }, angleDeg: nearest };
  }
  return { snapped: null, angleDeg };
}

function canvasToWorld(cx, cy) {
  return { x: cx / state.zoom - state.offsetX, y: cy / state.zoom - state.offsetY };
}

function getEventPos(e) {
  const rect = state.canvas.getBoundingClientRect();
  let cx, cy;
  if (e.touches && e.touches.length > 0) {
    cx = e.touches[0].clientX - rect.left; cy = e.touches[0].clientY - rect.top;
  } else {
    cx = e.clientX - rect.left; cy = e.clientY - rect.top;
  }
  return canvasToWorld(cx, cy);
}

function snapToWalls(pos) {
  if (!state.settings.wallSnap) return pos;
  let best = null, bestD = SNAP_THRESHOLD / state.zoom;

  // Prima: snap agli endpoint
  for (const w of state.walls) {
    for (const p of [w.start, w.end]) {
      const d = dist(pos, p);
      if (d < bestD) { bestD = d; best = { ...p }; }
    }
  }

  // Seconda: snap al corpo del muro (per raccordare muri con asse diverso)
  // Solo se non abbiamo già trovato un endpoint
  if (!best) {
    for (const w of state.walls) {
      const o = getWallOutline(w);
      if (!o) continue;
      // Snap perpendicolare al muro se il punto è dentro lo spessore
      const d = distPointToSegment(pos, w.start, w.end);
      if (d.dist < o.thick * 1.2 && d.t > 0.01 && d.t < 0.99) {
        const bodyDist = d.dist;
        if (bodyDist < bestD) {
          bestD = bodyDist; best = { ...d.point };
        }
      }
    }
  }

  return best || pos;
}

/**
 * snapStairToWall — se la scala viene posizionata vicino a un muro,
 * fa aderire il lato della scala al muro e allinea l'angolo.
 * Restituisce { x, y, angle } con angle in radianti.
 */
function snapStairToWall(pos, stairWcm, stairHcm) {
  if (!state.settings.wallSnap) return { ...pos, angle: 0 };
  const stairH  = (stairHcm / 100) * state.scale / 2;
  const threshold = stairH + (SNAP_THRESHOLD * 3) / state.zoom;

  let bestDist = threshold, bestResult = null;

  for (const w of state.walls) {
    const o = getWallOutline(w);
    if (!o) continue;
    const d = distPointToSegment(pos, w.start, w.end);
    if (d.dist > threshold) continue;

    const wallAngle = Math.atan2(o.dy, o.dx);
    // o.nx, o.ny sono già il vettore normale scalato di thick px
    // Il versore normale è (o.nx, o.ny) / o.thick
    const thick = o.thick; // metà spessore in px
    const nnx = o.nx / thick, nny = o.ny / thick; // versore normale (unitario)

    // Proiezione sul muro
    const projX = d.point.x, projY = d.point.y;

    // Lato del muro su cui si trova il cursore
    const sideSign = ((pos.x - projX) * nnx + (pos.y - projY) * nny) >= 0 ? 1 : -1;

    // Bordo esterno del muro = proiezione ± spessore (nella direzione normale)
    const wallEdgeX = projX + sideSign * nnx * thick;
    const wallEdgeY = projY + sideSign * nny * thick;

    // Centro scala attaccato al bordo del muro
    const snapX = wallEdgeX + sideSign * nnx * stairH;
    const snapY = wallEdgeY + sideSign * nny * stairH;

    const snapDist = dist(pos, { x: snapX, y: snapY });
    if (snapDist < bestDist) {
      bestDist = snapDist;
      bestResult = { x: snapX, y: snapY, angle: wallAngle };
    }
  }

  return bestResult || { ...pos, angle: 0 };
}

function findNearestWall(pos) {
  let best = null, bestD = Infinity;
  for (const w of state.walls) {
    const d = distPointToSegment(pos, w.start, w.end);
    if (d.dist < bestD) { bestD = d.dist; best = { wall: w, t: d.t, point: d.point }; }
  }
  return bestD < (SNAP_THRESHOLD * 3) / state.zoom ? best : null;
}

function distPointToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { dist: dist(p, a), t: 0, point: { ...a } };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { dist: dist(p, { x: a.x + t * dx, y: a.y + t * dy }), t, point: { x: a.x + t * dx, y: a.y + t * dy } };
}

function lineIntersect(p1, d1, p2, d2) {
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 0.001) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / cross;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

// ============================================================
// RACCORDO MURI (MITER JOIN)
// ============================================================

const MITER_TOL = 18;  // tolleranza snap endpoint/body (px)

function getWallOutline(w) {
  const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return null;
  const thick = (w.thickness || 20) / 100 * state.scale / 2;
  const nx = -dy / len * thick, ny = dx / len * thick;
  return {
    tl: { x: w.start.x + nx, y: w.start.y + ny },
    tr: { x: w.end.x   + nx, y: w.end.y   + ny },
    br: { x: w.end.x   - nx, y: w.end.y   - ny },
    bl: { x: w.start.x - nx, y: w.start.y - ny },
    nx, ny, dx, dy, len, thick,
    ux: dx / len, uy: dy / len,
  };
}

/**
 * getMiterAt — raccordo a mitra per un'estremita' di muro.
 *
 * Gestisce:
 *   L-join : due endpoint coincidenti (angolo a L o a qualsiasi angolo)
 *   T-join : endpoint di w cade sul corpo di other
 *   Snap 90deg automatico (entro 8deg)
 *
 * Per il T-join la logica e' corretta:
 *   Il taglio avviene esattamente sulla faccia del muro attraversato,
 *   calcolato come intersezione delle rette delle due facce.
 */
function getMiterAt(w, side, wallList) {
  const anchor = w[side];
  const o = getWallOutline(w);
  if (!o) return null;

  const wDirX = side === 'end' ?  o.ux : -o.ux;
  const wDirY = side === 'end' ?  o.uy : -o.uy;

  const candidates = wallList || state.walls;
  let best = null, bestScore = Infinity;

  for (const other of candidates) {
    if (other.id === w.id) continue;
    const oo = getWallOutline(other);
    if (!oo) continue;

    let oDirX, oDirY;
    let isBody = false;

    const dS = dist(other.start, anchor);
    const dE = dist(other.end,   anchor);

    if (dS < MITER_TOL) {
      oDirX =  oo.ux; oDirY =  oo.uy;
    } else if (dE < MITER_TOL) {
      oDirX = -oo.ux; oDirY = -oo.uy;
    } else {
      const d = distPointToSegment(anchor, other.start, other.end);
      if (d.dist > MITER_TOL) continue;
      isBody = true;
      // Se quasi paralleli non raccordare (T-join richiede angolo significativo)
      const dot1 = Math.abs(wDirX * oo.ux + wDirY * oo.uy);
      if (dot1 > 0.92) continue;
      oDirX = oo.ux; oDirY = oo.uy;
    }

    // Angolo tra i due muri
    const dot = Math.max(-1, Math.min(1, wDirX * oDirX + wDirY * oDirY));
    let angleDiff = Math.abs(Math.acos(dot));

    // Snap a 90deg: se entro 8deg, forza perpendicolare esatta
    const SNAP_90 = 8 * Math.PI / 180;
    if (Math.abs(angleDiff - Math.PI / 2) < SNAP_90) {
      angleDiff = Math.PI / 2;
      const perpX = -wDirY, perpY = wDirX;
      const dp = oDirX * perpX + oDirY * perpY;
      if (dp < 0) { oDirX = -perpX; oDirY = -perpY; }
      else        { oDirX =  perpX; oDirY =  perpY; }
    }

    // Escludi paralleli/antiparalleli
    if (angleDiff < 0.07 || angleDiff > Math.PI - 0.07) continue;

    let topP, botP, topD, botD;

    if (isBody) {
      // T-join: tagliamo w a filo della faccia di other
      // Le due facce di other sono parallele all'asse di other
      topP = { x: anchor.x + oo.nx, y: anchor.y + oo.ny };
      botP = { x: anchor.x - oo.nx, y: anchor.y - oo.ny };
      topD = { x: oo.ux, y: oo.uy };
      botD = { x: oo.ux, y: oo.uy };
    } else {
      // L-join / corner: le facce di other partono dall'anchor
      topP = { x: anchor.x + oo.nx, y: anchor.y + oo.ny };
      botP = { x: anchor.x - oo.nx, y: anchor.y - oo.ny };
      topD = { x: oDirX, y: oDirY };
      botD = { x: oDirX, y: oDirY };
    }

    const topI = lineIntersect(
      { x: anchor.x + o.nx, y: anchor.y + o.ny }, { x: wDirX, y: wDirY },
      topP, topD
    );
    const botI = lineIntersect(
      { x: anchor.x - o.nx, y: anchor.y - o.ny }, { x: wDirX, y: wDirY },
      botP, botD
    );

    if (topI && botI) {
      const maxD = (o.thick + oo.thick) * 8;
      const dTop = dist(topI, anchor);
      const dBot = dist(botI, anchor);
      if (dTop < maxD && dBot < maxD) {
        const score = Math.abs(angleDiff - Math.PI / 2) + (dTop + dBot) * 0.001;
        if (score < bestScore) {
          bestScore = score;
          best = { top: topI, bot: botI, other, oo, isBody };
        }
      }
    }
  }

  return best;
}

// ============================================================
// DISEGNO
// ============================================================

function redraw() {
  const { ctx, width, height } = state;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.scale(state.zoom, state.zoom);
  ctx.translate(state.offsetX, state.offsetY);

  if (state.settings.showGrid) drawGrid();

  state.columns.forEach(c => drawColumn(c));
  drawAllWalls(state.ctx, false);
  state.openings.forEach(o => drawOpening(o));
  (state.stairs || []).forEach(s => drawStair(s));
  state.texts.forEach(t => drawText(t));

  if (state.isDrawing && state.drawStart && state.drawCurrent) drawPreview();
  // Demo hover: solo se il mouse/touch è ATTIVAMENTE sopra il canvas (non al cambio stato)
  if (state.activeState === 'demo' && state.drawCurrent && state._mouseOverCanvas) drawDemoHover();
  // Eraser hover: evidenzia elemento sotto il cursore
  if (state.activeTool === 'eraser' && state.drawCurrent && state._mouseOverCanvas) drawEraserHover();
  // PDF import overlay (durante fase review)
  if (typeof onRedrawHook === 'function') onRedrawHook(ctx);

  ctx.restore();
  updateStatusBar();
}

/**
 * Disegna tutti i muri con raccordo corretto agli angoli.
 * Strategia robusta:
 *   1. Fill solido di ogni muro
 *   2. Fill convexHull dei nodi di giunzione (stessa tinta → copre il gap d'angolo)
 *   3. Hatch diagonale su muri
 *   4. Re-fill nodi sopra hatch
 *   5. Bordi con miter geometrico
 *   6. Fill finale clip-nodi (copre bordi interni visibili)
 *   7. Etichette misure
 */
function drawAllWalls(ctx, forPDF, wallList) {
  ctx = ctx || state.ctx;
  const walls = wallList || state.walls;
  if (walls.length === 0) return;

  const isPDF = !!forPDF;
  const getC = (st) => isPDF ? getPDFColors(st, forPDF) : getColors(st, false);

  const ORDER = ['new', 'demo', 'existing'];
  const groups = new Map();
  for (const w of walls) {
    const st = w.state || 'existing';
    if (!groups.has(st)) groups.set(st, []);
    groups.get(st).push(w);
  }
  const orderedStates = [...ORDER.filter(s => groups.has(s)), ...[...groups.keys()].filter(s => !ORDER.includes(s))];

  for (const st of orderedStates) {
    const wList = groups.get(st);
    const colors = getC(st);
    const nodeMap = buildNodeMap(wList);

    // Helper: calcola convexHull per un nodo includendo i corner miter
    const getNodeHull = (entries) => {
      const firstEntry = entries[0];
      const anchor = (firstEntry.side === 'body' && firstEntry.bodyPoint)
        ? firstEntry.bodyPoint
        : firstEntry.wall[firstEntry.side === 'body' ? 'start' : firstEntry.side];
      const pts = [];
      for (const { wall, side, bodyPoint } of entries) {
        const o = getWallOutline(wall);
        if (!o) continue;
        const refPt = (side === 'body' && bodyPoint) ? bodyPoint : anchor;
        pts.push({ x: refPt.x + o.nx, y: refPt.y + o.ny });
        pts.push({ x: refPt.x - o.nx, y: refPt.y - o.ny });
        if (side !== 'body') {
          const m = getMiterAt(wall, side, wList);
          if (m) { pts.push(m.top); pts.push(m.bot); }
        }
      }
      if (pts.length < 3) return null;
      const center = { x: pts.reduce((s,p) => s+p.x, 0)/pts.length, y: pts.reduce((s,p) => s+p.y, 0)/pts.length };
      return convexHull(pts, center);
    };

    // ── 1. Fill solido muri ──
    ctx.fillStyle = colors.fill;
    for (const w of wList) {
      const o = getWallOutline(w);
      if (!o) continue;
      ctx.beginPath();
      ctx.moveTo(o.tl.x, o.tl.y); ctx.lineTo(o.tr.x, o.tr.y);
      ctx.lineTo(o.br.x, o.br.y); ctx.lineTo(o.bl.x, o.bl.y);
      ctx.closePath(); ctx.fill();
    }

    // ── 2. Fill nodi giunzione ──
    ctx.fillStyle = colors.fill;
    for (const entries of nodeMap.values()) {
      if (entries.length < 2) continue;
      const hull = getNodeHull(entries);
      if (!hull) continue;
      ctx.beginPath();
      ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
      ctx.closePath(); ctx.fill();
    }

    // ── 3. Hatch diagonale su muri ──
    const hatchColor = colors.stroke + '28';
    for (const w of wList) {
      const o = getWallOutline(w);
      if (!o) continue;
      drawWallHatch(ctx, o.tl, o.tr, o.br, o.bl, hatchColor);
    }

    // ── 4. Re-fill nodi sopra hatch ──
    ctx.fillStyle = colors.fill;
    for (const entries of nodeMap.values()) {
      if (entries.length < 2) continue;
      const hull = getNodeHull(entries);
      if (!hull) continue;
      ctx.beginPath();
      ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
      ctx.closePath(); ctx.fill();
    }

    // ── 5. Bordi con miter ──
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 1.5 / state.zoom;
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 20;
    for (const w of wList) {
      const o = getWallOutline(w);
      if (!o) continue;
      const ms = getMiterAt(w, 'start', wList);
      const me = getMiterAt(w, 'end',   wList);
      const tl = ms ? ms.top : o.tl;
      const bl = ms ? ms.bot : o.bl;
      const tr = me ? me.top : o.tr;
      const br = me ? me.bot : o.br;
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
      ctx.closePath(); ctx.stroke();
    }

    // ── 6. Fill finale clip-nodi (copre bordi interni visibili) ──
    ctx.fillStyle = colors.fill;
    for (const entries of nodeMap.values()) {
      if (entries.length < 2) continue;
      const hull = getNodeHull(entries);
      if (!hull) continue;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
      ctx.closePath(); ctx.clip();
      for (const { wall } of entries) {
        const o = getWallOutline(wall);
        if (!o) continue;
        ctx.beginPath();
        ctx.moveTo(o.tl.x, o.tl.y); ctx.lineTo(o.tr.x, o.tr.y);
        ctx.lineTo(o.br.x, o.br.y); ctx.lineTo(o.bl.x, o.bl.y);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    // ── 7. Etichette misure ──
    for (const w of wList) {
      const o = getWallOutline(w);
      if (o) drawWallLabel(w, o.len, ctx);
    }
  }
}




function buildNodeMap(walls) {
  // Griglia a 12px per unificare nodi geometricamente vicini
  const GRID = 12;
  const nodeMap = new Map();

  for (const w of walls) {
    for (const side of ['start', 'end']) {
      const p = w[side];
      const key = `${Math.round(p.x / GRID) * GRID}_${Math.round(p.y / GRID) * GRID}`;
      if (!nodeMap.has(key)) nodeMap.set(key, []);
      nodeMap.get(key).push({ wall: w, side });
    }
  }

  // Aggiungi T-join: endpoint di w che cade sul CORPO di other
  for (const w of walls) {
    for (const side of ['start', 'end']) {
      const anchor = w[side];
      for (const other of walls) {
        if (other.id === w.id) continue;
        // Salta se endpoint di other è già vicino ad anchor (L-join, già tracciato sopra)
        if (dist(other.start, anchor) < MITER_TOL || dist(other.end, anchor) < MITER_TOL) continue;
        const d = distPointToSegment(anchor, other.start, other.end);
        if (d.dist > MITER_TOL) continue;

        // Controlla che non siano paralleli (T-join ha senso solo se c'e' un angolo)
        const o  = getWallOutline(w);
        const oo = getWallOutline(other);
        if (!o || !oo) continue;
        const parallelDot = Math.abs(o.ux * oo.ux + o.uy * oo.uy);
        if (parallelDot > 0.92) continue;  // paralleli → niente T-join

        const key = `${Math.round(anchor.x / GRID) * GRID}_${Math.round(anchor.y / GRID) * GRID}`;
        const entries = nodeMap.get(key);
        if (entries && !entries.find(e => e.wall.id === other.id)) {
          entries.push({ wall: other, side: 'body', bodyPoint: d.point });
        }
      }
    }
  }

  return nodeMap;
}

function convexHull(pts, center) {
  const cx = center.x, cy = center.y;
  return [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

// Mantieni drawWallJunctions per compatibilità (usata nel PDF renderer)
function drawWallJunctions(ctx, forPDF) { /* no-op: ora gestito da drawAllWalls */ }

function drawGrid() {
  const { ctx, zoom, offsetX, offsetY, width, height } = state;
  const isDark = state.settings.darkCanvas;
  const gs = GRID_SIZE;
  const x0 = -offsetX - gs * 5, y0 = -offsetY - gs * 5;
  const x1 = x0 + width / zoom + gs * 10, y1 = y0 + height / zoom + gs * 10;

  const fineColor  = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)';
  const coarseColor = isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.12)';

  ctx.strokeStyle = fineColor; ctx.lineWidth = 0.5;
  for (let x = Math.floor(x0 / gs) * gs; x < x1; x += gs) {
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
  }
  for (let y = Math.floor(y0 / gs) * gs; y < y1; y += gs) {
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  }
  ctx.strokeStyle = coarseColor; ctx.lineWidth = 1;
  for (let x = Math.floor(x0 / (gs*5)) * (gs*5); x < x1; x += gs*5) {
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
  }
  for (let y = Math.floor(y0 / (gs*5)) * (gs*5); y < y1; y += gs*5) {
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  }
}

/** Stub per compatibilità — usa drawAllWalls */
function drawWall(w, ctx, forPDF) {
  drawAllWalls(ctx || state.ctx, forPDF || false, [w]);
}

/** Disegna un hatch diagonale dentro un quadrilatero */
function drawWallHatch(ctx, tl, tr, br, bl, color) {
  ctx.save();
  // Crea clipping region
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.clip();

  // Bounding box
  const minX = Math.min(tl.x, tr.x, br.x, bl.x);
  const maxX = Math.max(tl.x, tr.x, br.x, bl.x);
  const minY = Math.min(tl.y, tr.y, br.y, bl.y);
  const maxY = Math.max(tl.y, tr.y, br.y, bl.y);
  const diagLen = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
  const step = Math.max(4, 5 / state.zoom);

  ctx.strokeStyle = color;
  ctx.lineWidth = 0.5 / state.zoom;
  ctx.beginPath();
  for (let d = -diagLen; d < diagLen * 2; d += step) {
    ctx.moveTo(minX + d, minY);
    ctx.lineTo(minX + d + (maxY - minY), maxY);
  }
  ctx.stroke();
  ctx.restore();
}

function drawWallLabel(w, len, ctx) {
  ctx = ctx || state.ctx;
  const mid    = { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
  const meters = (len / state.scale).toFixed(2);
  const angle  = Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x);
  const thick  = (w.thickness || 20) / 100 * state.scale;
  const offset = thick / 2 + 8 / state.zoom;
  ctx.save();
  ctx.translate(mid.x, mid.y);
  let a = angle;
  if (a > Math.PI / 2 || a < -Math.PI / 2) a += Math.PI;
  ctx.rotate(a);
  ctx.font      = `${Math.max(8, 10 / state.zoom)}px 'DM Mono', monospace`;
  ctx.fillStyle = state.settings.darkCanvas ? 'rgba(200,210,240,0.85)' : 'rgba(60,60,100,0.7)';
  ctx.textAlign = 'center';
  ctx.fillText(`${meters}m`, 0, -offset);
  ctx.restore();
}

// ============================================================
// APERTURA: FORO nel muro
// Colore foro: 
//   - stato 'existing' o 'new' → bianco/sfondo canvas
//   - Il pezzo di muro interessato dal foro viene riempito 
//     con il colore corretto nella logica di creazione
// ============================================================

function drawOpening(o, ctx, forPDF) {
  ctx = ctx || state.ctx;
  const wall = state.walls.find(w => w.id === o.wallId);
  if (!wall) return;

  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  const ux = dx / len, uy = dy / len;
  const thick = (wall.thickness || 20) / 100 * state.scale / 2;
  const nx = -uy * thick, ny = ux * thick;
  const oWidth = (o.width / 100) * state.scale;
  const cx_ = wall.start.x + o.t * dx;
  const cy_ = wall.start.y + o.t * dy;
  const hW  = oWidth / 2;

  // Foro: colore adattivo — bianco su PDF, colore sfondo canvas in edit
  const holeColor = forPDF ? '#ffffff' : (state.settings.darkCanvas ? '#12131a' : '#f0f0e8');

  ctx.beginPath();
  ctx.moveTo(cx_ - ux*hW + nx*1.05, cy_ - uy*hW + ny*1.05);
  ctx.lineTo(cx_ + ux*hW + nx*1.05, cy_ + uy*hW + ny*1.05);
  ctx.lineTo(cx_ + ux*hW - nx*1.05, cy_ + uy*hW - ny*1.05);
  ctx.lineTo(cx_ - ux*hW - nx*1.05, cy_ - uy*hW - ny*1.05);
  ctx.closePath();
  ctx.fillStyle = holeColor;
  ctx.fill();

  // Usa getPDFColors se siamo in un render PDF, getColors altrimenti
  const colors = forPDF
    ? getPDFColors(o.state || 'existing', forPDF)
    : getColors(o.state || 'existing', false);

  if (o.type === 'door') {
    drawDoor(ctx, cx_, cy_, ux, uy, nx, ny, hW, thick, oWidth, colors, o.flip || false, o.rotate || 0, forPDF);
  } else {
    drawWindow(ctx, cx_, cy_, ux, uy, nx, ny, hW, thick, colors, forPDF);
  }
}

// ============================================================
// PORTA – stipiti + montante + anta + arco 90°
// flip: specchia l'anta (cambio lato cardine/battuta)
// rotate: 0 = anta lato +nx, 1 = anta lato -nx
// ============================================================

// ============================================================
// PORTA – modello grafico architettonico completo
// Simbolo standard: due stipiti pieni + soglia + anta aperta + arco 90°
// flip: specchia rispetto all'asse lungo del muro (lato cardine)
// rotate: specchia rispetto all'asse trasversale (interno/esterno)
// ============================================================

/**
 * drawDoor — simbolo architettonico corretto da zero
 *
 * Il simbolo planimetrico standard di una porta comprende:
 *   1. Foro nel muro (già fatto da drawOpening)
 *   2. Due stipiti (blocchi pieni ai lati del foro)
 *   3. Linea dell'anta nella posizione APERTA (perpendicolare al muro, parte dal cardine)
 *   4. Arco 90° tratteggiato che descrive la traiettoria dell'anta
 *
 * flip=false: cardine a sinistra del muro (inizio), anta verso destra
 * flip=true:  cardine a destra del muro (fine), anta verso sinistra
 * rotate=0:   apertura verso il lato +nx (normale positiva)
 * rotate=1:   apertura verso il lato -nx (normale negativa)
 */
function drawDoor(ctx, cx, cy, ux, uy, nx, ny, hW, thick, doorWidth, colors, flip, rotate, forPDF) {
  // NOTA: nx/ny sono già il vettore normale scalato al SEMI-spessore (thick = halfThick in pixel)
  // ux/uy = versore asse muro, nx/ny = normale scalata al semi-spessore
  const lw = 1.5 / state.zoom;
  const stipW = Math.min(thick * 0.3, doorWidth * 0.08);

  // Estremo cardine e estremo battuta lungo l'asse del muro
  const P_hingeX = flip ? cx + ux * hW : cx - ux * hW;
  const P_hingeY = flip ? cy + uy * hW : cy - uy * hW;
  const P_latchX = flip ? cx - ux * hW : cx + ux * hW;
  const P_latchY = flip ? cy - uy * hW : cy + uy * hW;

  // Versore dal cardine verso la battuta (= direzione ux/uy o inversa)
  const wdx = flip ? -ux : ux;
  const wdy = flip ? -uy : uy;

  // Versore normale verso il lato di apertura (normalizzato: nx/ny già hanno la scala del semi-spessore)
  const snLen = Math.sqrt(nx * nx + ny * ny) || 1;
  const basendx = nx / snLen;  // versore unitario della normale
  const basendy = ny / snLen;
  const sndx = rotate ? -basendx : basendx;
  const sndy = rotate ? -basendy : basendy;

  // ── Stipite cardine ──
  ctx.beginPath();
  ctx.moveTo(P_hingeX + nx, P_hingeY + ny);
  ctx.lineTo(P_hingeX - nx, P_hingeY - ny);
  ctx.lineTo(P_hingeX - nx + wdx * stipW, P_hingeY - ny + wdy * stipW);
  ctx.lineTo(P_hingeX + nx + wdx * stipW, P_hingeY + ny + wdy * stipW);
  ctx.closePath();
  ctx.fillStyle = colors.fill; ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = lw * 0.5; ctx.fill(); ctx.stroke();

  // ── Stipite battuta ──
  ctx.beginPath();
  ctx.moveTo(P_latchX + nx, P_latchY + ny);
  ctx.lineTo(P_latchX - nx, P_latchY - ny);
  ctx.lineTo(P_latchX - nx - wdx * stipW, P_latchY - ny - wdy * stipW);
  ctx.lineTo(P_latchX + nx - wdx * stipW, P_latchY + ny - wdy * stipW);
  ctx.closePath();
  ctx.fillStyle = colors.fill; ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = lw * 0.5; ctx.fill(); ctx.stroke();

  // ── Punto cardine: spigolo del foro sul lato apertura, in corrispondenza dello stipite cardine ──
  // Sposto il punto cardine lungo la normale di apertura di thick (il semi-spessore),
  // così il cardine cade sul bordo interno del muro lato apertura.
  const hingeX = P_hingeX + sndx * thick;
  const hingeY = P_hingeY + sndy * thick;

  // ── Anta APERTA: linea dal cardine in direzione perpendicolare al muro (= sndx/sndy) ──
  // L'anta aperta è perpendicolare al muro e ha lunghezza = doorWidth
  const antaEndX = hingeX + sndx * doorWidth;
  const antaEndY = hingeY + sndy * doorWidth;

  ctx.beginPath();
  ctx.moveTo(hingeX, hingeY);
  ctx.lineTo(antaEndX, antaEndY);
  ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = lw * 1.8;
  ctx.setLineDash([]);
  ctx.stroke();

  // ── Arco 90° tratteggiato: ruota dall'anta chiusa (lungo il muro) all'anta aperta (perpendicolare) ──
  // Angolo di partenza arco = direzione dell'anta CHIUSA = lungo il muro verso la battuta (wdx, wdy)
  const startA = Math.atan2(wdy, wdx);
  // Cross product (wdx,wdy) × (sndx,sndy): positivo = gira in senso antiorario (CCW), negativo = orario (CW)
  const cross = wdx * sndy - wdy * sndx;
  // Angolo finale = startA + 90° nel verso giusto
  const endA = startA + (cross >= 0 ? Math.PI / 2 : -Math.PI / 2);
  const ccw = cross < 0;

  ctx.beginPath();
  ctx.arc(hingeX, hingeY, doorWidth, startA, endA, ccw);
  ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = lw * 0.7;
  ctx.setLineDash([3.5 / state.zoom, 2.5 / state.zoom]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Cerchietto cardine ──
  ctx.beginPath();
  ctx.arc(hingeX, hingeY, Math.max(2, 3 / state.zoom), 0, Math.PI * 2);
  ctx.fillStyle = colors.stroke;
  ctx.fill();
}

function drawWindow(ctx, cx, cy, ux, uy, nx, ny, hW, thick, colors, forPDF) {
  const lw = 1.5 / state.zoom;
  const P0x = cx - ux * hW, P0y = cy - uy * hW;
  const P1x = cx + ux * hW, P1y = cy + uy * hW;

  // Stipiti
  ctx.strokeStyle = colors.stroke; ctx.lineWidth = lw * 2;
  ctx.beginPath(); ctx.moveTo(P0x + nx, P0y + ny); ctx.lineTo(P0x - nx, P0y - ny); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(P1x + nx, P1y + ny); ctx.lineTo(P1x - nx, P1y - ny); ctx.stroke();

  // Tre linee vetro
  ctx.lineWidth = lw;
  [-0.6, 0, 0.6].forEach(f => {
    ctx.beginPath();
    ctx.moveTo(P0x + nx * f, P0y + ny * f);
    ctx.lineTo(P1x + nx * f, P1y + ny * f);
    ctx.stroke();
  });
}

function drawColumn(c, ctx, forPDF) {
  ctx = ctx || state.ctx;
  const colors = getColors(c.state || 'existing', forPDF);
  const cw = (c.width  / 100) * state.scale;
  const ch = (c.height / 100) * state.scale;
  ctx.fillStyle   = colors.fill;
  ctx.strokeStyle = colors.stroke;
  ctx.lineWidth   = 1 / state.zoom;
  ctx.fillRect  (c.x - cw/2, c.y - ch/2, cw, ch);
  ctx.strokeRect(c.x - cw/2, c.y - ch/2, cw, ch);
  ctx.beginPath();
  ctx.moveTo(c.x - cw/2, c.y - ch/2); ctx.lineTo(c.x + cw/2, c.y + ch/2);
  ctx.moveTo(c.x + cw/2, c.y - ch/2); ctx.lineTo(c.x - cw/2, c.y + ch/2);
  ctx.lineWidth = 0.8 / state.zoom; ctx.stroke();
}

function drawText(t, ctx) {
  ctx = ctx || state.ctx;
  ctx.save();
  ctx.font      = `${t.size || 14}px 'Syne', sans-serif`;
  // In dark mode, i testi grigi/neri (stato existing) diventano chiari
  let color = t.color || '#333';
  if (state.settings.darkCanvas && (color === '#333' || color === '#1a1a2e')) {
    color = '#d4d8e8';
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(t.label, t.x, t.y);
  ctx.restore();
}

// ============================================================
// SCALA (STAIRS) — simbolo architettonico vista in pianta
// ============================================================

/**
 * Disegna una scala in pianta.
 *   x, y   = punto d'inserimento (angolo in basso a sinistra)
 *   w      = larghezza (cm → px)
 *   h      = altezza/lunghezza (cm → px)
 *   steps  = numero di gradini
 *   dir    = 'up' | 'down' (freccia salita)
 *   angle  = rotazione in radianti
 */
function drawStair(s, ctx, forPDF) {
  ctx = ctx || state.ctx;
  let colors = forPDF ? getPDFColors(s.state || 'existing', forPDF) : getColors(s.state || 'existing', false);
  // Colore giallo personalizzato
  if (s.color === 'yellow') colors = { fill: '#f5c518', stroke: '#b8860b' };
  const W = (s.width  / 100) * state.scale;
  const H = (s.height / 100) * state.scale;
  const steps = s.steps || 10;

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle || 0);

  // Bordo esterno
  ctx.strokeStyle = colors.stroke;
  ctx.fillStyle   = 'rgba(255,255,255,0)';
  ctx.lineWidth   = 1.5 / state.zoom;
  ctx.strokeRect(-W/2, -H/2, W, H);

  // Linee gradini
  const stepH = H / steps;
  ctx.lineWidth = 0.8 / state.zoom;
  for (let i = 1; i < steps; i++) {
    const y = -H/2 + i * stepH;
    ctx.beginPath();
    ctx.moveTo(-W/2, y);
    ctx.lineTo( W/2, y);
    ctx.stroke();
  }

  // Freccia direzionale al centro (indica senso salita)
  const arrowDir = (s.dir === 'down') ? 1 : -1;
  const arrowY = arrowDir > 0 ? H/2 - stepH * 1.5 : -H/2 + stepH * 1.5;
  const arrowLen = stepH * 1.2;
  ctx.lineWidth = 1.2 / state.zoom;
  ctx.strokeStyle = colors.stroke;
  ctx.beginPath();
  ctx.moveTo(0, -H/2 + H * 0.5 + arrowLen * arrowDir * 0.5);
  ctx.lineTo(0, -H/2 + H * 0.5 - arrowLen * arrowDir * 0.5);
  ctx.stroke();
  // Punta freccia
  const tipY = -H/2 + H * 0.5 - arrowLen * arrowDir * 0.5;
  const hw = arrowLen * 0.25;
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(-hw, tipY + arrowLen * arrowDir * 0.3);
  ctx.lineTo( hw, tipY + arrowLen * arrowDir * 0.3);
  ctx.closePath();
  ctx.fillStyle = colors.stroke;
  ctx.fill();

  // Linea di taglio (linea diagonale standard architettonico, indica livello sezione)
  ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = 1.5 / state.zoom;
  ctx.setLineDash([3 / state.zoom, 2 / state.zoom]);
  ctx.beginPath();
  ctx.moveTo(-W/2, -H/2 + H * 0.5);
  ctx.lineTo( W/2, -H/2 + H * 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  // Etichetta gradini
  ctx.font = `${Math.max(7, 8 / state.zoom)}px 'DM Mono', monospace`;
  ctx.fillStyle = (!forPDF && state.settings.darkCanvas) ? 'rgba(200,210,240,0.85)' : 'rgba(60,60,100,0.7)';
  ctx.textAlign = 'center';
  ctx.fillText(`${steps} grad.`, 0, H/2 + 10 / state.zoom);

  ctx.restore();
}

// ============================================================
// PREVIEW durante il disegno
// ============================================================

function drawPreview() {
  if (state.activeTool === 'cut') { drawCutPreview(); return; }
  if (state.activeTool !== 'wall') return;
  const { ctx } = state;
  const rawDx = state.drawCurrent.x - state.drawStart.x;
  const rawDy = state.drawCurrent.y - state.drawStart.y;

  let end = { ...state.drawCurrent };
  let polarActive = false;
  let polarAngleDeg = 0;

  if (state.settings.snapAngle) {
    const { snapped, angleDeg } = getPolarSnap(rawDx, rawDy);
    if (snapped) {
      end = { x: state.drawStart.x + snapped.x, y: state.drawStart.y + snapped.y };
      polarActive = true;
      polarAngleDeg = ((angleDeg % 360) + 360) % 360;
    }
  }

  const thickPx = (state.propWallThickness / 100) * state.scale;
  const half = thickPx / 2;
  const len  = dist(state.drawStart, end);
  if (len < 1) return;

  const dx = end.x - state.drawStart.x, dy = end.y - state.drawStart.y;
  const nx = -dy / len, ny = dx / len;

  // Offset asse
  const axis = state.propWallAxis || 'center';
  let axisOffset = 0;
  if (axis === 'left')  axisOffset =  half;
  if (axis === 'right') axisOffset = -half;

  const sx = state.drawStart.x + nx * axisOffset;
  const sy = state.drawStart.y + ny * axisOffset;
  const ex = end.x + nx * axisOffset;
  const ey = end.y + ny * axisOffset;

  // ── Linea guida polare (se snap attivo) ──
  if (polarActive) {
    const guideLen = Math.max(state.width, state.height) / state.zoom;
    const rad = polarAngleDeg * Math.PI / 180;
    const gx = state.drawStart.x + Math.cos(rad) * guideLen;
    const gy = state.drawStart.y + Math.sin(rad) * guideLen;
    ctx.beginPath();
    ctx.moveTo(state.drawStart.x, state.drawStart.y);
    ctx.lineTo(gx, gy);
    ctx.strokeStyle = 'rgba(76,201,240,0.35)';
    ctx.lineWidth = 1 / state.zoom;
    ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Etichetta angolo
    const labelX = state.drawStart.x + Math.cos(rad) * 40 / state.zoom;
    const labelY = state.drawStart.y + Math.sin(rad) * 40 / state.zoom;
    ctx.font = `${10 / state.zoom}px 'DM Mono'`;
    ctx.fillStyle = '#4cc9f0';
    ctx.textAlign = 'center';
    ctx.fillText(`${polarAngleDeg}°`, labelX, labelY - 6 / state.zoom);
  }

  // ── Corpo muro in anteprima ──
  const colors = getColors(state.activeState);
  ctx.beginPath();
  ctx.moveTo(sx + nx * half, sy + ny * half);
  ctx.lineTo(ex + nx * half, ey + ny * half);
  ctx.lineTo(ex - nx * half, ey - ny * half);
  ctx.lineTo(sx - nx * half, sy - ny * half);
  ctx.closePath();
  ctx.fillStyle   = colors.fill + '88'; ctx.fill();
  ctx.strokeStyle = polarActive ? '#4cc9f0' : colors.fill;
  ctx.lineWidth   = 1.5 / state.zoom;
  ctx.setLineDash([5 / state.zoom, 3 / state.zoom]); ctx.stroke(); ctx.setLineDash([]);

  // Linea asse di riferimento (asse sinistra/destra)
  if (axis !== 'center') {
    ctx.beginPath();
    ctx.moveTo(state.drawStart.x, state.drawStart.y);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = '#4cc9f088'; ctx.lineWidth = 1 / state.zoom;
    ctx.setLineDash([3 / state.zoom, 3 / state.zoom]); ctx.stroke(); ctx.setLineDash([]);
  }

  // Quota lunghezza + angolo reale
  const mid = { x: (sx + ex) / 2, y: (sy + ey) / 2 };
  const realAngle = ((Math.atan2(dy, dx) * 180 / Math.PI) % 360 + 360) % 360;
  const labelColor = state.settings.darkCanvas ? '#c8d4f0' : '#555';
  const angleColor = state.settings.darkCanvas ? 'rgba(180,195,240,0.85)' : 'rgba(80,80,130,0.7)';
  ctx.font      = `bold ${12 / state.zoom}px 'DM Mono'`;
  ctx.fillStyle = polarActive ? '#4cc9f0' : labelColor;
  ctx.textAlign = 'center';
  ctx.fillText(`${(len / state.scale).toFixed(2)}m`, mid.x, mid.y - half - 4 / state.zoom);
  // Mostra angolo sotto la quota solo se non è snap esatto su multiplo di 90
  if (!polarActive || polarAngleDeg % 90 !== 0) {
    ctx.font      = `${9 / state.zoom}px 'DM Mono'`;
    ctx.fillStyle = angleColor;
    ctx.fillText(`${realAngle.toFixed(1)}°`, mid.x, mid.y - half - 14 / state.zoom);
  }

  // Cerchio snap a muro
  const snappedW = snapToWalls(state.drawCurrent);
  if (snappedW !== state.drawCurrent) {
    ctx.beginPath();
    ctx.arc(snappedW.x, snappedW.y, SNAP_THRESHOLD / state.zoom / 2, 0, Math.PI * 2);
    ctx.strokeStyle = '#4cc9f0'; ctx.lineWidth = 1.5 / state.zoom; ctx.stroke();
  }
}

// ============================================================
// HOVER demolizioni
// ============================================================

function drawDemoHover() {
  const pos = state.drawCurrent;
  const { ctx } = state;

  // Prima cerca serramenti (priorità)
  for (const o of state.openings) {
    if (o.state === 'demo') continue;
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const px = wall.start.x + o.t * dx, py = wall.start.y + o.t * dy;
    const oWidth = (o.width / 100) * state.scale;
    if (dist(pos, { x: px, y: py }) < oWidth / 2 + SNAP_THRESHOLD / state.zoom) {
      const ux = dx / len, uy = dy / len;
      const thick = (wall.thickness || 20) / 100 * state.scale / 2;
      const nx = -uy * thick, ny = ux * thick;
      const hW = oWidth / 2;
      ctx.beginPath();
      ctx.moveTo(px - ux*hW + nx, py - uy*hW + ny);
      ctx.lineTo(px + ux*hW + nx, py + uy*hW + ny);
      ctx.lineTo(px + ux*hW - nx, py + uy*hW - ny);
      ctx.lineTo(px - ux*hW - nx, py - uy*hW - ny);
      ctx.closePath();
      ctx.strokeStyle = '#f5c518'; ctx.lineWidth = 2.5 / state.zoom;
      ctx.fillStyle = 'rgba(245,197,24,0.15)'; ctx.fill(); ctx.stroke();
      return; // solo il primo trovato
    }
  }

  // Poi cerca muri: solo quello più vicino dentro cui si trova il cursore
  let bestWall = null, bestDist = Infinity;
  for (const w of state.walls) {
    if (w.state === 'demo') continue;
    const o = getWallOutline(w);
    if (!o) continue;
    if (isPointInWallRect(pos, w, o)) {
      const d = distPointToSegment(pos, w.start, w.end);
      if (d.dist < bestDist) { bestDist = d.dist; bestWall = w; }
    }
  }
  if (bestWall) {
    const o = getWallOutline(bestWall);
    ctx.beginPath();
    ctx.moveTo(o.tl.x, o.tl.y); ctx.lineTo(o.tr.x, o.tr.y);
    ctx.lineTo(o.br.x, o.br.y); ctx.lineTo(o.bl.x, o.bl.y); ctx.closePath();
    ctx.strokeStyle = '#f5c518'; ctx.lineWidth = 2.5 / state.zoom;
    ctx.fillStyle = 'rgba(245,197,24,0.15)'; ctx.fill(); ctx.stroke();
    return;
  }

  // Pilastri
  for (const c of state.columns) {
    if (c.state === 'demo') continue;
    const cw = (c.width  / 100) * state.scale;
    const ch = (c.height / 100) * state.scale;
    if (Math.abs(pos.x - c.x) < cw/2 + 8 && Math.abs(pos.y - c.y) < ch/2 + 8) {
      ctx.strokeStyle = '#f5c518'; ctx.lineWidth = 2.5 / state.zoom;
      ctx.fillStyle = 'rgba(245,197,24,0.15)';
      ctx.fillRect(c.x - cw/2, c.y - ch/2, cw, ch);
      ctx.strokeRect(c.x - cw/2, c.y - ch/2, cw, ch);
      return;
    }
  }
}

// ============================================================
// HOVER GOMMA — evidenzia in rosso l'elemento da eliminare
// ============================================================

function drawEraserHover() {
  const pos = state.drawCurrent;
  const { ctx } = state;
  const hoverFill   = 'rgba(230,57,70,0.18)';
  const hoverStroke = '#e63946';

  // Serramenti
  for (const o of state.openings) {
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const px = wall.start.x + o.t * dx, py = wall.start.y + o.t * dy;
    const oWidth = (o.width / 100) * state.scale;
    if (dist(pos, { x: px, y: py }) < oWidth / 2 + SNAP_THRESHOLD / state.zoom) {
      const ux = dx / len, uy = dy / len;
      const thick = (wall.thickness || 20) / 100 * state.scale / 2;
      const nx = -uy * thick, ny = ux * thick;
      const hW = oWidth / 2;
      ctx.beginPath();
      ctx.moveTo(px - ux*hW + nx, py - uy*hW + ny);
      ctx.lineTo(px + ux*hW + nx, py + uy*hW + ny);
      ctx.lineTo(px + ux*hW - nx, py + uy*hW - ny);
      ctx.lineTo(px - ux*hW - nx, py - uy*hW - ny);
      ctx.closePath();
      ctx.strokeStyle = hoverStroke; ctx.lineWidth = 2.5 / state.zoom;
      ctx.fillStyle = hoverFill; ctx.fill(); ctx.stroke();
      return;
    }
  }

  // Scale
  for (const s of (state.stairs || [])) {
    const W = (s.width  / 100) * state.scale / 2;
    const H = (s.height / 100) * state.scale / 2;
    const cos = Math.cos(-(s.angle || 0));
    const sin = Math.sin(-(s.angle || 0));
    const dx = pos.x - s.x, dy = pos.y - s.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const margin = SNAP_THRESHOLD / state.zoom;
    if (Math.abs(localX) <= W + margin && Math.abs(localY) <= H + margin) {
      ctx.save();
      ctx.translate(s.x, s.y); ctx.rotate(s.angle || 0);
      ctx.strokeStyle = hoverStroke; ctx.lineWidth = 2.5 / state.zoom;
      ctx.fillStyle = hoverFill;
      ctx.fillRect(-W, -H, W*2, H*2);
      ctx.strokeRect(-W, -H, W*2, H*2);
      ctx.restore();
      return;
    }
  }

  // Testi
  for (const t of state.texts) {
    if (Math.abs(pos.x - t.x) < 60 && Math.abs(pos.y - t.y) < 20) {
      ctx.strokeStyle = hoverStroke; ctx.lineWidth = 1.5 / state.zoom;
      ctx.fillStyle = hoverFill;
      ctx.fillRect(t.x - 60, t.y - 18, 120, 24);
      ctx.strokeRect(t.x - 60, t.y - 18, 120, 24);
      return;
    }
  }

  // Pilastri
  for (const c of state.columns) {
    const cw = (c.width  / 100) * state.scale;
    const ch = (c.height / 100) * state.scale;
    if (Math.abs(pos.x - c.x) < cw/2 + 8 && Math.abs(pos.y - c.y) < ch/2 + 8) {
      ctx.strokeStyle = hoverStroke; ctx.lineWidth = 2.5 / state.zoom;
      ctx.fillStyle = hoverFill;
      ctx.fillRect(c.x - cw/2, c.y - ch/2, cw, ch);
      ctx.strokeRect(c.x - cw/2, c.y - ch/2, cw, ch);
      return;
    }
  }

  // Muri
  let bestWall = null, bestDist = Infinity;
  for (const w of state.walls) {
    const o = getWallOutline(w);
    if (!o) continue;
    if (isPointInWallRect(pos, w, o)) {
      const d = distPointToSegment(pos, w.start, w.end);
      if (d.dist < bestDist) { bestDist = d.dist; bestWall = w; }
    }
  }
  if (bestWall) {
    const o = getWallOutline(bestWall);
    ctx.beginPath();
    ctx.moveTo(o.tl.x, o.tl.y); ctx.lineTo(o.tr.x, o.tr.y);
    ctx.lineTo(o.br.x, o.br.y); ctx.lineTo(o.bl.x, o.bl.y); ctx.closePath();
    ctx.strokeStyle = hoverStroke; ctx.lineWidth = 2.5 / state.zoom;
    ctx.fillStyle = hoverFill; ctx.fill(); ctx.stroke();
  }
}

// ============================================================
// MODALITÀ DEMOLIZIONE
// Muri/pilastri → diventano gialli
// Serramenti → diventano gialli (solo il serramento),
//              il foro nel muro viene riempito con un
//              fill-wall rosso (nuova opera di tamponamento)
// ============================================================

function handleDemoClick(pos) {
  // Priorità: serramenti (più piccoli, più precisi)
  for (const o of state.openings) {
    if (o.state === 'demo') continue;
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const px = wall.start.x + o.t * dx, py = wall.start.y + o.t * dy;
    const oWidth = (o.width / 100) * state.scale;
    if (dist(pos, { x: px, y: py }) < oWidth / 2 + SNAP_THRESHOLD / state.zoom) {
      // Solo questo serramento diventa giallo
      o.state = 'demo';
      createFillWall(wall, o.t, o.width);
      pushHistory(); saveProject(); redraw();
      showToast('🟡 Serramento demolito → tamponamento rosso aggiunto');
      return;
    }
  }

  // Muri: trova il più vicino e segna SOLO quello
  let bestWall = null, bestDist = Infinity;
  for (const w of state.walls) {
    if (w.state === 'demo') continue;
    const d = distPointToSegment(pos, w.start, w.end);
    const o = getWallOutline(w);
    if (!o) continue;
    // Controlla che il click sia DENTRO il rettangolo del muro
    const inRect = isPointInWallRect(pos, w, o);
    if (inRect && d.dist < bestDist) {
      bestDist = d.dist;
      bestWall = w;
    }
  }
  if (!bestWall) {
    // Fallback: cerca il muro più vicino entro soglia
    for (const w of state.walls) {
      if (w.state === 'demo') continue;
      const d = distPointToSegment(pos, w.start, w.end);
      if (d.dist < (SNAP_THRESHOLD * 2) / state.zoom && d.dist < bestDist) {
        bestDist = d.dist; bestWall = w;
      }
    }
  }
  if (bestWall) {
    bestWall.state = 'demo';
    pushHistory(); saveProject(); redraw();
    showToast('🟡 Muro marcato come demolizione');
    return;
  }

  // Pilastri
  for (const c of state.columns) {
    if (c.state === 'demo') continue;
    const cw = (c.width  / 100) * state.scale;
    const ch = (c.height / 100) * state.scale;
    if (Math.abs(pos.x - c.x) < cw/2 + 8 && Math.abs(pos.y - c.y) < ch/2 + 8) {
      c.state = 'demo';
      pushHistory(); saveProject(); redraw();
      showToast('🟡 Pilastro marcato come demolizione');
      return;
    }
  }
  showToast('Clicca su un elemento esistente per demolirlo');
}

// ============================================================
// STRUMENTO GOMMA — elimina elemento selezionato
// ============================================================

/**
 * handleEraserClick — elimina l'elemento cliccato.
 * Priorità: serramenti > scale > testi > pilastri > muri
 */
function handleEraserClick(pos) {
  // 1. Serramenti
  for (let i = 0; i < state.openings.length; i++) {
    const o = state.openings[i];
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const px = wall.start.x + o.t * dx, py = wall.start.y + o.t * dy;
    const oWidth = (o.width / 100) * state.scale;
    if (dist(pos, { x: px, y: py }) < oWidth / 2 + SNAP_THRESHOLD / state.zoom) {
      state.openings.splice(i, 1);
      pushHistory(); saveProject(); redraw();
      showToast('🧹 Serramento eliminato');
      return;
    }
  }

  // 2. Scale
  const stairs = state.stairs || [];
  for (let i = 0; i < stairs.length; i++) {
    const s = stairs[i];
    const W = (s.width  / 100) * state.scale / 2;
    const H = (s.height / 100) * state.scale / 2;
    const cos = Math.cos(-(s.angle || 0));
    const sin = Math.sin(-(s.angle || 0));
    const dx = pos.x - s.x, dy = pos.y - s.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const margin = SNAP_THRESHOLD / state.zoom;
    if (Math.abs(localX) <= W + margin && Math.abs(localY) <= H + margin) {
      state.stairs.splice(i, 1);
      pushHistory(); saveProject(); redraw();
      showToast('🧹 Scala eliminata');
      return;
    }
  }

  // 3. Testi
  for (let i = 0; i < state.texts.length; i++) {
    const t = state.texts[i];
    if (Math.abs(pos.x - t.x) < 60 && Math.abs(pos.y - t.y) < 20) {
      state.texts.splice(i, 1);
      pushHistory(); saveProject(); redraw();
      showToast('🧹 Testo eliminato');
      return;
    }
  }

  // 4. Pilastri
  for (let i = 0; i < state.columns.length; i++) {
    const c = state.columns[i];
    const cw = (c.width  / 100) * state.scale;
    const ch = (c.height / 100) * state.scale;
    if (Math.abs(pos.x - c.x) < cw/2 + 8 && Math.abs(pos.y - c.y) < ch/2 + 8) {
      state.columns.splice(i, 1);
      pushHistory(); saveProject(); redraw();
      showToast('🧹 Pilastro eliminato');
      return;
    }
  }

  // 5. Muri
  let bestWall = null, bestIdx = -1, bestDist = Infinity;
  for (let i = 0; i < state.walls.length; i++) {
    const w = state.walls[i];
    const o = getWallOutline(w);
    if (!o) continue;
    if (isPointInWallRect(pos, w, o)) {
      const d = distPointToSegment(pos, w.start, w.end);
      if (d.dist < bestDist) { bestDist = d.dist; bestWall = w; bestIdx = i; }
    }
  }
  if (!bestWall) {
    for (let i = 0; i < state.walls.length; i++) {
      const w = state.walls[i];
      const d = distPointToSegment(pos, w.start, w.end);
      if (d.dist < (SNAP_THRESHOLD * 2) / state.zoom && d.dist < bestDist) {
        bestDist = d.dist; bestWall = w; bestIdx = i;
      }
    }
  }
  if (bestWall && bestIdx !== -1) {
    // Rimuovi anche i serramenti agganciati al muro
    state.openings = state.openings.filter(o => o.wallId !== bestWall.id);
    state.walls.splice(bestIdx, 1);
    pushHistory(); saveProject(); redraw();
    showToast('🧹 Muro eliminato');
    return;
  }

  showToast('🧹 Clicca su un elemento per eliminarlo');
}

/** Verifica se un punto è dentro il rettangolo di un muro */
function isPointInWallRect(pos, w, o) {
  // Trasforma nel sistema di riferimento del muro
  const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
  const len = o.len;
  if (len < 1) return false;
  const localX = ((pos.x - w.start.x) * dx + (pos.y - w.start.y) * dy) / len;
  const localY = ((pos.x - w.start.x) * (-dy) + (pos.y - w.start.y) * dx) / len;
  const margin = SNAP_THRESHOLD / state.zoom;
  return localX >= -margin && localX <= len + margin &&
         Math.abs(localY) <= o.thick + margin;
}

// ============================================================
// TAP su serramento per flip/rotate (tool select + click)
// ============================================================

function handleOpeningTap(pos) {
  for (const o of state.openings) {
    if (o.type !== 'door') continue;
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const px = wall.start.x + o.t * dx, py = wall.start.y + o.t * dy;
    const oWidth = (o.width / 100) * state.scale;
    if (dist(pos, { x: px, y: py }) < oWidth / 2 + SNAP_THRESHOLD / state.zoom) {
      // 4 stati che coprono tutti i sensi di apertura:
      // Stato 0: flip=false, rotate=0  → cardine sx, apre verso +nx
      // Stato 1: flip=false, rotate=1  → cardine sx, apre verso -nx  (specchio asse muro)
      // Stato 2: flip=true,  rotate=0  → cardine dx, apre verso +nx  (specchio asse normale)
      // Stato 3: flip=true,  rotate=1  → cardine dx, apre verso -nx  (entrambi)
      const f = o.flip || false;
      const r = o.rotate || 0;
      if (!f && !r) {
        o.flip = false; o.rotate = 1;
        showToast('↕ Ribaltata (asse muro)');
      } else if (!f && r) {
        o.flip = true; o.rotate = 0;
        showToast('⇄ Specchiata (asse normale)');
      } else if (f && !r) {
        o.flip = true; o.rotate = 1;
        showToast('↙ Ribaltata entrambi gli assi');
      } else {
        o.flip = false; o.rotate = 0;
        showToast('↩ Orientamento originale');
      }
      pushHistory(); saveProject(); redraw();
      return true;
    }
  }
  return false;
}

// ============================================================
// EVENTI CANVAS
// ============================================================

function setupCanvasEvents() {
  const c = state.canvas;
  c.addEventListener('mousedown', onPointerDown);
  c.addEventListener('mousemove', onPointerMove);
  c.addEventListener('mouseup',   onPointerUp);
  c.addEventListener('wheel', onWheel, { passive: false });
  c.addEventListener('touchstart', onTouchStart, { passive: false });
  c.addEventListener('touchmove',  onTouchMove,  { passive: false });
  c.addEventListener('touchend',   onTouchEnd);
  // Traccia se il mouse è realmente sopra il canvas (fix bug demo hover)
  c.addEventListener('mouseenter', () => { state._mouseOverCanvas = true; });
  c.addEventListener('mouseleave', () => { state._mouseOverCanvas = false; redraw(); });
}

function onPointerDown(e) {
  e.preventDefault();
  const pos = getEventPos(e);
  if (e.button === 1 || e.altKey) { state.lastPanPos = { x: e.clientX, y: e.clientY }; return; }
  if (state.activeState === 'demo') { handleDemoClick(pos); return; }
  if (state.activeTool === 'eraser') { handleEraserClick(pos); return; }

  if (state.activeTool === 'select') {
    const opening = findOpeningAtPos(pos);
    if (opening) {
      // Avvia timer long-press (600ms) per spostamento
      if (state._longPressTimer) clearTimeout(state._longPressTimer);
      state._pendingOpeningForLongPress = { opening, pos };
      state._longPressTimer = setTimeout(() => {
        if (state._pendingOpeningForLongPress) {
          startDraggingOpening(state._pendingOpeningForLongPress.opening, state._pendingOpeningForLongPress.pos);
          showToast('🖐 Sposta serramento');
          state._pendingOpeningForLongPress = null;
          state._longPressTimer = null;
        }
      }, 600);
      state._longPressStartPos = { ...pos };
      return;
    }
    // Gestione scala: tap = ruota, long-press = sposta
    const stair = findStairAtPos(pos);
    if (stair) {
      if (state._longPressTimer) clearTimeout(state._longPressTimer);
      state._pendingStairForLongPress = { stair, pos };
      state._longPressTimer = setTimeout(() => {
        if (state._pendingStairForLongPress) {
          startDraggingStair(state._pendingStairForLongPress.stair, state._pendingStairForLongPress.pos);
          showToast('🖐 Sposta scala');
          state._pendingStairForLongPress = null;
          state._longPressTimer = null;
        }
      }, 600);
      state._longPressStartPos = { ...pos };
      return;
    }
    return;
  }

  handleDrawStart(pos);
}

function onPointerMove(e) {
  e.preventDefault();
  state.drawCurrent = getEventPos(e);
  updateStatusBar();
  if (state.lastPanPos) {
    state.offsetX += (e.clientX - state.lastPanPos.x) / state.zoom;
    state.offsetY += (e.clientY - state.lastPanPos.y) / state.zoom;
    state.lastPanPos = { x: e.clientX, y: e.clientY };
    redraw(); return;
  }
  // Se il mouse si muove troppo durante il long-press, cancella il timer (è un pan)
  if (state._longPressTimer && state._longPressStartPos) {
    const moved = dist(getEventPos(e), state._longPressStartPos);
    if (moved > 8 / state.zoom) {
      clearTimeout(state._longPressTimer);
      state._longPressTimer = null;
      state._pendingOpeningForLongPress = null;
      state._pendingStairForLongPress = null;
    }
  }
  if (state.isDragging) {
    updateDraggingOpening(getEventPos(e));
    redraw(); return;
  }
  if (state.isDraggingStair) {
    updateDraggingStair(getEventPos(e));
    redraw(); return;
  }
  if (state.isDrawing || state.activeState === 'demo' || state.activeTool === 'eraser') redraw();
}

function onPointerUp(e) {
  if (state.lastPanPos) { state.lastPanPos = null; return; }

  // Cancella long-press timer
  if (state._longPressTimer) {
    clearTimeout(state._longPressTimer);
    state._longPressTimer = null;
  }

  if (state.isDragging) {
    endDraggingOpening(false);
    state._pendingOpeningForLongPress = null;
    return;
  }

  if (state.isDraggingStair) {
    endDraggingStair();
    state._pendingStairForLongPress = null;
    return;
  }

  if (state.activeTool === 'select') {
    // Se c'era un opening pendente e non si è avviato il drag → era un tap → ruota
    if (state._pendingOpeningForLongPress) {
      handleOpeningTap(state._pendingOpeningForLongPress.pos);
      state._pendingOpeningForLongPress = null;
    }
    // Se c'era una scala pendente → era un tap → ruota 90°
    if (state._pendingStairForLongPress) {
      handleStairTap(state._pendingStairForLongPress.stair);
      state._pendingStairForLongPress = null;
    }
    return;
  }
  if (state.isDrawing) handleDrawEnd(getEventPos(e));
}

function onWheel(e) {
  e.preventDefault();
  const rect   = state.canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const nz = Math.max(0.1, Math.min(10, state.zoom * factor));
  state.offsetX = cx / nz - cx / state.zoom + state.offsetX;
  state.offsetY = cy / nz - cy / state.zoom + state.offsetY;
  state.zoom = nz; redraw();
}

function onTouchStart(e) {
  e.preventDefault();
  state._mouseOverCanvas = true;
  state.lastTouches = Array.from(e.touches);
  if (e.touches.length === 1) {
    const pos = getEventPos(e);
    state._touchStartPos = { ...pos };
    state._touchStartTime = Date.now();
    if (state.activeState === 'demo') { handleDemoClick(pos); return; }
    if (state.activeTool === 'eraser') { handleEraserClick(pos); return; }
    if (state.activeTool === 'select') {
      const opening = findOpeningAtPos(pos);
      if (opening) {
        // Long-press 600ms per spostare
        if (state._longPressTimer) clearTimeout(state._longPressTimer);
        state._pendingOpeningForLongPress = { opening, pos };
        state._longPressTimer = setTimeout(() => {
          if (state._pendingOpeningForLongPress) {
            startDraggingOpening(state._pendingOpeningForLongPress.opening, state._pendingOpeningForLongPress.pos);
            showToast('🖐 Tieni premuto e trascina per spostare');
            state._pendingOpeningForLongPress = null;
            state._longPressTimer = null;
          }
        }, 600);
        state._longPressStartPos = { ...pos };
        return;
      }
      // Gestione scala: tap = ruota 90°, long-press = sposta
      const stair = findStairAtPos(pos);
      if (stair) {
        if (state._longPressTimer) clearTimeout(state._longPressTimer);
        state._pendingStairForLongPress = { stair, pos };
        state._longPressTimer = setTimeout(() => {
          if (state._pendingStairForLongPress) {
            startDraggingStair(state._pendingStairForLongPress.stair, state._pendingStairForLongPress.pos);
            showToast('🖐 Tieni premuto e trascina per spostare la scala');
            state._pendingStairForLongPress = null;
            state._longPressTimer = null;
          }
        }, 600);
        state._longPressStartPos = { ...pos };
        return;
      }
      state._pendingTapPos = pos;
      return;
    }
    handleDrawStart(pos);
  } else if (e.touches.length === 2) {
    state.isDrawing = false;
    state._pendingTapPos = null;
    if (state._longPressTimer) { clearTimeout(state._longPressTimer); state._longPressTimer = null; }
    state._pendingOpeningForLongPress = null;
    state.lastPinchDist = getTouchDist(e.touches[0], e.touches[1]);
  }
}

function onTouchMove(e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    state.drawCurrent = getEventPos(e);

    // Annulla long-press se si muove
    if (state._longPressTimer && state._longPressStartPos) {
      const moved = dist(state.drawCurrent, state._longPressStartPos);
      if (moved > 8 / state.zoom) {
        clearTimeout(state._longPressTimer);
        state._longPressTimer = null;
        state._pendingOpeningForLongPress = null;
        state._pendingStairForLongPress = null;
      }
    }

    if (state._pendingTapPos && !state.isDragging) {
      const moved = dist(state.drawCurrent, state._touchStartPos || state._pendingTapPos);
      if (moved > 8 / state.zoom) {
        state._pendingTapPos = null;
      } else {
        state.lastTouches = Array.from(e.touches);
        return;
      }
    }
    if (state.isDrawing) redraw();
    else if (state.isDragging) {
      updateDraggingOpening(state.drawCurrent);
      redraw();
    } else if (state.isDraggingStair) {
      updateDraggingStair(state.drawCurrent);
      redraw();
    } else if (!state._longPressTimer) {
      // Pan solo se non stiamo aspettando un long-press
      const prev = state.lastTouches[0];
      if (prev) {
        state.offsetX += (e.touches[0].clientX - prev.clientX) / state.zoom;
        state.offsetY += (e.touches[0].clientY - prev.clientY) / state.zoom;
        redraw();
      }
    }
    state.lastTouches = Array.from(e.touches);
  } else if (e.touches.length === 2) {
    state._pendingTapPos = null;
    const nd = getTouchDist(e.touches[0], e.touches[1]);
    const factor = nd / (state.lastPinchDist || nd);
    const rect   = state.canvas.getBoundingClientRect();
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
    const nz = Math.max(0.1, Math.min(10, state.zoom * factor));
    state.offsetX = cx / nz - cx / state.zoom + state.offsetX;
    state.offsetY = cy / nz - cy / state.zoom + state.offsetY;
    state.zoom = nz; state.lastPinchDist = nd;
    state.lastTouches = Array.from(e.touches); redraw();
  }
}

function onTouchEnd(e) {
  // Cancella long-press timer
  if (state._longPressTimer) {
    clearTimeout(state._longPressTimer);
    state._longPressTimer = null;
  }
  if (e.touches.length === 0) state._mouseOverCanvas = false;

  if (state.isDragging) {
    endDraggingOpening(false);
    state._pendingOpeningForLongPress = null;
    state.lastTouches = Array.from(e.touches);
    return;
  }

  if (state.isDraggingStair) {
    endDraggingStair();
    state._pendingStairForLongPress = null;
    state.lastTouches = Array.from(e.touches);
    return;
  }

  // Tap su serramento → ruota (solo se il long-press non era scattato)
  if (state.activeTool === 'select' && state._pendingOpeningForLongPress && e.touches.length === 0) {
    const pos = state._pendingOpeningForLongPress.pos;
    state._pendingOpeningForLongPress = null;
    handleOpeningTap(pos);
    state.lastTouches = Array.from(e.touches);
    return;
  }
  state._pendingOpeningForLongPress = null;

  // Tap su scala → ruota 90°
  if (state.activeTool === 'select' && state._pendingStairForLongPress && e.touches.length === 0) {
    const { stair } = state._pendingStairForLongPress;
    state._pendingStairForLongPress = null;
    handleStairTap(stair);
    state.lastTouches = Array.from(e.touches);
    return;
  }
  state._pendingStairForLongPress = null;

  // Tap in select generico
  if (state.activeTool === 'select' && state._pendingTapPos && e.touches.length === 0) {
    const tapDuration = Date.now() - (state._touchStartTime || 0);
    if (tapDuration < 400) {
      handleOpeningTap(state._pendingTapPos);
    }
    state._pendingTapPos = null;
    state.lastTouches = Array.from(e.touches);
    return;
  }
  state._pendingTapPos = null;

  if (e.changedTouches.length === 1 && e.touches.length === 0 && state.isDrawing) {
    const t    = e.changedTouches[0];
    const rect = state.canvas.getBoundingClientRect();
    handleDrawEnd(canvasToWorld(t.clientX - rect.left, t.clientY - rect.top));
  }
  state.lastTouches = Array.from(e.touches);
}

function getTouchDist(t1, t2) {
  return Math.sqrt((t2.clientX - t1.clientX) ** 2 + (t2.clientY - t1.clientY) ** 2);
}

// ============================================================
// DRAG APERTURE — long-press per spostare, tap per ruotare
// ============================================================

function findOpeningAtPos(pos) {
  for (const o of state.openings) {
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const px = wall.start.x + o.t * dx, py = wall.start.y + o.t * dy;
    const oWidth = (o.width / 100) * state.scale;
    if (dist(pos, { x: px, y: py }) < oWidth / 2 + SNAP_THRESHOLD / state.zoom) {
      return o;
    }
  }
  return null;
}

/** Trova una scala sotto il cursore */
function findStairAtPos(pos) {
  for (const s of (state.stairs || [])) {
    const W = (s.width  / 100) * state.scale / 2;
    const H = (s.height / 100) * state.scale / 2;
    // Trasforma nel sistema locale ruotato della scala
    const cos = Math.cos(-(s.angle || 0));
    const sin = Math.sin(-(s.angle || 0));
    const dx = pos.x - s.x, dy = pos.y - s.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const margin = SNAP_THRESHOLD / state.zoom;
    if (Math.abs(localX) <= W + margin && Math.abs(localY) <= H + margin) {
      return s;
    }
  }
  return null;
}

/** Tap rapido su scala → ruota di 90° */
function handleStairTap(stair) {
  stair.angle = ((stair.angle || 0) + Math.PI / 2) % (Math.PI * 2);
  pushHistory(); saveProject(); redraw();
  showToast('🔄 Scala ruotata 90°');
}

/** Long-press su scala → avvia spostamento */
function startDraggingStair(stair, pos) {
  state.isDraggingStair = true;
  state.draggedStair = stair;
  state.dragStairOffsetX = pos.x - stair.x;
  state.dragStairOffsetY = pos.y - stair.y;
  state.canvas.style.cursor = 'grabbing';
}

function updateDraggingStair(currentPos) {
  if (!state.draggedStair) return;
  state.draggedStair.x = currentPos.x - state.dragStairOffsetX;
  state.draggedStair.y = currentPos.y - state.dragStairOffsetY;
}

function endDraggingStair() {
  if (state.draggedStair) {
    pushHistory(); saveProject();
    showToast('Scala spostata');
  }
  state.isDraggingStair = false;
  state.draggedStair = null;
  state.canvas.style.cursor = 'crosshair';
}

function startDraggingOpening(opening, pos) {
  state.isDragging = true;
  state.draggedOpening = opening;
  state.dragStartPos = pos;
  state.dragOriginalT = opening.t;
  state.canvas.style.cursor = 'grabbing';
}

function updateDraggingOpening(currentPos) {
  if (!state.draggedOpening || !state.dragStartPos) return;

  const wall = state.walls.find(w => w.id === state.draggedOpening.wallId);
  if (!wall) return;

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  const wallDir = { x: dx / len, y: dy / len };
  const toStart = { x: currentPos.x - wall.start.x, y: currentPos.y - wall.start.y };
  const projection = toStart.x * wallDir.x + toStart.y * wallDir.y;
  let newT = projection / len;

  // Clamp: lascia almeno metà larghezza serramento dentro il muro
  const halfOpeningT = (state.draggedOpening.width / 100) * state.scale / 2 / len;
  newT = Math.max(halfOpeningT, Math.min(1 - halfOpeningT, newT));

  state.draggedOpening.t = newT;
}

function endDraggingOpening(isTap) {
  if (state.draggedOpening && !isTap) {
    pushHistory();
    saveProject();
    showToast('Serramento spostato');
  }
  state.isDragging = false;
  state.draggedOpening = null;
  state.dragStartPos = null;
  state.dragOriginalT = null;
  state._longPressTimer = null;
  state.canvas.style.cursor = 'crosshair';
}

// ============================================================
// LOGICA DI DISEGNO
// ============================================================

function handleDrawStart(pos) {
  const tool = state.activeTool;
  if (tool === 'select' || tool === 'eraser') return;

  if (tool === 'wall') {
    const snapped  = snapToWalls(pos);
    state.isDrawing = true; state.drawStart = snapped; state.drawCurrent = snapped;
    return;
  }

  if (tool === 'door' || tool === 'window') {
    const nearest = findNearestWall(pos);
    if (!nearest) { showToast('Clicca più vicino a un muro'); return; }
    // Posiziona subito il serramento con i parametri dal pannello
    const width  = tool === 'door' ? state.propDoorWidth   : state.propWindowWidth;
    const height = tool === 'door' ? state.propDoorHeight : state.propWindowHeight;
    placeOpening(tool, nearest.wall, nearest.t, width, height);
    return;
  }

  if (tool === 'column') {
    const cw = state.propColW, ch = state.propColH;
    state.columns.push({
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      x: pos.x, y: pos.y,
      width: cw, height: ch,
      state: state.activeState,
    });
    pushHistory(); saveProject(); redraw();
    return;
  }

  if (tool === 'text') {
    const label = state.propTextLabel || 'Testo';
    const size  = state.propTextSize  || 14;
    state.texts.push({
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      x: pos.x, y: pos.y, label, size,
      color: state.activeState === 'new' ? '#e63946' : state.activeState === 'demo' ? '#b8860b' : (state.settings.darkCanvas ? '#d4d8e8' : '#333'),
    });
    pushHistory(); saveProject(); redraw();
    return;
  }

  if (tool === 'stair') {
    if (!state.stairs) state.stairs = [];
    // Snap della scala al muro vicino
    const snappedPos = snapStairToWall(pos,
      (state.propStairW  || 100),
      (state.propStairH  || 240));
    state.stairs.push({
      id:     `s_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      x:      snappedPos.x, y: snappedPos.y,
      width:  state.propStairW  || 100,
      height: state.propStairH  || 240,
      steps:  state.propStairSteps || 12,
      dir:    state.propStairDir   || 'up',
      angle:  snappedPos.angle || 0,
      state:  state.activeState,
      color:  state.propStairColor || 'default',
    });
    pushHistory(); saveProject(); redraw();
    return;
  }

  if (tool === 'cut') {
    // Avvia la linea di taglio
    state.isDrawing = true; state.drawStart = { ...pos }; state.drawCurrent = { ...pos };
    return;
  }
}

function handleDrawEnd(pos) {
  if (!state.isDrawing) return;
  state.isDrawing = false;

  // ── Strumento TAGLIA ──
  if (state.activeTool === 'cut') {
    performCut(state.drawStart, pos);
    redraw(); return;
  }

  if (state.activeTool !== 'wall') return;

  // Snap a nodi esistenti (priorità massima)
  const snappedToWall = snapToWalls(pos);
  const wallSnapOccurred = snappedToWall !== pos;
  let end;

  if (wallSnapOccurred) {
    end = snappedToWall;
  } else if (state.settings.snapAngle) {
    // Puntamento polare: snap solo se il cursore è vicino a un angolo standard
    const dx = pos.x - state.drawStart.x, dy = pos.y - state.drawStart.y;
    const { snapped } = getPolarSnap(dx, dy);
    end = snapped
      ? { x: state.drawStart.x + snapped.x, y: state.drawStart.y + snapped.y }
      : pos;  // angolo libero
  } else {
    end = pos;
  }

  // Se non c'è stato snap a un nodo, tenta auto-estensione al muro più vicino
  if (!wallSnapOccurred) {
    end = autoExtendWallToNearest(state.drawStart, end);
  }

  const len = dist(state.drawStart, end);
  if (len < 5) { redraw(); return; }

  const lenCm = Math.round(len / state.scale * 100);
  state.pendingWall = { start: { ...state.drawStart }, end: { ...end } };
  document.getElementById('drawn-length').textContent = lenCm;
  document.getElementById('input-wall-length').value  = lenCm;
  openModal('modal-wall-length');
}

function confirmWall(exactCm) {
  const w = state.pendingWall;
  if (!w) return;
  let end = { ...w.end };
  if (exactCm && exactCm > 0) {
    const exactPx = (exactCm / 100) * state.scale;
    const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) end = { x: w.start.x + (dx / len) * exactPx, y: w.start.y + (dy / len) * exactPx };
  }

  // Correzione asse: sposta start/end in base all'asse scelto
  // L'utente disegna sul lato sinistro, centro o destro del muro
  // La misura (thickness) è sempre quella totale
  const axis = state.propWallAxis || 'center';
  const thick = (state.propWallThickness / 100) * state.scale;
  const half = thick / 2;
  let startAdj = { ...w.start }, endAdj = { ...end };

  if (axis !== 'center') {
    const dx = end.x - w.start.x, dy = end.y - w.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      // Normale perpendicolare al muro (verso sinistra del vettore direzione)
      const nx = -dy / len, ny = dx / len;
      // 'left' = la linea disegnata è il lato sinistro → sposta centro verso destra (+ normale)
      // 'right' = la linea disegnata è il lato destro → sposta centro verso sinistra (- normale)
      const offset = axis === 'left' ? half : -half;
      startAdj = { x: w.start.x + nx * offset, y: w.start.y + ny * offset };
      endAdj   = { x: end.x   + nx * offset, y: end.y   + ny * offset };
    }
  }

  state.walls.push({
    id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    start: startAdj, end: endAdj,
    thickness: state.propWallThickness,
    axis: axis,
    state: state.activeState,
  });
  state.pendingWall = null;
  pushHistory(); saveProject(); redraw();
}

/**
 * Piazza un serramento su un muro.
 *
 * Nuove Opere (activeState = 'new'):
 *   - Se il muro è 'existing': crea un segmento 'demo' (giallo) nel foro
 *     per indicare la parte demolita, e il serramento sarà rosso.
 *   - Il serramento viene aggiunto con stato 'new'.
 *
 * Stato di Fatto / existing:
 *   - Serramento grigio, nessun effetto sul muro.
 */
function placeOpening(type, wall, t, width, height) {
  let openingState = state.activeState;

  if (state.activeState === 'new') {
    // Il foro nel muro esistente viene marcato giallo (demolizione del pezzo)
    if ((wall.state || 'existing') === 'existing') {
      splitWallForOpening(wall, t, width, 'demo');
    }
  }

  state.openings.push({
    id:   `o_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type, wallId: wall.id, t, width, height,
    state: openingState,
    flip: false, rotate: 0,
  });
  pushHistory(); saveProject(); redraw();
}

/**
 * Crea un segmento muro colorato nell'area del foro.
 * newState: 'demo' → giallo (foro per nuova opera)
 */
function splitWallForOpening(wall, t, widthCm, newState) {
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  const len  = Math.sqrt(dx * dx + dy * dy);
  const half = (widthCm / 100) * state.scale / 2 / len;
  const t1 = Math.max(0, t - half), t2 = Math.min(1, t + half);
  state.walls.push({
    id: `w_${Date.now()}_mid`,
    start: { x: wall.start.x + t1*dx, y: wall.start.y + t1*dy },
    end:   { x: wall.start.x + t2*dx, y: wall.start.y + t2*dy },
    thickness: wall.thickness || state.propWallThickness,
    state: newState,
  });
}

/**
 * Crea un muro 'new' (rosso) che riempie il foro di un serramento demolito.
 * Usa lo spessore del muro originale.
 */
function createFillWall(wall, t, widthCm) {
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  const len  = Math.sqrt(dx * dx + dy * dy);
  const half = (widthCm / 100) * state.scale / 2 / len;
  const t1 = Math.max(0, t - half), t2 = Math.min(1, t + half);
  state.walls.push({
    id: `w_${Date.now()}_fill`,
    start: { x: wall.start.x + t1*dx, y: wall.start.y + t1*dy },
    end:   { x: wall.start.x + t2*dx, y: wall.start.y + t2*dy },
    thickness: wall.thickness || state.propWallThickness,
    state: 'new',
  });
}

// ============================================================
// STRUMENTO TAGLIA
// Spezza un muro in due parti separate nel punto in cui la
// linea di taglio (tratteggiata) lo interseca.
// Se il punto di inizio è vicino a un muro, la linea si
// estende automaticamente fino all'intersezione con quel muro.
// ============================================================

/**
 * Esegue il taglio: trova i muri intersecati dalla linea cutStart→cutEnd
 * e li spezza nei punti di intersezione.
 */
function performCut(cutStart, cutEnd) {
  const cdx = cutEnd.x - cutStart.x, cdy = cutEnd.y - cutStart.y;
  const cLen = Math.sqrt(cdx * cdx + cdy * cdy);
  if (cLen < 2) { showToast('Linea di taglio troppo corta'); return; }

  let cutCount = 0;
  const wallsToProcess = [...state.walls];

  for (const w of wallsToProcess) {
    const wdx = w.end.x - w.start.x, wdy = w.end.y - w.start.y;
    const wLen = Math.sqrt(wdx * wdx + wdy * wdy);
    if (wLen < 1) continue;

    // Trova l'intersezione tra la linea di taglio e l'asse del muro
    const inter = lineIntersect(cutStart, { x: cdx, y: cdy }, w.start, { x: wdx, y: wdy });
    if (!inter) continue;

    // Parametro t sull'asse del muro (0=start, 1=end)
    const t = ((inter.x - w.start.x) * wdx + (inter.y - w.start.y) * wdy) / (wLen * wLen);
    if (t < 0.01 || t > 0.99) continue; // intersezione fuori dal segmento

    // Parametro s sulla linea di taglio (deve essere entro la linea)
    const s = ((inter.x - cutStart.x) * cdx + (inter.y - cutStart.y) * cdy) / (cLen * cLen);
    if (s < -0.1 || s > 1.1) continue;

    // Spezza il muro in due al punto t
    const splitPt = { x: w.start.x + t * wdx, y: w.start.y + t * wdy };
    const w1 = {
      id: `w_${Date.now()}_cutA_${Math.random().toString(36).slice(2,5)}`,
      start: { ...w.start }, end: { ...splitPt },
      thickness: w.thickness || state.propWallThickness,
      axis: w.axis, state: w.state || 'existing',
    };
    const w2 = {
      id: `w_${Date.now()}_cutB_${Math.random().toString(36).slice(2,5)}`,
      start: { ...splitPt }, end: { ...w.end },
      thickness: w.thickness || state.propWallThickness,
      axis: w.axis, state: w.state || 'existing',
    };
    // Sostituisci il muro originale con i due segmenti
    const idx = state.walls.findIndex(x => x.id === w.id);
    if (idx !== -1) {
      state.walls.splice(idx, 1, w1, w2);
      cutCount++;
    }
  }

  if (cutCount > 0) {
    pushHistory(); saveProject();
    showToast(`✂ Taglio applicato: ${cutCount} muro${cutCount > 1 ? 'i' : ''} spezzato${cutCount > 1 ? 'i' : ''}`);
  } else {
    showToast('✂ Nessun muro intersecato dalla linea di taglio');
  }
}

/**
 * Disegna la preview della linea di taglio (tratteggiata in arancione),
 * con estensione automatica al muro vicino al punto di inizio.
 */
function drawCutPreview() {
  if (!state.drawStart || !state.drawCurrent) return;
  const { ctx } = state;

  let start = { ...state.drawStart };
  let end   = { ...state.drawCurrent };

  // Auto-estensione: se il punto di start è vicino a un muro, estendi fino ad esso
  const extEnd = findWallExtensionPoint(end, start);
  if (extEnd) end = extEnd;

  ctx.save();
  ctx.setLineDash([8 / state.zoom, 5 / state.zoom]);
  ctx.strokeStyle = '#ff8c00';
  ctx.lineWidth   = 2 / state.zoom;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Icone forbici alle estremità
  ctx.font = `${14 / state.zoom}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ff8c00';
  ctx.fillText('✂', start.x, start.y - 6 / state.zoom);

  ctx.restore();
}

/**
 * Trova il punto dove una linea partendo da `from` verso `to` incontra
 * il primo muro (usato per l'auto-estensione nella preview).
 */
function findWallExtensionPoint(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return null;

  let bestT = Infinity, bestPt = null;

  for (const w of state.walls) {
    // Controlla se il punto `to` (endpoint del taglio) è vicino al muro
    const d = distPointToSegment(to, w.start, w.end);
    if (d.dist < (SNAP_THRESHOLD * 2) / state.zoom) {
      // Proietta la linea di taglio sul muro per trovare l'intersezione esatta
      const wdx = w.end.x - w.start.x, wdy = w.end.y - w.start.y;
      const inter = lineIntersect(from, { x: dx, y: dy }, w.start, { x: wdx, y: wdy });
      if (inter) {
        const t = ((inter.x - from.x) * dx + (inter.y - from.y) * dy) / (len * len);
        if (t > 0.5 && t < bestT) { bestT = t; bestPt = inter; }
      }
    }
  }
  return bestPt;
}

// ============================================================
// AUTO-ESTENSIONE MURO
// Se il punto di fine di un nuovo muro è vicino a un altro muro,
// allunga automaticamente fino al raggiungimento di quel muro.
// ============================================================

/**
 * Estende automaticamente un muro in costruzione fino all'intersezione
 * con il muro più vicino, se il punto finale è entro la soglia.
 */
function autoExtendWallToNearest(start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return end;

  const extendThresh = (SNAP_THRESHOLD * 3) / state.zoom;
  let bestDist = extendThresh, bestPt = null;

  for (const w of state.walls) {
    const wdx = w.end.x - w.start.x, wdy = w.end.y - w.start.y;
    const wLen = Math.sqrt(wdx * wdx + wdy * wdy);
    if (wLen < 1) continue;

    // Trova intersezione tra il nuovo muro e il muro esistente
    const inter = lineIntersect(start, { x: dx, y: dy }, w.start, { x: wdx, y: wdy });
    if (!inter) continue;

    // Il parametro t sul muro esistente deve essere entro il segmento
    const tW = ((inter.x - w.start.x) * wdx + (inter.y - w.start.y) * wdy) / (wLen * wLen);
    if (tW < 0 || tW > 1) continue;

    // Il parametro t sul nuovo muro deve essere OLTRE 1 (estensione) o vicino a 1
    const tNew = ((inter.x - start.x) * dx + (inter.y - start.y) * dy) / (len * len);
    if (tNew < 0.5) continue; // intersezione troppo indietro

    const distFromEnd = dist(end, inter);
    if (distFromEnd < bestDist) {
      bestDist = distFromEnd; bestPt = inter;
    }
  }

  return bestPt || end;
}

// ============================================================
// PANNELLO PROPRIETÀ
// ============================================================

function updatePropsPanel() {
  const tool = state.activeTool;
  const st   = state.activeState;

  // Titolo e icona
  const titles = { wall:'Muro', door:'Porta', window:'Finestra', column:'Pilastro', text:'Testo', select:'Selezione', eraser:'Gomma', stair:'Scala', cut:'Taglia' };
  const icons  = { wall:'🧱', door:'🚪', window:'🪟', column:'⬛', text:'T', select:'↖', eraser:'🧹', stair:'🪜', cut:'✂' };
  document.getElementById('props-title').textContent = titles[tool] || tool;
  document.getElementById('props-icon' ).textContent = icons[tool]  || '';

  // Stato corrente
  const stateEl    = document.getElementById('props-state-indicator');
  const stateLbl   = document.getElementById('props-state-label');
  stateEl.className = `state-indicator ${st}`;
  stateLbl.textContent = st === 'existing' ? 'Stato di Fatto' : st === 'demo' ? 'Demolizioni' : 'Nuove Opere';

  // Sezioni visibili
  const sections = ['props-wall','props-door','props-window','props-column','props-text','props-stair','props-cut','props-eraser','props-selected','props-demo-help','props-new-help'];
  sections.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

  if (st === 'demo') {
    document.getElementById('props-demo-help').style.display = 'block';
    return;
  }
  if (st === 'new' && tool !== 'select') {
    document.getElementById('props-new-help').style.display = 'block';
  }

  if (tool === 'wall')    document.getElementById('props-wall').style.display   = 'block';
  if (tool === 'door')    document.getElementById('props-door').style.display   = 'block';
  if (tool === 'window')  document.getElementById('props-window').style.display = 'block';
  if (tool === 'column')  document.getElementById('props-column').style.display = 'block';
  if (tool === 'text')    document.getElementById('props-text').style.display   = 'block';
  if (tool === 'stair')   document.getElementById('props-stair').style.display  = 'block';
  if (tool === 'eraser')  { const el = document.getElementById('props-eraser'); if (el) el.style.display = 'block'; }
  if (tool === 'cut')     document.getElementById('props-cut').style.display    = 'block';
}

function setupPropsPanel() {
  // Muro
  const propWallThick = document.getElementById('prop-wall-thickness');
  propWallThick.addEventListener('input', () => {
    state.propWallThickness = parseInt(propWallThick.value) || 20;
  });
  document.getElementById('prop-wall-axis').addEventListener('change', e => {
    state.propWallAxis = e.target.value;
  });

  // Porta
  document.getElementById('prop-door-width').addEventListener('input', e => {
    state.propDoorWidth = parseFloat(e.target.value) || 80;
  });
  document.getElementById('prop-door-height').addEventListener('input', e => {
    state.propDoorHeight = parseFloat(e.target.value) || 210;
  });

  // Finestra
  document.getElementById('prop-window-width' ).addEventListener('input', e => { state.propWindowWidth  = parseFloat(e.target.value) || 100; });
  document.getElementById('prop-window-height').addEventListener('input', e => { state.propWindowHeight = parseFloat(e.target.value) || 120; });

  // Pilastro
  document.getElementById('prop-col-w').addEventListener('input', e => { state.propColW = parseFloat(e.target.value) || 30; });
  document.getElementById('prop-col-h').addEventListener('input', e => { state.propColH = parseFloat(e.target.value) || 30; });

  // Testo
  document.getElementById('prop-text-label').addEventListener('input', e => { state.propTextLabel = e.target.value; });
  document.getElementById('prop-text-size' ).addEventListener('input', e => { state.propTextSize  = parseInt(e.target.value) || 14; });

  // Scala
  document.getElementById('prop-stair-w'    ).addEventListener('input', e => { state.propStairW     = parseFloat(e.target.value) || 100; });
  document.getElementById('prop-stair-h'    ).addEventListener('input', e => { state.propStairH     = parseFloat(e.target.value) || 240; });
  document.getElementById('prop-stair-steps').addEventListener('input', e => { state.propStairSteps = parseInt(e.target.value)   || 12;  });
  document.getElementById('prop-stair-dir'  ).addEventListener('change',e => { state.propStairDir   = e.target.value; });
  const stairColorEl = document.getElementById('prop-stair-color');
  if (stairColorEl) stairColorEl.addEventListener('change', e => { state.propStairColor = e.target.value; });
}

// ============================================================
// STATUS BAR
// ============================================================

function updateStatusBar() {
  const names = { wall:'Muro', door:'Porta', window:'Finestra', column:'Pilastro', text:'Testo', select:'Selezione', eraser:'Gomma', stair:'Scala', cut:'Taglia' };
  const stateHint = state.activeState === 'demo' ? ' ● Clicca per demolire' :
                    state.activeState === 'new'  ? ' ● Nuove Opere' : '';
  const toolHint  = state.activeTool === 'cut'   ? ' — Traccia linea di taglio' :
                    state.activeTool === 'stair'  ? ' — Tap=Ruota 90°, LongPress=Sposta' : stateHint;
  document.getElementById('status-tool').textContent = (names[state.activeTool] || state.activeTool) + toolHint;
  if (state.drawCurrent) {
    const m = state.drawCurrent;
    document.getElementById('status-coords').textContent =
      `x: ${Math.round(m.x / state.scale * 100)}cm  y: ${Math.round(m.y / state.scale * 100)}cm`;
  }
  document.getElementById('status-zoom').textContent = `Zoom: ${Math.round(state.zoom * 100)}%`;
  document.getElementById('status-snap').textContent = state.settings.snapAngle ? '📐 Polare ON' : '📐 Polare OFF';
}

// ============================================================
// MODAL HELPERS
// ============================================================

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ============================================================
// BOUNDING BOX
// ============================================================

function getBoundingBox() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of state.walls) {
    for (const p of [w.start, w.end]) {
      const o2 = (w.thickness || 20) / 100 * state.scale / 2;
      minX = Math.min(minX, p.x - o2); maxX = Math.max(maxX, p.x + o2);
      minY = Math.min(minY, p.y - o2); maxY = Math.max(maxY, p.y + o2);
    }
  }
  for (const c of state.columns) {
    const cw = (c.width  / 100) * state.scale, ch = (c.height / 100) * state.scale;
    minX = Math.min(minX, c.x - cw/2); maxX = Math.max(maxX, c.x + cw/2);
    minY = Math.min(minY, c.y - ch/2); maxY = Math.max(maxY, c.y + ch/2);
  }
  for (const t of state.texts) {
    minX = Math.min(minX, t.x - 60); maxX = Math.max(maxX, t.x + 60);
    minY = Math.min(minY, t.y - 20); maxY = Math.max(maxY, t.y + 10);
  }
  for (const s of (state.stairs || [])) {
    const W = (s.width  / 100) * state.scale / 2;
    const H = (s.height / 100) * state.scale / 2;
    minX = Math.min(minX, s.x - W); maxX = Math.max(maxX, s.x + W);
    minY = Math.min(minY, s.y - H); maxY = Math.max(maxY, s.y + H);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 500; maxY = 400; }
  const pad = 50;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad,
           w: maxX - minX + pad*2, h: maxY - minY + pad*2 };
}

// ============================================================
// RENDER OFFSCREEN per PDF
//
// type:
//   'existing'    → solo elementi 'existing', in grigio scuro (b/n)
//   'project'     → 'existing' in grigio + 'new' in rosso (senza 'demo')
//   'comparative' → tutto con i propri colori (demo=giallo, new=rosso, existing=grigio)
// scale:
//   '100'         → scala fissa 1:100
//   'auto'        → adatta automaticamente al foglio
// ============================================================

function renderFitted(type, canvasW, canvasH) {
  const MARGIN = 30;
  const bb     = getBoundingBox();
  const availW = canvasW - MARGIN * 2;
  const availH = canvasH - MARGIN * 2;
  const fitScale = Math.min(availW / bb.w, availH / bb.h);

  const drawW = bb.w * fitScale;
  const drawH = bb.h * fitScale;
  const offX  = MARGIN + (availW - drawW) / 2;
  const offY  = MARGIN + (availH - drawH) / 2;

  const offscreen = document.createElement('canvas');
  offscreen.width  = canvasW;
  offscreen.height = canvasH;
  const ctx = offscreen.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  const sv = { zoom: state.zoom, offsetX: state.offsetX, offsetY: state.offsetY, ctx: state.ctx };
  state.ctx     = ctx;
  state.zoom    = fitScale;
  state.offsetX = (offX - bb.minX * fitScale) / fitScale;
  state.offsetY = (offY - bb.minY * fitScale) / fitScale;

  ctx.save();
  ctx.scale(fitScale, fitScale);
  ctx.translate(state.offsetX, state.offsetY);

  renderPDFElements(ctx, type);

  ctx.restore();
  Object.assign(state, sv);
  return offscreen;
}

function renderFittedScaled(type, canvasW, canvasH, scale, format) {
  // ── Risoluzione aumentata per PDF nitidi ──
  // PDF_DPI: 3× → ~216 DPI su A4 landscape (senza impattare le dimensioni pt del PDF)
  const PDF_DPI = 3;

  const MARGIN = 30;
  const bb     = getBoundingBox();
  const availW = canvasW - MARGIN * 2;
  const availH = canvasH - MARGIN * 2;

  let fitScale;
  let actualScale;

  if (scale === 'auto') {
    fitScale    = Math.min(availW / bb.w, availH / bb.h);
    actualScale = 'auto';
  } else {
    const targetScale = 100;
    fitScale = targetScale / state.scale;
    const scaledW = bb.w * fitScale;
    const scaledH = bb.h * fitScale;
    if (scaledW > availW || scaledH > availH) {
      fitScale    = Math.min(availW / bb.w, availH / bb.h);
      actualScale = 'auto';
      showToast('⚠ Disegno troppo grande per 1:100, uso adattamento automatico');
    } else {
      actualScale = scale;
    }
  }

  const drawW = bb.w * fitScale;
  const drawH = bb.h * fitScale;
  const offX  = MARGIN + (availW - drawW) / 2;
  const offY  = MARGIN + (availH - drawH) / 2;

  // Canvas fisico ad alta risoluzione
  const physW = Math.round(canvasW * PDF_DPI);
  const physH = Math.round(canvasH * PDF_DPI);

  const offscreen = document.createElement('canvas');
  offscreen.width  = physW;
  offscreen.height = physH;
  const ctx = offscreen.getContext('2d');

  // Scala globale per DPI
  ctx.scale(PDF_DPI, PDF_DPI);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  const sv = { zoom: state.zoom, offsetX: state.offsetX, offsetY: state.offsetY, ctx: state.ctx };
  state.ctx     = ctx;
  state.zoom    = fitScale;
  state.offsetX = (offX - bb.minX * fitScale) / fitScale;
  state.offsetY = (offY - bb.minY * fitScale) / fitScale;

  ctx.save();
  ctx.scale(fitScale, fitScale);
  ctx.translate(state.offsetX, state.offsetY);

  renderPDFElements(ctx, type);

  ctx.restore();
  Object.assign(state, sv);

  offscreen.actualScale = actualScale;
  return offscreen;
}

/**
 * Render degli elementi per PDF con filtri e colori corretti per tipo tavola.
 * Usa drawAllWalls con la lista filtrata per avere raccordi e rendering identico al canvas.
 */
function renderPDFElements(ctx, type) {
  const filterEl = el => {
    const es = el.state || 'existing';
    if (type === 'existing') return es === 'existing' || es === 'demo';
    if (type === 'project')  return es === 'existing' || es === 'new';
    return true; // comparative
  };

  // Pilastri
  state.columns.filter(filterEl).forEach(c => {
    const colors = getPDFColors(c.state || 'existing', type);
    const cw = (c.width / 100) * state.scale;
    const ch = (c.height / 100) * state.scale;
    ctx.fillStyle = colors.fill; ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 1 / state.zoom;
    ctx.fillRect(c.x - cw/2, c.y - ch/2, cw, ch);
    ctx.strokeRect(c.x - cw/2, c.y - ch/2, cw, ch);
    ctx.beginPath();
    ctx.moveTo(c.x - cw/2, c.y - ch/2); ctx.lineTo(c.x + cw/2, c.y + ch/2);
    ctx.moveTo(c.x + cw/2, c.y - ch/2); ctx.lineTo(c.x - cw/2, c.y + ch/2);
    ctx.lineWidth = 0.8 / state.zoom; ctx.stroke();
  });

  // Muri — usa drawAllWalls con lista filtrata e flag PDF per colori corretti
  const filteredWalls = state.walls.filter(filterEl);
  // Sostituisci temporaneamente getColors con getPDFColors
  const _origGetColors = getColors;
  // Patch inline: drawAllWalls chiama getColors(st, false), vogliamo getPDFColors(st, type)
  // Soluzione: passiamo forPDF=type (stringa truthy) e getPDFColors gestisce il tipo
  drawAllWalls(ctx, type, filteredWalls);

  // Serramenti — usa drawOpening con flag forPDF per colori e foro corretti
  state.openings.filter(o => filterEl({ state: o.state })).forEach(o => {
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall || !filterEl(wall)) return;
    drawOpening(o, ctx, type);
  });

  state.texts.forEach(t => drawText(t, ctx));

  // Scale
  (state.stairs || []).filter(filterEl).forEach(s => drawStair(s, ctx, type));
}

// ============================================================
// CARTOUCHE PDF
// ============================================================

function drawCartouche(pdf, pdfW, pdfH, type, pageNum, totalPages, scale) {
  const s     = state.settings;
  const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const M = 20, cH = 54;
  const cY = pdfH - cH - M;
  const cW = pdfW - M * 2;

  pdf.setDrawColor(60, 60, 80); pdf.setLineWidth(0.5);
  pdf.rect(M, cY, cW, cH);

  const c1 = M + cW * 0.42, c2 = M + cW * 0.68;
  pdf.line(c1, cY, c1, cY + cH);
  pdf.line(c2, cY, c2, cY + cH);
  pdf.line(c2, cY + cH / 2, M + cW, cY + cH / 2);

  const pad = 5;
  pdf.setFontSize(10); pdf.setFont(undefined, 'bold'); pdf.setTextColor(20, 20, 50);
  pdf.text(state.projectName, M + pad, cY + 13);
  pdf.setFontSize(8); pdf.setFont(undefined, 'normal'); pdf.setTextColor(80);
  pdf.text(getTypeLabel(type), M + pad, cY + 24);
  
  // Display scale based on actual scale used
  let scaleText;
  if (scale === 'auto') {
    scaleText = 'Scala Auto';
  } else {
    scaleText = `Scala 1:${scale}`;
  }
  pdf.text(scaleText, M + pad, cY + 34);
  
  pdf.setFontSize(7);
  pdf.text(`Tavola ${pageNum} di ${totalPages}`, M + pad, cY + 46);

  pdf.setTextColor(20, 20, 50);
  if (s.profName)    { pdf.setFontSize(9); pdf.setFont(undefined, 'bold'); pdf.text(s.profName, c1 + pad, cY + 13); }
  pdf.setFont(undefined, 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(80);
  if (s.profTitle)   pdf.text(s.profTitle,   c1 + pad, cY + 24);
  if (s.profAddress) pdf.text(s.profAddress, c1 + pad, cY + 34);

  pdf.setFontSize(7.5); pdf.setFont(undefined, 'normal'); pdf.setTextColor(80);
  pdf.text('Data:', c2 + pad, cY + 12);
  pdf.setFontSize(8); pdf.setFont(undefined, 'bold'); pdf.setTextColor(20);
  pdf.text(today, c2 + pad, cY + 22);

  pdf.setFontSize(7); pdf.setFont(undefined, 'normal'); pdf.setTextColor(100);
  pdf.text('Firma / Timbro', c2 + pad, cY + 34);
  pdf.line(c2 + pad, cY + 48, M + cW - pad, cY + 48);

  pdf.setFontSize(6.5); pdf.setTextColor(160);
  pdf.text('PlanSketcher PWA', M + cW - pad, cY + cH - 5, { align: 'right' });
  pdf.setTextColor(0);
}

// ============================================================
// ESPORTAZIONE PDF
// ============================================================

async function exportPDF(type) {
  closeModal('modal-export');
  showToast('Generazione PDF…');
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  const { jsPDF } = window.jspdf;
  
  const format = document.getElementById('export-format').value;
  const scale = document.getElementById('export-scale').value;
  
  if (type === 'all') await exportAll(jsPDF, format, scale);
  else await exportSingle(jsPDF, type, format, scale);
  showToast('PDF esportato! ✓');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function exportSingle(jsPDF, type, format, scale) {
  const pdf  = new jsPDF({ orientation: 'landscape', unit: 'pt', format: format });
  const pdfW = pdf.internal.pageSize.getWidth();
  const pdfH = pdf.internal.pageSize.getHeight();
  const M = 20, HEADER = 38, FOOTER = 80;
  const drawH = pdfH - HEADER - FOOTER;
  const drawW = pdfW - M * 2;

  // Render ad alta risoluzione — le dimensioni pt rimangono drawW×drawH nel PDF
  const offscreen = renderFittedScaled(type, drawW, drawH, scale, format);

  pdf.setFontSize(13); pdf.setFont(undefined, 'bold'); pdf.setTextColor(20, 20, 50);
  pdf.text(state.projectName, M, 22);
  pdf.setFontSize(9); pdf.setFont(undefined, 'normal'); pdf.setTextColor(100);
  const scaleLabel = scale === 'auto' ? 'Auto' : `1:${scale}`;
  pdf.text(`${getTypeLabel(type)} - ${scaleLabel}`, M, 34);
  pdf.setTextColor(0);
  pdf.setDrawColor(200); pdf.setLineWidth(0.3);
  pdf.line(M, HEADER, pdfW - M, HEADER);

  // addImage con dimensioni pt corrette (indipendenti dalla risoluzione fisica del canvas)
  pdf.addImage(offscreen.toDataURL('image/png', 1.0), 'PNG', M, HEADER + 2, drawW, drawH - 4);
  drawCartouche(pdf, pdfW, pdfH, type, 1, 1, scale);
  pdf.save(`${state.projectName.replace(/\s+/g, '_')}_${type}_${format}_${scale === 'auto' ? 'fit' : `1:${scale}`}.pdf`);
}

async function exportAll(jsPDF, format, scale) {
  const types = ['existing', 'comparative', 'project'];
  const pdf   = new jsPDF({ orientation: 'landscape', unit: 'pt', format: format });
  const pdfW  = pdf.internal.pageSize.getWidth();
  const pdfH  = pdf.internal.pageSize.getHeight();
  const M = 20, HEADER = 38, FOOTER = 80;
  const drawH = pdfH - HEADER - FOOTER;
  const drawW = pdfW - M * 2;

  for (let i = 0; i < types.length; i++) {
    if (i > 0) pdf.addPage();
    const type = types[i];
    const offscreen = renderFittedScaled(type, drawW, drawH, scale, format);

    pdf.setFontSize(13); pdf.setFont(undefined, 'bold'); pdf.setTextColor(20, 20, 50);
    pdf.text(state.projectName, M, 22);
    pdf.setFontSize(9); pdf.setFont(undefined, 'normal'); pdf.setTextColor(100);
    const scaleLabel = scale === 'auto' ? 'Auto' : `1:${scale}`;
    pdf.text(`${getTypeLabel(type)} - ${scaleLabel}`, M, 34);
    pdf.setTextColor(0);
    pdf.setDrawColor(200); pdf.setLineWidth(0.3);
    pdf.line(M, HEADER, pdfW - M, HEADER);
    pdf.addImage(offscreen.toDataURL('image/png', 1.0), 'PNG', M, HEADER + 2, drawW, drawH - 4);
    drawCartouche(pdf, pdfW, pdfH, type, i + 1, types.length, scale);
  }
  pdf.save(`${state.projectName.replace(/\s+/g, '_')}_tavola_unica_${format}_${scale === 'auto' ? 'fit' : `1:${scale}`}.pdf`);
}

function getTypeLabel(type) {
  return { existing: 'Stato di Fatto', project: 'Progetto (Nuove Opere)', comparative: 'Comparativa' }[type] || type;
}

// ============================================================
// TOAST / SCREEN
// ============================================================

function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function resizeCanvas() {
  const container = document.getElementById('canvas-container');
  state.canvas.width  = container.clientWidth;
  state.canvas.height = container.clientHeight;
  state.width  = state.canvas.width;
  state.height = state.canvas.height;
  redraw();
}

// ============================================================
// INIT
// ============================================================

async function init() {
  await openDB();
  const canvas  = document.getElementById('main-canvas');
  state.canvas  = canvas;
  state.ctx     = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  setupCanvasEvents();
  setupPropsPanel();
  // Inizializza modulo import PDF (definito in import-pdf.js)
  if (typeof initImportScreen === 'function') initImportScreen();

  // Tool buttons (sia top toolbar che left toolbar)
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTool  = btn.dataset.tool;
      state.isDrawing   = false;
      // Sincronizza propWallThickness se strumento muro
      if (state.activeTool === 'wall') {
        document.getElementById('prop-wall-thickness').value = state.propWallThickness;
      }
      updatePropsPanel();
      redraw();
    });
  });

  // State buttons
  document.querySelectorAll('[data-state]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-state]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeState = btn.dataset.state;
      state.isDrawing   = false;
      state._mouseOverCanvas = false; // reset per evitare hover fantasma
      updatePropsPanel();
      redraw();
      if (state.activeState === 'demo')
        showToast('🟡 Demolizioni: tocca gli elementi per marcarli');
      if (state.activeState === 'new')
        showToast('🔴 Nuove Opere: disegna elementi in rosso');
    });
  });

  // Undo / Redo
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); }
    if (e.key === 'Escape') {
      state.isDrawing = false;
      redraw();
    }
  });

  // Export
  document.getElementById('btn-export').addEventListener('click', () => openModal('modal-export'));
  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => exportPDF(btn.dataset.export));
  });
  document.getElementById('modal-export-cancel').addEventListener('click', () => closeModal('modal-export'));

  // Back
  document.getElementById('btn-back').addEventListener('click', () => {
    saveProject(); showScreen('home-screen'); refreshRecent();
  });

  // Nome progetto
  document.getElementById('project-name-label').addEventListener('input', e => {
    state.projectName = e.target.textContent.trim() || 'Progetto'; saveProject();
  });

  // ---- HOME ----
  document.getElementById('btn-new-project').addEventListener('click', () => openModal('modal-new-project'));
  document.getElementById('btn-load-project').addEventListener('click', showLoadModal);

  // Import da PDF / immagine
  document.getElementById('btn-import-pdf-home').addEventListener('click', () => {
    // Crea un nuovo progetto vuoto
    const name = 'Importazione Planimetria';
    state.projectId   = `proj_${Date.now()}`;
    state.projectName = name;
    state.scale       = 100;
    state.walls = []; state.openings = []; state.columns = []; state.texts = []; state.stairs = [];
    state.history = []; state.historyIndex = -1;
    document.getElementById('project-name-label').textContent = name;
    // Vai alla schermata import e triggera il file picker
    showScreen('import-screen');
    setTimeout(() => {
      const fi = document.getElementById('import-pdf-file');
      if (fi) fi.click();
    }, 300);
  });
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('setting-dark-canvas').checked          = state.settings.darkCanvas;
    document.getElementById('setting-snap').checked            = state.settings.snapAngle;
    document.getElementById('setting-grid').checked            = state.settings.showGrid;
    document.getElementById('setting-wall-snap').checked       = state.settings.wallSnap;
    document.getElementById('setting-default-thickness').value = state.settings.defaultThickness;
    document.getElementById('setting-prof-name').value         = state.settings.profName    || '';
    document.getElementById('setting-prof-title').value        = state.settings.profTitle   || '';
    document.getElementById('setting-prof-address').value      = state.settings.profAddress || '';
    openModal('modal-settings');
  });

  // Modal: Nuovo Progetto
  document.getElementById('modal-new-cancel').addEventListener('click', () => closeModal('modal-new-project'));
  document.getElementById('modal-new-confirm').addEventListener('click', () => {
    const name  = document.getElementById('input-project-name').value || 'Planimetria';
    const scale = parseInt(document.getElementById('input-scale').value) || 100;
    closeModal('modal-new-project');
    state.projectId   = `proj_${Date.now()}`;
    state.projectName = name;
    state.scale       = scale;
    state.walls = []; state.openings = []; state.columns = []; state.texts = []; state.stairs = [];
    state.history = []; state.historyIndex = -1;
    document.getElementById('project-name-label').textContent = name;
    showScreen('canvas-screen');
    resizeCanvas(); pushHistory(); saveProject();
    updatePropsPanel();
    showToast(`Progetto "${name}" creato!`);
  });

  // Modal: Lunghezza Muro
  document.getElementById('modal-length-keep').addEventListener('click', () => { closeModal('modal-wall-length'); confirmWall(null); });
  document.getElementById('modal-length-confirm').addEventListener('click', () => {
    const len = parseFloat(document.getElementById('input-wall-length').value);
    closeModal('modal-wall-length'); confirmWall(len > 0 ? len : null);
  });

  // Modal: Impostazioni
  document.getElementById('modal-settings-close').addEventListener('click', () => {
    state.settings.darkCanvas           = document.getElementById('setting-dark-canvas').checked;
    state.settings.snapAngle        = document.getElementById('setting-snap').checked;
    state.settings.showGrid         = document.getElementById('setting-grid').checked;
    state.settings.wallSnap         = document.getElementById('setting-wall-snap').checked;
    state.settings.defaultThickness = parseInt(document.getElementById('setting-default-thickness').value) || 20;
    state.settings.profName         = document.getElementById('setting-prof-name').value.trim();
    state.settings.profTitle        = document.getElementById('setting-prof-title').value.trim();
    state.settings.profAddress      = document.getElementById('setting-prof-address').value.trim();
    state.propWallThickness         = state.settings.defaultThickness;
    document.getElementById('prop-wall-thickness').value = state.propWallThickness;
    // Apply dark canvas mode
    const container = document.getElementById('canvas-container');
    if (state.settings.darkCanvas) {
      container.classList.add('dark-canvas');
    } else {
      container.classList.remove('dark-canvas');
    }
    closeModal('modal-settings'); redraw();
    showToast('Impostazioni salvate ✓');
  });

  // Modal: Carica
  document.getElementById('modal-load-cancel').addEventListener('click', () => closeModal('modal-load'));

  // Init pannello
  updatePropsPanel();

  await refreshRecent();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.warn);
}

async function showLoadModal() {
  const list     = document.getElementById('load-list');
  const projects = await loadAllProjects();
  list.innerHTML = '';
  if (projects.length === 0) {
    list.innerHTML = '<p class="empty-msg">Nessun progetto salvato.</p>';
  } else {
    projects.sort((a, b) => b.savedAt - a.savedAt).forEach(p => {
      const item = document.createElement('div');
      item.className = 'load-item';
      const date = new Date(p.savedAt).toLocaleDateString('it-IT', { day:'2-digit', month:'short', year:'numeric' });
      item.innerHTML = `<div><div class="recent-name">${p.name}</div><div class="recent-date">${date}</div></div>
        <button class="load-item-del" data-id="${p.id}" title="Elimina">✕</button>`;
      item.addEventListener('click', e => {
        if (e.target.classList.contains('load-item-del')) return;
        loadProjectData(p); closeModal('modal-load');
        showScreen('canvas-screen'); resizeCanvas();
        updatePropsPanel();
        showToast(`"${p.name}" caricato`);
      });
      item.querySelector('.load-item-del').addEventListener('click', async () => {
        if (confirm(`Eliminare "${p.name}"?`)) {
          await deleteProject(p.id); item.remove();
          if (!list.querySelector('.load-item'))
            list.innerHTML = '<p class="empty-msg">Nessun progetto salvato.</p>';
          refreshRecent();
        }
      });
      list.appendChild(item);
    });
  }
  openModal('modal-load');
}

async function refreshRecent() {
  const projects = await loadAllProjects();
  const area     = document.getElementById('recent-projects-area');
  const listEl   = document.getElementById('recent-list');
  listEl.innerHTML = '';
  if (projects.length === 0) { area.style.display = 'none'; return; }
  area.style.display = 'block';
  projects.sort((a, b) => b.savedAt - a.savedAt).slice(0, 3).forEach(p => {
    const item = document.createElement('div');
    item.className = 'recent-item';
    const date = new Date(p.savedAt).toLocaleDateString('it-IT', { day:'2-digit', month:'short' });
    item.innerHTML = `<span class="recent-name">${p.name}</span><span class="recent-date">${date}</span>`;
    item.addEventListener('click', () => {
      loadProjectData(p); showScreen('canvas-screen'); resizeCanvas();
      updatePropsPanel();
      showToast(`"${p.name}" caricato`);
    });
    listEl.appendChild(item);
  });
}

document.addEventListener('DOMContentLoaded', init);
