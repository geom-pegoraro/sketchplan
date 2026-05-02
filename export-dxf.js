/**
 * PlanSketcher – export-dxf.js
 *
 * Esporta il progetto in formato DXF R12/2000 compatibile con AutoCAD e qualsiasi CAD.
 *
 * Layer generati:
 *   MURI        — profili muri (polilinea chiusa, spessore reale)
 *   PORTE       — simbolo architettonico: stipiti + anta + arco 90°
 *   FINESTRE    — simbolo architettonico: stipiti + 3 linee vetro
 *   PILASTRI    — rettangolo + diagonali X
 *   SCALE       — rettangolo + gradini + freccia
 *   TESTI       — testi (MTEXT)
 *   QUOTE       — (opzionale) quote automatiche muri
 *
 * Tutte le entità sono in colore 7 (nero/bianco in AutoCAD).
 * Unità di disegno: MILLIMETRI (standard DXF architettura).
 * La scala PlanSketcher è: state.scale px per METRO → convertiamo in mm.
 */

'use strict';

// ============================================================
// COSTANTI LAYER
// ============================================================

const DXF_LAYERS = {
  MURI:     { name: 'MURI',     color: 7, ltype: 'CONTINUOUS' },
  PORTE:    { name: 'PORTE',    color: 7, ltype: 'CONTINUOUS' },
  FINESTRE: { name: 'FINESTRE', color: 7, ltype: 'CONTINUOUS' },
  PILASTRI: { name: 'PILASTRI', color: 7, ltype: 'CONTINUOUS' },
  SCALE:    { name: 'SCALE',    color: 7, ltype: 'CONTINUOUS' },
  TESTI:    { name: 'TESTI',    color: 7, ltype: 'CONTINUOUS' },
};

// ============================================================
// ENTRY POINT
// ============================================================

function exportDXF() {
  const dxf = buildDXF();
  const blob = new Blob([dxf], { type: 'application/dxf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (state.projectName || 'PlanSketcher') + '.dxf';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  showToast('✓ DXF esportato — apri con AutoCAD');
}

// ============================================================
// BUILD DXF COMPLETO
// ============================================================

function buildDXF() {
  // Fattore di conversione: px-canvas → mm reali
  // state.scale = px per metro → pxToMm = 1000 / state.scale
  const pxToMm = 1000 / state.scale;

  const lines = [];

  // ── HEADER ──
  lines.push(...dxfSection('HEADER', buildHeader()));

  // ── TABLES ──
  lines.push(...dxfSection('TABLES', buildTables()));

  // ── BLOCKS ──
  lines.push(...dxfSection('BLOCKS', buildBlocks()));

  // ── ENTITIES ──
  const entities = [];
  entities.push(...buildWallEntities(pxToMm));
  entities.push(...buildOpeningEntities(pxToMm));
  entities.push(...buildColumnEntities(pxToMm));
  entities.push(...buildStairEntities(pxToMm));
  entities.push(...buildTextEntities(pxToMm));
  lines.push(...dxfSection('ENTITIES', entities));

  // ── EOF ──
  lines.push('0', 'EOF');

  return lines.join('\n');
}

// ============================================================
// SEZIONE HEADER
// ============================================================

function buildHeader() {
  return [
    '9', '$ACADVER', '1', 'AC1015',   // AutoCAD 2000
    '9', '$INSUNITS', '70', '4',       // 4 = millimetri
    '9', '$MEASUREMENT', '70', '1',    // 1 = metrico
    '9', '$LIMMIN', '10', '0.0', '20', '0.0',
    '9', '$LIMMAX', '10', '100000.0', '20', '100000.0',
    '9', '$LUNITS', '70', '2',         // 2 = decimale
    '9', '$LUPREC', '70', '4',
    '9', '$AUNITS', '70', '0',
    '9', '$AUPREC', '70', '4',
  ];
}

// ============================================================
// SEZIONE TABLES
// ============================================================

function buildTables() {
  const out = [];

  // LTYPE table
  out.push('0', 'TABLE', '2', 'LTYPE', '70', '1');
  out.push('0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0');
  out.push('0', 'ENDTAB');

  // LAYER table
  out.push('0', 'TABLE', '2', 'LAYER', '70', String(Object.keys(DXF_LAYERS).length));
  for (const l of Object.values(DXF_LAYERS)) {
    out.push('0', 'LAYER', '2', l.name, '70', '0', '62', String(l.color), '6', l.ltype);
  }
  out.push('0', 'ENDTAB');

  // STYLE table (testi)
  out.push('0', 'TABLE', '2', 'STYLE', '70', '1');
  out.push('0', 'STYLE', '2', 'STANDARD', '70', '0', '40', '0.0', '41', '1.0', '50', '0.0', '71', '0', '42', '2.5', '3', 'arial.ttf', '4', '');
  out.push('0', 'ENDTAB');

  // VPORT table (vista default)
  out.push('0', 'TABLE', '2', 'VPORT', '70', '1');
  out.push('0', 'VPORT', '2', '*ACTIVE', '70', '0',
    '10', '0.0', '20', '0.0', '11', '1.0', '21', '1.0',
    '12', '50000.0', '22', '50000.0', '13', '0.0', '23', '0.0',
    '14', '10.0', '24', '10.0', '15', '10.0', '25', '10.0',
    '16', '0.0', '26', '0.0', '36', '1.0',
    '17', '0.0', '27', '0.0', '37', '0.0',
    '40', '100000.0', '41', '1.0', '42', '50.0', '43', '0.0', '44', '0.0',
    '50', '0.0', '51', '0.0', '71', '0', '72', '1000', '73', '1', '74', '3', '75', '0', '76', '0', '77', '0', '78', '0'
  );
  out.push('0', 'ENDTAB');

  return out;
}

// ============================================================
// SEZIONE BLOCKS (vuota — required)
// ============================================================

function buildBlocks() {
  return [
    '0', 'BLOCK', '8', '0', '2', '*MODEL_SPACE', '70', '0', '10', '0.0', '20', '0.0', '30', '0.0', '3', '*MODEL_SPACE', '1', '',
    '0', 'ENDBLK', '8', '0',
    '0', 'BLOCK', '8', '0', '2', '*PAPER_SPACE', '70', '0', '10', '0.0', '20', '0.0', '30', '0.0', '3', '*PAPER_SPACE', '1', '',
    '0', 'ENDBLK', '8', '0',
  ];
}

// ============================================================
// ENTITÀ MURI
// ============================================================

function buildWallEntities(pxToMm) {
  const out = [];
  const wallList = state.walls;

  for (const w of wallList) {
    const o = getWallOutline(w);
    if (!o) continue;

    // Raccordi alle estremità
    const ms = getMiterAt(w, 'start', wallList);
    const me = getMiterAt(w, 'end',   wallList);

    // I 4 angoli del profilo muro, con raccordi applicati
    const tl = ms ? ms.top : { x: w.start.x + o.nx, y: w.start.y + o.ny };
    const bl = ms ? ms.bot : { x: w.start.x - o.nx, y: w.start.y - o.ny };
    const tr = me ? me.top : { x: w.end.x   + o.nx, y: w.end.y   + o.ny };
    const br = me ? me.bot : { x: w.end.x   - o.nx, y: w.end.y   - o.ny };

    // Fori porte/finestre: taglia il profilo
    const openingsOnWall = state.openings.filter(op => op.wallId === w.id);

    if (openingsOnWall.length === 0) {
      // Polilinea chiusa senza fori
      out.push(...dxfLwPolyline('MURI', [tl, tr, br, bl], true, pxToMm));
    } else {
      // Genera i segmenti del muro escludendo le aperture
      out.push(...buildWallWithOpenings(w, o, tl, tr, br, bl, openingsOnWall, pxToMm));
    }
  }

  return out;
}

/**
 * Genera le linee del muro con i fori per porte/finestre.
 * Disegna le due facce (top e bottom) del muro come linee separate,
 * saltando i tratti dove ci sono aperture.
 */
function buildWallWithOpenings(w, o, tl, tr, br, bl, openings, pxToMm) {
  const out = [];
  const dx  = w.end.x - w.start.x, dy = w.end.y - w.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return out;

  // Ordina aperture per posizione t
  const sorted = [...openings].sort((a, b) => a.t - b.t);

  // Faccia TOP (side +nx) e BOTTOM (side -nx)
  for (const side of ['top', 'bot']) {
    const isTop = side === 'top';
    const startPt = isTop ? tl : bl;
    const endPt   = isTop ? tr : br;
    const snx = isTop ? o.nx : -o.nx;
    const sny = isTop ? o.ny : -o.ny;

    let prevX = startPt.x, prevY = startPt.y;

    for (const op of sorted) {
      const oWidth = (op.width / 100) * state.scale;
      const half   = oWidth / 2 / len;
      const t0 = Math.max(0, op.t - half);
      const t1 = Math.min(1, op.t + half);

      const gapStartX = w.start.x + t0 * dx + snx;
      const gapStartY = w.start.y + t0 * dy + sny;
      const gapEndX   = w.start.x + t1 * dx + snx;
      const gapEndY   = w.start.y + t1 * dy + sny;

      // Linea fino all'inizio del foro
      if (dist2(prevX, prevY, gapStartX, gapStartY) > 0.5) {
        out.push(...dxfLine('MURI', prevX, prevY, gapStartX, gapStartY, pxToMm));
      }
      prevX = gapEndX; prevY = gapEndY;
    }

    // Linea finale
    if (dist2(prevX, prevY, endPt.x, endPt.y) > 0.5) {
      out.push(...dxfLine('MURI', prevX, prevY, endPt.x, endPt.y, pxToMm));
    }
  }

  // Testata start
  out.push(...dxfLine('MURI', tl.x, tl.y, bl.x, bl.y, pxToMm));
  // Testata end
  out.push(...dxfLine('MURI', tr.x, tr.y, br.x, br.y, pxToMm));

  return out;
}

// ============================================================
// ENTITÀ PORTE E FINESTRE
// ============================================================

function buildOpeningEntities(pxToMm) {
  const out = [];

  for (const o of state.openings) {
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;

    const dx  = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) continue;

    const ux   = dx / len, uy = dy / len;
    const thick = (wall.thickness || 20) / 100 * state.scale / 2;
    const nx = -uy * thick, ny = ux * thick;
    const oWidth = (o.width / 100) * state.scale;
    const cx = wall.start.x + o.t * dx;
    const cy = wall.start.y + o.t * dy;
    const hW = oWidth / 2;

    if (o.type === 'door') {
      out.push(...buildDoorDXF(cx, cy, ux, uy, nx, ny, hW, thick, oWidth, o.flip || false, o.rotate || 0, pxToMm));
    } else {
      out.push(...buildWindowDXF(cx, cy, ux, uy, nx, ny, hW, thick, pxToMm));
    }
  }

  return out;
}

function buildDoorDXF(cx, cy, ux, uy, nx, ny, hW, thick, doorWidth, flip, rotate, pxToMm) {
  const out   = [];
  const stipW = Math.min(thick * 0.3, doorWidth * 0.08);

  const P_hingeX = flip ? cx + ux * hW : cx - ux * hW;
  const P_hingeY = flip ? cy + uy * hW : cy - uy * hW;
  const P_latchX = flip ? cx - ux * hW : cx + ux * hW;
  const P_latchY = flip ? cy - uy * hW : cy + uy * hW;

  const wdx = flip ? -ux : ux;
  const wdy = flip ? -uy : uy;

  const snLen  = Math.sqrt(nx * nx + ny * ny) || 1;
  const basendx = nx / snLen, basendy = ny / snLen;
  const sndx   = rotate ? -basendx : basendx;
  const sndy   = rotate ? -basendy : basendy;

  // Stipite cardine (rettangolo)
  const sh1 = [ P_hingeX + nx,              P_hingeY + ny              ];
  const sh2 = [ P_hingeX - nx,              P_hingeY - ny              ];
  const sh3 = [ P_hingeX - nx + wdx*stipW,  P_hingeY - ny + wdy*stipW  ];
  const sh4 = [ P_hingeX + nx + wdx*stipW,  P_hingeY + ny + wdy*stipW  ];
  out.push(...dxfLwPolyline('PORTE', [
    {x:sh1[0],y:sh1[1]},{x:sh2[0],y:sh2[1]},{x:sh3[0],y:sh3[1]},{x:sh4[0],y:sh4[1]}
  ], true, pxToMm));

  // Stipite battuta
  const sl1 = [ P_latchX + nx,              P_latchY + ny              ];
  const sl2 = [ P_latchX - nx,              P_latchY - ny              ];
  const sl3 = [ P_latchX - nx - wdx*stipW,  P_latchY - ny - wdy*stipW  ];
  const sl4 = [ P_latchX + nx - wdx*stipW,  P_latchY + ny - wdy*stipW  ];
  out.push(...dxfLwPolyline('PORTE', [
    {x:sl1[0],y:sl1[1]},{x:sl2[0],y:sl2[1]},{x:sl3[0],y:sl3[1]},{x:sl4[0],y:sl4[1]}
  ], true, pxToMm));

  // Cardine: bordo foro sul lato apertura
  const hingeX = P_hingeX + sndx * thick;
  const hingeY = P_hingeY + sndy * thick;

  // Anta aperta (linea)
  const antaEndX = hingeX + sndx * doorWidth;
  const antaEndY = hingeY + sndy * doorWidth;
  out.push(...dxfLine('PORTE', hingeX, hingeY, antaEndX, antaEndY, pxToMm));

  // Arco 90° (DXF ARC entity)
  const startA = Math.atan2(wdy, wdx);
  const cross  = wdx * sndy - wdy * sndx;
  const endA   = startA + (cross >= 0 ? Math.PI / 2 : -Math.PI / 2);
  // ARC in DXF: angoli in gradi, senso antiorario
  let aDeg1 = startA * 180 / Math.PI;
  let aDeg2 = endA   * 180 / Math.PI;
  if (cross < 0) { [aDeg1, aDeg2] = [aDeg2, aDeg1]; }  // DXF vuole sempre CCW
  out.push(...dxfArc('PORTE', hingeX, hingeY, doorWidth, aDeg1, aDeg2, pxToMm));

  // Cerchietto cardine (piccolo cerchio)
  out.push(...dxfCircle('PORTE', hingeX, hingeY, Math.max(3, thick * 0.1), pxToMm));

  return out;
}

function buildWindowDXF(cx, cy, ux, uy, nx, ny, hW, thick, pxToMm) {
  const out = [];
  const P0x = cx - ux * hW, P0y = cy - uy * hW;
  const P1x = cx + ux * hW, P1y = cy + uy * hW;

  // Stipiti (linee trasversali ai lati del foro)
  out.push(...dxfLine('FINESTRE', P0x + nx, P0y + ny, P0x - nx, P0y - ny, pxToMm));
  out.push(...dxfLine('FINESTRE', P1x + nx, P1y + ny, P1x - nx, P1y - ny, pxToMm));

  // 3 linee vetro parallele (-0.6, 0, +0.6 del semi-spessore)
  for (const f of [-0.6, 0, 0.6]) {
    out.push(...dxfLine('FINESTRE',
      P0x + nx * f, P0y + ny * f,
      P1x + nx * f, P1y + ny * f,
      pxToMm
    ));
  }

  return out;
}

// ============================================================
// PILASTRI
// ============================================================

function buildColumnEntities(pxToMm) {
  const out = [];
  for (const c of (state.columns || [])) {
    const cw = (c.width  / 100) * state.scale;
    const ch = (c.height / 100) * state.scale;
    const x0 = c.x - cw / 2, y0 = c.y - ch / 2;
    const x1 = c.x + cw / 2, y1 = c.y + ch / 2;

    // Rettangolo
    out.push(...dxfLwPolyline('PILASTRI', [
      {x: x0, y: y0}, {x: x1, y: y0}, {x: x1, y: y1}, {x: x0, y: y1}
    ], true, pxToMm));

    // Diagonali X
    out.push(...dxfLine('PILASTRI', x0, y0, x1, y1, pxToMm));
    out.push(...dxfLine('PILASTRI', x1, y0, x0, y1, pxToMm));
  }
  return out;
}

// ============================================================
// SCALE
// ============================================================

function buildStairEntities(pxToMm) {
  const out = [];
  for (const s of (state.stairs || [])) {
    const W     = (s.width  / 100) * state.scale;
    const H     = (s.height / 100) * state.scale;
    const steps = s.steps || 10;
    const angle = s.angle || 0;
    const ox    = s.x, oy = s.y;

    // Funzione di trasformazione locale (rotazione + traslazione)
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const T = (lx, ly) => ({
      x: ox + lx * cos - ly * sin,
      y: oy + lx * sin + ly * cos,
    });

    // Contorno
    out.push(...dxfLwPolyline('SCALE', [
      T(0,0), T(W,0), T(W,H), T(0,H)
    ], true, pxToMm));

    // Gradini
    const stepH = H / steps;
    for (let i = 1; i < steps; i++) {
      const yG = i * stepH;
      const p0 = T(0, yG), p1 = T(W, yG);
      out.push(...dxfLine('SCALE', p0.x, p0.y, p1.x, p1.y, pxToMm));
    }

    // Freccia direzione salita (al centro, lungo y)
    const arrowDir = s.dir === 'down' ? 1 : -1;
    const midX = W / 2, arrLen = Math.min(H * 0.25, W * 0.4);
    const arrY0 = H / 2, arrY1 = arrY0 + arrowDir * arrLen;
    const p0 = T(midX, arrY0), p1 = T(midX, arrY1);
    out.push(...dxfLine('SCALE', p0.x, p0.y, p1.x, p1.y, pxToMm));

    // Punta freccia (due brevi segmenti a 45°)
    const headLen = arrLen * 0.25;
    const h1 = T(midX - headLen * 0.4, arrY1 - arrowDir * headLen * 0.6);
    const h2 = T(midX + headLen * 0.4, arrY1 - arrowDir * headLen * 0.6);
    out.push(...dxfLine('SCALE', p1.x, p1.y, h1.x, h1.y, pxToMm));
    out.push(...dxfLine('SCALE', p1.x, p1.y, h2.x, h2.y, pxToMm));
  }
  return out;
}

// ============================================================
// TESTI
// ============================================================

function buildTextEntities(pxToMm) {
  const out = [];
  for (const t of (state.texts || [])) {
    const sizeMm = (t.size || 14) * pxToMm * 0.75; // px → mm (approssimazione)
    out.push(...dxfMText('TESTI', t.x, t.y, sizeMm, t.label || '', pxToMm));
  }
  return out;
}

// ============================================================
// PRIMITIVI DXF
// ============================================================

/** Converte coordinate canvas (px, Y verso il basso) → DXF (mm, Y verso l'alto) */
function toMm(v, pxToMm) {
  return +(v * pxToMm).toFixed(4);
}

/** Line entity */
function dxfLine(layer, x1, y1, x2, y2, pxToMm) {
  return [
    '0', 'LINE',
    '8', layer,
    '62', '7',
    '10', String(toMm(x1, pxToMm)),
    '20', String(-toMm(y1, pxToMm)),  // DXF Y = -canvas Y (flip asse)
    '30', '0.0',
    '11', String(toMm(x2, pxToMm)),
    '21', String(-toMm(y2, pxToMm)),
    '31', '0.0',
  ];
}

/** LWPolyline (polilinea 2D leggera) entity */
function dxfLwPolyline(layer, pts, closed, pxToMm) {
  const flags = closed ? '1' : '0';
  const out = [
    '0', 'LWPOLYLINE',
    '8', layer,
    '62', '7',
    '90', String(pts.length),
    '70', flags,
    '43', '0.0',
  ];
  for (const p of pts) {
    out.push('10', String(toMm(p.x, pxToMm)));
    out.push('20', String(-toMm(p.y, pxToMm)));
  }
  return out;
}

/** Arc entity — angoli in gradi, CCW (DXF standard) */
function dxfArc(layer, cx, cy, r, startDeg, endDeg, pxToMm) {
  // Flip Y → angoli si specchiano: newAngle = -oldAngle (e quindi CCW diventa CW)
  // Compensiamo invertendo e swappando
  const a1 = ((-endDeg)   % 360 + 360) % 360;
  const a2 = ((-startDeg) % 360 + 360) % 360;
  return [
    '0', 'ARC',
    '8', layer,
    '62', '7',
    '10', String(toMm(cx, pxToMm)),
    '20', String(-toMm(cy, pxToMm)),
    '30', '0.0',
    '40', String(toMm(r, pxToMm)),
    '50', String(+a1.toFixed(6)),
    '51', String(+a2.toFixed(6)),
  ];
}

/** Circle entity */
function dxfCircle(layer, cx, cy, r, pxToMm) {
  return [
    '0', 'CIRCLE',
    '8', layer,
    '62', '7',
    '10', String(toMm(cx, pxToMm)),
    '20', String(-toMm(cy, pxToMm)),
    '30', '0.0',
    '40', String(toMm(r, pxToMm)),
  ];
}

/** MTEXT entity (testo multi-riga) */
function dxfMText(layer, x, y, sizeMm, text, pxToMm) {
  return [
    '0', 'MTEXT',
    '8', layer,
    '62', '7',
    '10', String(toMm(x, pxToMm)),
    '20', String(-toMm(y, pxToMm)),
    '30', '0.0',
    '40', String(+sizeMm.toFixed(4)),
    '71', '1',     // attacco: in alto a sinistra
    '72', '1',     // direzione testo: sinistra→destra
    '1',  text,
    '7',  'STANDARD',
  ];
}

/** Wrap in DXF SECTION */
function dxfSection(name, content) {
  return [
    '0', 'SECTION',
    '2', name,
    ...content,
    '0', 'ENDSEC',
  ];
}

// ============================================================
// UTIL
// ============================================================

function dist2(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}
