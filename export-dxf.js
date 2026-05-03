'use strict';

// ============================================================
// COLORI E LAYER PER STATO
// ============================================================

const DXF_STATE_COLOR = { existing: 7, demo: 2, new: 1 };
function dxfColor(st) { return DXF_STATE_COLOR[st] || 7; }
function dxfLayer(type, st) {
  const s = st === 'demo' ? 'DEMO' : st === 'new' ? 'NUOVO' : 'ESISTENTE';
  return type + '-' + s;
}
function getAllLayers() {
  const types  = ['MURI','PORTE','FINESTRE','PILASTRI'];
  const states = ['existing','demo','new'];
  const layers = [];
  for (const t of types) for (const s of states)
    layers.push({ name: dxfLayer(t,s), color: dxfColor(s), ltype: 'CONTINUOUS' });
  layers.push({ name:'SCALE', color:7, ltype:'CONTINUOUS' });
  layers.push({ name:'TESTI', color:7, ltype:'CONTINUOUS' });
  return layers;
}

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
  const layers = getAllLayers();

  // LTYPE table
  out.push('0', 'TABLE', '2', 'LTYPE', '70', '1');
  out.push('0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0');
  out.push('0', 'ENDTAB');

  // LAYER table
  out.push('0', 'TABLE', '2', 'LAYER', '70', String(layers.length));
  for (const l of layers) {
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
  for (const w of state.walls) {
    const o = getWallOutline(w);
    if (!o) continue;
    const ms = getMiterAt(w, 'start', state.walls);
    const me = getMiterAt(w, 'end',   state.walls);
    const tl = ms ? ms.top : { x: w.start.x + o.nx, y: w.start.y + o.ny };
    const bl = ms ? ms.bot : { x: w.start.x - o.nx, y: w.start.y - o.ny };
    const tr = me ? me.top : { x: w.end.x   + o.nx, y: w.end.y   + o.ny };
    const br = me ? me.bot : { x: w.end.x   - o.nx, y: w.end.y   - o.ny };
    const layer = dxfLayer('MURI', w.state || 'existing');
    const color = dxfColor(w.state || 'existing');
    const openingsOnWall = state.openings.filter(op => op.wallId === w.id);
    if (openingsOnWall.length === 0) {
      out.push(...dxfLwPolyline(layer, color, [tl, tr, br, bl], true, pxToMm));
    } else {
      out.push(...buildWallWithOpenings(w, o, tl, tr, br, bl, openingsOnWall, pxToMm, layer, color));
    }
  }
  return out;
}

/**
 * Genera le linee del muro con i fori per porte/finestre.
 * Disegna le due facce (top e bottom) del muro come linee separate,
 * saltando i tratti dove ci sono aperture.
 */
function buildWallWithOpenings(w, o, tl, tr, br, bl, openings, pxToMm, layer, color) {
  const out = [];
  const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
  const len = Math.sqrt(dx*dx + dy*dy);
  if (len < 1) return out;
  const sorted = [...openings].sort((a,b) => a.t - b.t);
  for (const side of ['top','bot']) {
    const isTop = side === 'top';
    const startPt = isTop ? tl : bl, endPt = isTop ? tr : br;
    const snx = isTop ? o.nx : -o.nx, sny = isTop ? o.ny : -o.ny;
    let prevX = startPt.x, prevY = startPt.y;
    for (const op of sorted) {
      const oWidth = (op.width/100)*state.scale;
      const half   = oWidth/2/len;
      const t0 = Math.max(0, op.t-half), t1 = Math.min(1, op.t+half);
      const gsx = w.start.x+t0*dx+snx, gsy = w.start.y+t0*dy+sny;
      const gex = w.start.x+t1*dx+snx, gey = w.start.y+t1*dy+sny;
      if (dist2(prevX,prevY,gsx,gsy) > 0.5)
        out.push(...dxfLine(layer, color, prevX, prevY, gsx, gsy, pxToMm));
      prevX = gex; prevY = gey;
    }
    if (dist2(prevX,prevY,endPt.x,endPt.y) > 0.5)
      out.push(...dxfLine(layer, color, prevX, prevY, endPt.x, endPt.y, pxToMm));
  }
  out.push(...dxfLine(layer, color, tl.x, tl.y, bl.x, bl.y, pxToMm));
  out.push(...dxfLine(layer, color, tr.x, tr.y, br.x, br.y, pxToMm));
  return out;
}

function buildOpeningEntities(pxToMm) {
  const out = [];
  for (const o of state.openings) {
    const wall = state.walls.find(w => w.id === o.wallId);
    if (!wall) continue;
    const dx = wall.end.x-wall.start.x, dy = wall.end.y-wall.start.y;
    const len = Math.sqrt(dx*dx+dy*dy);
    if (len < 1) continue;
    const ux=dx/len, uy=dy/len;
    const thick = (wall.thickness||20)/100*state.scale/2;
    const nx=-uy*thick, ny=ux*thick;
    const oWidth = (o.width/100)*state.scale;
    const cx=wall.start.x+o.t*dx, cy=wall.start.y+o.t*dy;
    const hW=oWidth/2;
    const oSt=o.state||'existing';
    const col=dxfColor(oSt);
    if (o.type === 'door') {
      out.push(...buildDoorDXF(cx,cy,ux,uy,nx,ny,hW,thick,oWidth,o.flip||false,o.rotate||0,pxToMm,dxfLayer('PORTE',oSt),col));
    } else {
      out.push(...buildWindowDXF(cx,cy,ux,uy,nx,ny,hW,thick,pxToMm,dxfLayer('FINESTRE',oSt),col));
    }
  }
  return out;
}

function buildDoorDXF(cx,cy,ux,uy,nx,ny,hW,thick,doorWidth,flip,rotate,pxToMm,layer,color) {
  layer=layer||'PORTE-ESISTENTE'; color=color!==undefined?color:7;
  const out=[], stipW=Math.min(thick*0.3,doorWidth*0.08);
  const phx=flip?cx+ux*hW:cx-ux*hW, phy=flip?cy+uy*hW:cy-uy*hW;
  const plx=flip?cx-ux*hW:cx+ux*hW, ply=flip?cy-uy*hW:cy+uy*hW;
  const wdx=flip?-ux:ux, wdy=flip?-uy:uy;
  const sn=Math.sqrt(nx*nx+ny*ny)||1;
  const bndx=nx/sn, bndy=ny/sn;
  const sndx=rotate?-bndx:bndx, sndy=rotate?-bndy:bndy;
  out.push(...dxfLwPolyline(layer,color,[
    {x:phx+nx,y:phy+ny},{x:phx-nx,y:phy-ny},
    {x:phx-nx+wdx*stipW,y:phy-ny+wdy*stipW},{x:phx+nx+wdx*stipW,y:phy+ny+wdy*stipW}
  ],true,pxToMm));
  out.push(...dxfLwPolyline(layer,color,[
    {x:plx+nx,y:ply+ny},{x:plx-nx,y:ply-ny},
    {x:plx-nx-wdx*stipW,y:ply-ny-wdy*stipW},{x:plx+nx-wdx*stipW,y:ply+ny-wdy*stipW}
  ],true,pxToMm));
  const hgx=phx+sndx*thick, hgy=phy+sndy*thick;
  out.push(...dxfLine(layer,color,hgx,hgy,hgx+sndx*doorWidth,hgy+sndy*doorWidth,pxToMm));
  const sa=Math.atan2(wdy,wdx), cross=wdx*sndy-wdy*sndx;
  const ea=sa+(cross>=0?Math.PI/2:-Math.PI/2);
  let a1=sa*180/Math.PI, a2=ea*180/Math.PI;
  if(cross<0){[a1,a2]=[a2,a1];}
  out.push(...dxfArc(layer,color,hgx,hgy,doorWidth,a1,a2,pxToMm));
  out.push(...dxfCircle(layer,color,hgx,hgy,Math.max(3,thick*0.1),pxToMm));
  return out;
}

function buildWindowDXF(cx,cy,ux,uy,nx,ny,hW,thick,pxToMm,layer,color) {
  layer=layer||'FINESTRE-ESISTENTE'; color=color!==undefined?color:7;
  const out=[];
  const p0x=cx-ux*hW,p0y=cy-uy*hW,p1x=cx+ux*hW,p1y=cy+uy*hW;
  out.push(...dxfLine(layer,color,p0x+nx,p0y+ny,p0x-nx,p0y-ny,pxToMm));
  out.push(...dxfLine(layer,color,p1x+nx,p1y+ny,p1x-nx,p1y-ny,pxToMm));
  for(const f of[-0.6,0,0.6])
    out.push(...dxfLine(layer,color,p0x+nx*f,p0y+ny*f,p1x+nx*f,p1y+ny*f,pxToMm));
  return out;
}

function buildColumnEntities(pxToMm) {
  const out=[];
  for(const c of(state.columns||[])){
    const layer=dxfLayer('PILASTRI',c.state||'existing');
    const color=dxfColor(c.state||'existing');
    const cw=(c.width/100)*state.scale, ch=(c.height/100)*state.scale;
    const x0=c.x-cw/2,y0=c.y-ch/2,x1=c.x+cw/2,y1=c.y+ch/2;
    out.push(...dxfLwPolyline(layer,color,[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}],true,pxToMm));
    out.push(...dxfLine(layer,color,x0,y0,x1,y1,pxToMm));
    out.push(...dxfLine(layer,color,x1,y0,x0,y1,pxToMm));
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
    out.push(...dxfLwPolyline('SCALE', 7, [
      T(0,0), T(W,0), T(W,H), T(0,H)
    ], true, pxToMm));

    // Gradini
    const stepH = H / steps;
    for (let i = 1; i < steps; i++) {
      const yG = i * stepH;
      const p0 = T(0, yG), p1 = T(W, yG);
      out.push(...dxfLine('SCALE', 7, p0.x, p0.y, p1.x, p1.y, pxToMm));
    }

    // Freccia direzione salita (al centro, lungo y)
    const arrowDir = s.dir === 'down' ? 1 : -1;
    const midX = W / 2, arrLen = Math.min(H * 0.25, W * 0.4);
    const arrY0 = H / 2, arrY1 = arrY0 + arrowDir * arrLen;
    const p0 = T(midX, arrY0), p1 = T(midX, arrY1);
    out.push(...dxfLine('SCALE', 7, p0.x, p0.y, p1.x, p1.y, pxToMm));

    // Punta freccia (due brevi segmenti a 45°)
    const headLen = arrLen * 0.25;
    const h1 = T(midX - headLen * 0.4, arrY1 - arrowDir * headLen * 0.6);
    const h2 = T(midX + headLen * 0.4, arrY1 - arrowDir * headLen * 0.6);
    out.push(...dxfLine('SCALE', 7, p1.x, p1.y, h1.x, h1.y, pxToMm));
    out.push(...dxfLine('SCALE', 7, p1.x, p1.y, h2.x, h2.y, pxToMm));
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
function dxfLine(layer, color, x1, y1, x2, y2, pxToMm) {
  return [
    '0', 'LINE',
    '8', layer,
    '62', String(color),
    '10', String(toMm(x1, pxToMm)),
    '20', String(-toMm(y1, pxToMm)),  // DXF Y = -canvas Y (flip asse)
    '30', '0.0',
    '11', String(toMm(x2, pxToMm)),
    '21', String(-toMm(y2, pxToMm)),
    '31', '0.0',
  ];
}

/** LWPolyline (polilinea 2D leggera) entity */
function dxfLwPolyline(layer, color, pts, closed, pxToMm) {
  const flags = closed ? '1' : '0';
  const out = [
    '0', 'LWPOLYLINE',
    '8', layer,
    '62', String(color),
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
function dxfArc(layer, color, cx, cy, r, startDeg, endDeg, pxToMm) {
  // Flip Y → angoli si specchiano: newAngle = -oldAngle (e quindi CCW diventa CW)
  // Compensiamo invertendo e swappando
  const a1 = ((-endDeg)   % 360 + 360) % 360;
  const a2 = ((-startDeg) % 360 + 360) % 360;
  return [
    '0', 'ARC',
    '8', layer,
    '62', String(color),
    '10', String(toMm(cx, pxToMm)),
    '20', String(-toMm(cy, pxToMm)),
    '30', '0.0',
    '40', String(toMm(r, pxToMm)),
    '50', String(+a1.toFixed(6)),
    '51', String(+a2.toFixed(6)),
  ];
}

/** Circle entity */
function dxfCircle(layer, color, cx, cy, r, pxToMm) {
  return [
    '0', 'CIRCLE',
    '8', layer,
    '62', String(color),
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
