// Draws the bookshelf with three.js. Soft shadows come from averaging many frames, each lit from a
// slightly different position, which is cheap for a still picture and needs no server.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  SHELF_THICK, SHELF_DEPTH, SHELF_END_MARGIN, BASE_Y, SPINE_FONTS, splitLines, hexToRgb, Rng, crc32,
} from './books.js';
import { LIGHTING, WOODS } from './scenes.js';

const LABEL_LIFT = 0.0003;
const MAX_TEXT_M = 0.026;
const INK = { light: '#ece4d0', gold: '#d9b565', dark: '#1f1b18' };
const PROP_NAMES = ['succulent', 'picture_frame', 'vase', 'elephant', 'bust', 'horse', 'cat'];
const FINISHES = { cloth: 0.92, matte: 0.7, gloss: 0.36 };     // surface roughness of each cover finish
const WOOD_REPEAT = 1 / 1.1;                                   // wood texture repeats per metre
const MAX_SPOTS = 4;
const BOOK_REFLECTION = 0.3;
const BOOK_SHINE = 0.4;         // below 1 so the white glare off paper and cloth doesn't grey the covers

const css = ([r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const mix = (a, b, k) => a.map((v, i) => v * (1 - k) + b[i] * k);
const brightness = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

// ---------------------------------------------------------------- geometry buffers
const scratch = new THREE.Vector3();

class Buffers {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.uv = []; this.idx = []; this.count = 0; }

  vertex(matrix, p, n, colour, uv) {
    scratch.set(p[0], p[1], p[2]).applyMatrix4(matrix);
    this.pos.push(scratch.x, scratch.y, scratch.z);
    scratch.set(n[0], n[1], n[2]).transformDirection(matrix);
    this.nor.push(scratch.x, scratch.y, scratch.z);
    if (colour) this.col.push(colour[0], colour[1], colour[2]);
    if (uv) this.uv.push(uv[0], uv[1]);
    return this.count++;
  }

  /** A quad from four corners (counter-clockwise seen from outside). */
  quad(matrix, corners, normal, colour, uvs) {
    const c = this.count;
    for (let i = 0; i < 4; i++) this.vertex(matrix, corners[i], normal, colour, uvs && uvs[i]);
    this.idx.push(c, c + 1, c + 2, c, c + 2, c + 3);
  }

  /** Texture coordinates for a wooden face: the grain follows the given axis (0 = x, 1 = y). */
  static woodUv(corners, axes, grain) {
    const [a, b] = axes;
    const along = a === grain ? a : (b === grain ? b : b);
    const across = along === a ? b : a;
    return corners.map((p) => [p[across] * WOOD_REPEAT + 0.37, p[along] * WOOD_REPEAT]);
  }

  /** An axis-aligned box. wood: {grain} to add wood texture coordinates. chamfer bevels the front edges. */
  box(matrix, x0, x1, y0, y1, z0, z1, colour, wood, chamfer = 0) {
    const c = chamfer;
    const faces = [
      [[[x0, y0 + c, z1], [x1, y0 + c, z1], [x1, y1 - c, z1], [x0, y1 - c, z1]], [0, 0, 1], [0, 1]],
      [[[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], [0, 1]],
      [[[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], [2, 1]],
      [[[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], [2, 1]],
      [[[x0, y1, z1 - c], [x1, y1, z1 - c], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [0, 2]],
      [[[x0, y0, z0], [x1, y0, z0], [x1, y0, z1 - c], [x0, y0, z1 - c]], [0, -1, 0], [0, 2]],
    ];
    if (c) {
      const s = Math.SQRT1_2;
      faces.push([[[x0, y1 - c, z1], [x1, y1 - c, z1], [x1, y1, z1 - c], [x0, y1, z1 - c]], [0, s, s], [0, 1]]);
      faces.push([[[x0, y0, z1 - c], [x1, y0, z1 - c], [x1, y0 + c, z1], [x0, y0 + c, z1]], [0, -s, s], [0, 1]]);
    }
    for (const [corners, normal, axes] of faces) {
      this.quad(matrix, corners, normal, colour, wood ? Buffers.woodUv(corners, axes, wood.grain) : null);
    }
  }

  /** The curved, textured face of a spine. profile: columns across the spine; uv: its place in the atlas. */
  spine(matrix, h, profile, uv) {
    const base = this.count;
    for (const col of profile) {
      const u = uv.u0 + (uv.u1 - uv.u0) * col.u;
      this.vertex(matrix, [col.x, 0, col.z + LABEL_LIFT], [col.nx, 0, col.nz], null, [u, uv.vBottom]);
      this.vertex(matrix, [col.x, h, col.z + LABEL_LIFT], [col.nx, 0, col.nz], null, [u, uv.vTop]);
    }
    for (let k = 0; k < profile.length - 1; k++) {
      const a = base + k * 2;
      this.idx.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }

  /** Closes the top and bottom of a curved spine. */
  spineCaps(matrix, h, profile, colour) {
    for (let k = 0; k < profile.length - 1; k++) {
      const p = profile[k];
      const q = profile[k + 1];
      this.quad(matrix, [[p.x, h, p.z], [q.x, h, q.z], [q.x, h, 0], [p.x, h, 0]], [0, 1, 0], colour);
      this.quad(matrix, [[p.x, 0, 0], [q.x, 0, 0], [q.x, 0, q.z], [p.x, 0, p.z]], [0, -1, 0], colour);
    }
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

/** Cross-section of a spine: hardbacks are rounded, paperbacks flat with soft corners. */
function spineProfile(book) {
  const t = book.t;
  const power = book.hard ? 2.4 : 7;
  const bulge = book.hard ? Math.min(0.0045, t * 0.17) : Math.min(0.0012, t * 0.1);
  const steps = 10;
  const profile = [];
  for (let k = 0; k <= steps; k++) {
    const s = -Math.cos((Math.PI * k) / steps);
    const a = Math.abs(s);
    const slope = (-bulge * power * a ** (power - 1) * Math.sign(s) * 2) / t;
    const len = Math.hypot(slope, 1);
    profile.push({ x: (t * (s + 1)) / 2, z: bulge * (1 - a ** power), nx: -slope / len, nz: 1 / len, u: (s + 1) / 2 });
  }
  return profile;
}

// ---------------------------------------------------------------- spine artwork
const hasSpacing = typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype;

function setFont(ctx, font, size, spaced) {
  ctx.font = `${font.weight} ${size}px ${font.family}`;
  if (hasSpacing) ctx.letterSpacing = spaced ? `${size * 0.07}px` : '0px';
}

/** Choose line breaks, direction and size for a piece of text on a spine region wPx wide and lenPx long. */
function fitText(ctx, text, font, spaced, wPx, lenPx, maxPx, allowAcross) {
  let words = text.split(/\s+/).filter(Boolean);
  if (words.length > 9) words = [...words.slice(0, 8), words.slice(8).join(' ')];
  if (!words.length) return null;
  const measure = (lines) => {
    setFont(ctx, font, 100, spaced);
    return Math.max(...lines.map((l) => ctx.measureText(l).width)) / 100;
  };
  const blockEm = (n) => (n - 1) * 1.08 + 0.74;
  let best = null;
  for (let n = 1; n <= Math.min(3, words.length); n++) {
    const lines = splitLines(words, n);
    const size = Math.min((lenPx * 0.94) / Math.max(measure(lines), 0.01), (wPx * 0.62) / blockEm(n), maxPx);
    if (!best || size > best.size * 1.02) best = { size, lines, vertical: true };
  }
  if (allowAcross && words.length <= 6) {
    for (let n = Math.max(1, words.length - 2); n <= words.length; n++) {
      const lines = splitLines(words, n);
      const size = Math.min((wPx * 0.8) / Math.max(measure(lines), 0.01), (lenPx * 0.9) / blockEm(n), maxPx) * 0.9;
      if (size > best.size) best = { size, lines, vertical: false };
    }
  }
  return best;
}

function drawLines(ctx, fit, font, spaced, cx, cy) {
  ctx.save();
  setFont(ctx, font, fit.size, spaced);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.translate(cx, cy);
  if (fit.vertical) ctx.rotate(Math.PI / 2);        // reads from the top of the spine downwards
  const lineH = fit.size * 1.08;
  fit.lines.forEach((line, i) => {
    ctx.fillText(line, 0, (i - (fit.lines.length - 1) / 2) * lineH + fit.size * 0.35);
  });
  ctx.restore();
}

let grainCanvas = null;
function grain(ctx) {
  if (!grainCanvas) {
    grainCanvas = document.createElement('canvas');
    grainCanvas.width = grainCanvas.height = 128;
    const g = grainCanvas.getContext('2d');
    const img = g.createImageData(128, 128);
    const rng = new Rng(7);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rng.random() < 0.5 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.floor(rng.random() * 40);
    }
    g.putImageData(img, 0, 0);
  }
  return ctx.createPattern(grainCanvas, 'repeat');
}

function drawEmblem(ctx, kind, cx, cy, e) {
  ctx.lineWidth = Math.max(1, e * 0.16);
  ctx.beginPath();
  if (kind === 0) { ctx.arc(cx, cy, e * 0.5, 0, Math.PI * 2); ctx.stroke(); }
  else if (kind === 1) {
    ctx.moveTo(cx, cy - e * 0.6); ctx.lineTo(cx + e * 0.45, cy); ctx.lineTo(cx, cy + e * 0.6); ctx.lineTo(cx - e * 0.45, cy);
    ctx.closePath(); ctx.fill();
  } else if (kind === 2) {
    for (const dy of [-0.4, 0, 0.4]) ctx.fillRect(cx - e * 0.5, cy + dy * e - e * 0.08, e, e * 0.16);
  } else {
    ctx.arc(cx, cy, e * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, e * 0.2, 0, Math.PI * 2); ctx.fill();
  }
}

function drawStar(ctx, cx, cy, radius, filled = true) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? radius * 0.45 : radius;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath();
  if (filled) ctx.fill();
  else { ctx.lineWidth = Math.max(1, radius * 0.14); ctx.stroke(); }
}

/** The card in a shelf's label holder: five stars with the rating filled in, or "Not rated". */
function ratingPlateCanvas(stars) {
  const canvas = document.createElement('canvas');
  canvas.width = 440;
  canvas.height = 120;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#efe8d6';
  ctx.fillRect(0, 0, 440, 120);
  ctx.fillStyle = ctx.strokeStyle = '#2a221c';
  if (stars > 0) {
    for (let i = 0; i < 5; i++) drawStar(ctx, 60 + i * 80, 60, 32, i < stars);
  } else {
    ctx.font = '600 50px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Not rated', 220, 64);
  }
  return canvas;
}

/** The key shown under the shelves when cover colour stands for the rating. entries: [{stars, color}]. */
function ratingKeyCanvas(entries) {
  const cell = 330;
  const canvas = document.createElement('canvas');
  canvas.width = cell * entries.length + 40;
  canvas.height = 120;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f1ecdf';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  entries.forEach((entry, i) => {
    const x = 30 + i * cell;
    ctx.fillStyle = css(entry.color);
    ctx.fillRect(x, 26, 52, 68);                       // a little book spine in that colour
    ctx.fillStyle = ctx.strokeStyle = '#2a221c';
    if (entry.stars > 0) {
      for (let k = 0; k < 5; k++) drawStar(ctx, x + 92 + k * 44, 60, 19, k < entry.stars);
    } else {
      ctx.font = '600 38px Georgia, "Times New Roman", serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('Not rated', x + 72, 62);
    }
  });
  return canvas;
}

/** Paint one spine: cover colour, wear, bands, title, author, publisher's emblem and, if asked, stars. */
function drawLabel(ctx, x, y, w, h, book, density, show, flat) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 1, y - 1, w + 2, h + 2);
  ctx.clip();
  ctx.fillStyle = css(book.color);
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);

  // Wear: rubbed top and bottom edges, reading creases on paperbacks, and a little surface grain.
  const rub = 0.04 + 0.1 * book.wear;
  for (const [from, to] of [[y, y + h * 0.04], [y + h, y + h * 0.96]]) {
    const g = ctx.createLinearGradient(0, from, 0, to);
    g.addColorStop(0, `rgba(255,255,255,${rub})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, Math.min(from, to), w, Math.abs(to - from));
  }
  const rng = new Rng(crc32(book.fullTitle) + 5);
  for (let i = 0; i < book.creases; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.06 + 0.1 * rng.random()})`;
    ctx.fillRect(x + w * rng.uniform(0.18, 0.82), y + h * rng.uniform(0, 0.12),
      Math.max(1, density * 0.0004), h * rng.uniform(0.7, 1));
  }
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = grain(ctx);
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;

  let ink = INK[book.ink];
  ctx.fillStyle = ink;
  if (book.bands) {
    const bx = x + w * 0.08;
    const bw = w * 0.84;
    for (const [at, thick] of [[0.055, 0.0022], [0.075, 0.001], [0.945, 0.0022], [0.925, 0.001]]) {
      const t = Math.max(thick * density, 1);
      ctx.fillRect(bx, y + h * at - t / 2, bw, t);
    }
  }

  // Regions down the spine, as fractions of its height.
  const top = book.bands ? 0.1 : 0.06;
  let bottom = book.bands ? 0.9 : 0.94;
  const font = SPINE_FONTS[book.font];
  const maxPx = MAX_TEXT_M * density;
  // The reader's star rating at the foot of the spine: a row on thick books, a column on thin ones.
  const stars = show.stars && w >= 8 ? book.stars : 0;
  if (stars) {
    const largest = 0.012 * density;
    const inRow = (w * 0.9) / 5.4 >= 0.0075 * density;
    const e = inRow ? Math.min((w * 0.9) / 5.4, largest) : Math.min(w * 0.56, largest);
    ctx.fillStyle = book.ink === 'dark' ? INK.dark : INK.gold;
    for (let i = 0; i < stars; i++) {
      if (inRow) drawStar(ctx, x + w / 2 + (i - (stars - 1) / 2) * e * 1.08, y + h * bottom - e * 0.55, e / 2);
      else drawStar(ctx, x + w / 2, y + h * bottom - e * 0.55 - i * e * 1.1, e / 2);
    }
    bottom -= ((inRow ? 1.2 : stars * 1.1) * e) / h + 0.012;
    ctx.fillStyle = ink;
  }
  const withAuthor = show.authors && book.surname && w >= 9;
  if (withAuthor && !stars) {
    const e = Math.min(w * 0.34, 0.011 * density);
    drawEmblem(ctx, book.mark, x + w / 2, y + h * (bottom - 0.022), e);
    bottom -= 0.06;
  }
  const authorLen = withAuthor ? 0.2 : 0;
  const titleEnd = withAuthor ? bottom - authorLen - 0.035 : bottom;

  if (show.titles && book.title) {
    if (book.patch) {
      // A contrasting title label, as on old cloth and leather bindings.
      const dark = brightness(book.color) > 0.3;
      ctx.fillStyle = css(dark ? mix(book.color, [0, 0, 0], 0.72) : mix(book.color, [0.05, 0.02, 0.02], 0.6));
      const py = y + h * (top + 0.01);
      const ph = h * (titleEnd - top - 0.02);
      ctx.fillRect(x + w * 0.06, py, w * 0.88, ph);
      ink = INK.gold;
      ctx.fillStyle = ink;
      const rule = Math.max(1, density * 0.0007);
      ctx.fillRect(x + w * 0.06, py + rule * 2, w * 0.88, rule);
      ctx.fillRect(x + w * 0.06, py + ph - rule * 3, w * 0.88, rule);
    }
    const pad = book.patch ? 0.03 : 0;
    const len = h * (titleEnd - top - pad * 2);
    const text = book.caps ? book.title.toUpperCase() : book.title;
    const fit = fitText(ctx, text, font, book.caps, w, len, maxPx, !flat);
    if (fit && fit.size >= 2) {
      ctx.fillStyle = ink;
      drawLines(ctx, fit, font, book.caps, x + w / 2, y + h * (top + titleEnd) / 2);
      if (withAuthor) {
        // Authors are usually set smaller, and in capitals when the title is not.
        const name = book.caps ? book.surname : book.surname.toUpperCase();
        const spaced = !book.caps;
        const aLen = h * authorLen;
        const aFit = fitText(ctx, name, font, spaced, w, aLen, fit.size * 0.66, false);
        setFont(ctx, font, 100, spaced);
        const across = Math.min(fit.size * 0.7, (w * 0.8) / Math.max(ctx.measureText(name).width / 100, 0.01));
        const cy = y + h * (bottom - authorLen / 2);
        ctx.fillStyle = INK[book.ink];
        if (!flat && !fit.vertical && across >= 0.0038 * density) {
          drawLines(ctx, { size: across, lines: [name], vertical: false }, font, spaced, x + w / 2, cy);
        } else if (aFit && aFit.size >= 4) drawLines(ctx, aFit, font, spaced, x + w / 2, cy);
      }
    }
  }
  if (hasSpacing) ctx.letterSpacing = '0px';
  ctx.restore();
}

/** Pack every spine label into as few large textures as possible. */
function buildLabelAtlases(items, maxSize, show) {
  const area = items.reduce((s, it) => s + (it.book.t + 0.004) * (it.book.h + 0.004), 0);
  const pagesAllowed = 3;
  let density = Math.min(2200, Math.sqrt((0.8 * pagesAllowed * maxSize * maxSize) / Math.max(area, 1e-6)));
  const pad = 3;
  let placed;
  for (;;) {
    placed = [];
    let page = 0;
    let x = pad;
    let y = pad;
    let rowH = 0;
    const order = items.map((it, i) => i).sort((a, b) => items[b].book.h - items[a].book.h);
    for (const i of order) {
      const w = Math.max(4, Math.round(items[i].book.t * density));
      const h = Math.max(4, Math.round(items[i].book.h * density));
      if (x + w + pad > maxSize) { x = pad; y += rowH + pad; rowH = 0; }
      if (y + h + pad > maxSize) { page++; x = pad; y = pad; rowH = 0; }
      placed[i] = { page, x, y, w, h };
      x += w + pad;
      rowH = Math.max(rowH, h);
    }
    if (page < pagesAllowed || density < 400) break;
    density *= 0.9;
  }
  const pageCount = Math.max(...placed.map((p) => p.page)) + 1;
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const used = placed.filter((r) => r.page === p);
    const canvas = document.createElement('canvas');
    canvas.width = maxSize;
    canvas.height = Math.min(maxSize, Math.max(...used.map((r) => r.y + r.h)) + pad);
    pages.push({ canvas, ctx: canvas.getContext('2d') });
  }
  items.forEach((it, i) => {
    const r = placed[i];
    const { canvas, ctx } = pages[r.page];
    drawLabel(ctx, r.x, r.y, r.w, r.h, it.book, density, show, it.flat);
    it.page = r.page;
    it.uv = { u0: r.x / canvas.width, u1: (r.x + r.w) / canvas.width,
      vTop: 1 - r.y / canvas.height, vBottom: 1 - (r.y + r.h) / canvas.height };
  });
  return pages.map((p) => p.canvas);
}

// ---------------------------------------------------------------- walls
function damaskMotif(ctx, cx, cy, s) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.beginPath();                                   // central bud
  ctx.moveTo(0, -0.5);
  ctx.bezierCurveTo(0.2, -0.25, 0.16, 0.02, 0, 0.1);
  ctx.bezierCurveTo(-0.16, 0.02, -0.2, -0.25, 0, -0.5);
  ctx.fill();
  for (const m of [1, -1]) {                         // leaves, mirrored left and right
    ctx.beginPath();
    ctx.moveTo(0.05 * m, 0.12);
    ctx.bezierCurveTo(0.3 * m, 0.1, 0.42 * m, -0.12, 0.34 * m, -0.3);
    ctx.bezierCurveTo(0.3 * m, -0.1, 0.18 * m, 0, 0.05 * m, 0.12);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0.04 * m, 0.2);
    ctx.bezierCurveTo(0.22 * m, 0.24, 0.4 * m, 0.4, 0.3 * m, 0.56);
    ctx.bezierCurveTo(0.26 * m, 0.42, 0.16 * m, 0.32, 0.04 * m, 0.2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0.37 * m, 0.08, 0.035, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();                                   // drop below
  ctx.moveTo(0, 0.18);
  ctx.bezierCurveTo(0.09, 0.3, 0.07, 0.44, 0, 0.62);
  ctx.bezierCurveTo(-0.07, 0.44, -0.09, 0.3, 0, 0.18);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, -0.62, 0.04, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Each wall covering: tile size in metres and pixels, and a function that paints its pattern. */
const WALL_TILES = {
  diamond: {
    size: [0.11, 0.165], px: [256, 384],
    pattern: () => ({ colour: [0.68, 0.54, 0.34], roughness: 0.4, metalness: 0.6 }),
    paint(ctx, W, H) {
      ctx.lineWidth = W * 0.016;
      ctx.beginPath();
      for (const [a, b, c, d] of [[0, 0.5, 0.5, 0], [0.5, 1, 1, 0.5], [0, 0.5, 0.5, 1], [0.5, 0, 1, 0.5]]) {
        ctx.moveTo(a * W, b * H);
        ctx.lineTo(c * W, d * H);
      }
      ctx.stroke();
      for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
        ctx.beginPath();
        ctx.moveTo(cx * W, cy * H - H * 0.08);
        ctx.lineTo(cx * W + W * 0.08, cy * H);
        ctx.lineTo(cx * W, cy * H + H * 0.08);
        ctx.lineTo(cx * W - W * 0.08, cy * H);
        ctx.closePath();
        ctx.fill();
      }
    },
  },
  damask: {
    size: [0.27, 0.405], px: [416, 624],
    // Tone on tone: the pattern is the wall colour, a little lighter and shinier.
    pattern: (wall) => ({ colour: brightness(wall) > 0.45 ? mix(wall, [0, 0, 0], 0.1) : mix(wall, [1, 1, 1], 0.11),
      roughness: 0.42, metalness: 0.12 }),
    paint(ctx, W, H) {
      ctx.lineWidth = W * 0.016;
      for (const sx of [1, -1]) {
        for (const sy of [1, -1]) {
          ctx.save();
          ctx.translate(W / 2, H / 2);
          ctx.scale(sx, sy);
          ctx.beginPath();
          ctx.moveTo(-W / 2, 0);
          ctx.bezierCurveTo(-W * 0.18, -H * 0.1, -W * 0.32, -H * 0.38, 0, -H / 2);
          ctx.stroke();
          ctx.restore();
        }
      }
      for (const [cx, cy] of [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]]) damaskMotif(ctx, cx * W, cy * H, W * 0.4);
    },
  },
  stripe: {
    size: [0.15, 0.15], px: [240, 240],
    pattern: (wall) => ({ colour: mix(wall, [1, 1, 1], brightness(wall) > 0.45 ? -0.08 : 0.07),
      roughness: 0.55, metalness: 0 }),
    paint(ctx, W, H) {
      ctx.fillRect(0, 0, W / 2, H);
      ctx.fillRect(W * 0.72, 0, W * 0.035, H);
    },
  },
  plain: { size: [0.6, 0.6], px: [64, 64], pattern: null, paint() {} },
};

function wallTextures(type, wall) {
  const tile = WALL_TILES[type] || WALL_TILES.plain;
  const [W, H] = tile.px;
  const make = (base, ink) => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ctx.strokeStyle = ink;
    tile.paint(ctx, W, H);
    return canvas;
  };
  const pat = tile.pattern ? tile.pattern(wall) : { colour: wall, roughness: 0.86, metalness: 0 };
  // Second canvas: green carries roughness and blue carries metalness, as three.js expects.
  const surface = (roughness, metalness) => css([0, roughness, metalness]);
  return {
    colour: make(css(wall), css(pat.colour.map((c) => Math.min(Math.max(c, 0), 1)))),
    surface: make(surface(0.86, 0), surface(pat.roughness, pat.metalness)),
    size: tile.size,
  };
}

/** A fine bumpy texture shared by every wall, so paint and paper don't look perfectly flat. */
function bumpTexture() {
  const n = 256;
  const rng = new Rng(11);
  const raw = new Float32Array(n * n).map(() => rng.random());
  const at = (x, y) => raw[((y + n) % n) * n + ((x + n) % n)];
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += at(x + dx, y + dy);
      height[y * n + x] = sum / 9;
    }
  }
  const h = (x, y) => height[((y + n) % n) * n + ((x + n) % n)];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 2;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 2;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * n + x) * 4;
      img.data[o] = 127.5 * (1 - dx / len);
      img.data[o + 1] = 127.5 * (1 - dy / len);
      img.data[o + 2] = 127.5 * (1 + 1 / len);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** The pattern of light a window throws: bright panes on black. */
function windowGobo() {
  const n = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = '#fff';
  const [x0, x1, y0, y1] = [0.2, 0.8, 0.12, 0.88];
  const cols = 3;
  const rows = 4;
  const bar = 0.02;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const px = x0 + ((x1 - x0) * c) / cols + bar / 2;
      const py = y0 + ((y1 - y0) * r) / rows + bar / 2;
      ctx.fillRect(px * n, py * n, ((x1 - x0) / cols - bar) * n, ((y1 - y0) / rows - bar) * n);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

// ---------------------------------------------------------------- the view
export class BookshelfView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.9;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.maxTexture = Math.min(r.capabilities.maxTextureSize, 4096);
    this.canAccumulate = r.capabilities.isWebGL2
      && (r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float'));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 50);
    this.content = new THREE.Group();
    this.scene.add(this.content);

    // A plain room to reflect in glossy covers, varnish and glazed pottery.
    try {
      const pmrem = new THREE.PMREMGenerator(r);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    } catch {
      this.scene.environment = null;
    }

    const big = r.capabilities.maxTextureSize >= 8192;
    this.spots = [];
    for (let i = 0; i < MAX_SPOTS; i++) {
      const light = new THREE.SpotLight(0xffffff, 0);
      light.decay = 0;                        // brightness is set per scene, not by distance
      light.castShadow = true;
      light.shadow.mapSize.set(big ? 2048 : 1024, big ? 2048 : 1024);
      light.shadow.bias = -0.0006;
      light.shadow.normalBias = 0.004;
      light.visible = false;
      this.scene.add(light, light.target);
      this.spots.push(light);
    }
    this.sky = new THREE.DirectionalLight(0xffffff, 1);
    this.sky.castShadow = true;
    this.sky.shadow.mapSize.set(big ? 4096 : 2048, big ? 4096 : 2048);
    this.sky.shadow.bias = -0.0004;
    this.sky.shadow.normalBias = 0.003;
    this.scene.add(this.sky, this.sky.target);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.1);
    this.scene.add(this.ambient);
    this.gobos = { window: windowGobo() };
    this.bump = bumpTexture();

    // Full-screen passes: average frames together, then tone-map to the screen.
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const vertexShader = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    this.blend = new THREE.ShaderMaterial({
      uniforms: { tex: { value: null }, weight: { value: 1 } },
      vertexShader,
      fragmentShader: 'uniform sampler2D tex; uniform float weight; varying vec2 vUv;'
        + 'void main(){ gl_FragColor = vec4(texture2D(tex, vUv).rgb, weight); }',
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.present = new THREE.ShaderMaterial({
      uniforms: { tex: { value: null }, vignette: { value: 0.2 }, exposure: { value: 1 } },
      vertexShader,
      fragmentShader: [
        'uniform sampler2D tex; uniform float vignette; uniform float exposure; varying vec2 vUv;',
        'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
        'void main(){',
        '  vec3 c = texture2D(tex, vUv).rgb * exposure;',
        '  vec2 q = vUv - 0.5;',
        '  c *= 1.0 - vignette * smoothstep(0.12, 1.0, dot(q, q) * 2.0);',   // darker towards the corners
        // Brightness is shown as it is up to a point, then eased towards white. Easing red, green and
        // blue separately (the usual film-style curve) drains colour from anything brightly lit; working
        // on brightness alone keeps every cover its own colour.
        '  float lum = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4);',
        '  float knee = 0.55;',
        '  float mapped = lum < knee ? lum : knee + (1.0 - knee) * tanh((lum - knee) / (1.0 - knee));',
        '  c *= mapped / lum;',
        '  float peak = max(c.r, max(c.g, c.b));',
        '  if (peak > 1.0) c = mapped + (c - mapped) * ((1.0 - mapped) / max(peak - mapped, 1e-4));',
        '  gl_FragColor = vec4(c, 1.0);',
        '  #include <colorspace_fragment>',
        '  gl_FragColor.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;',      // hides banding in soft gradients
        '}',
      ].join('\n'),
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blend);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);

    this.textures = new THREE.TextureLoader();
    this.wood = null;
    this.props = new Map();
    this.frame = 0;
    this.previewFrames = 72;
    this.busy = false;
    this.aspect = 16 / 9;
    this.geom = null;
    this.spotSpecs = [];
    this.width = 0;
    this.height = 0;

    const tick = () => {
      if (!this.busy && this.width && this.geom && this.frame < this.previewFrames) this.renderSample();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Load the wood texture and the decorations. The page works without them if they fail. */
  async loadAssets(base = 'assets/') {
    const loadTexture = (url, colour) => new Promise((resolve) => {
      this.textures.load(url, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        if (colour) t.colorSpace = THREE.SRGBColorSpace;
        resolve(t);
      }, undefined, () => resolve(null));
    });
    const loader = new GLTFLoader();
    const loadProp = (name) => new Promise((resolve) => {
      loader.load(`${base}props/${name}.glb`, (gltf) => {
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.receiveShadow = true;
          // Glass arrives opaque from the exporter and would hide the picture behind it.
          if (/glass/i.test(o.material.name)) o.visible = false;
        });
        const box = new THREE.Box3().setFromObject(gltf.scene);
        this.props.set(name, {
          object: gltf.scene,
          w: 2 * Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
          d: 2 * Math.max(Math.abs(box.min.z), Math.abs(box.max.z)),
          h: box.max.y,
        });
        resolve();
      }, undefined, () => resolve());
    });
    const [diff, nor] = await Promise.all([
      loadTexture(`${base}wood_diff.jpg`, true), loadTexture(`${base}wood_nor.jpg`, false),
      ...PROP_NAMES.map(loadProp),
    ]);
    this.wood = { diff, nor, average: [0.45, 0.27, 0.12] };
    if (diff) {
      // Average colour of the grain, so it can be pulled towards any chosen finish.
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const ctx = c.getContext('2d');
      ctx.drawImage(diff.image, 0, 0, 8, 8);
      const data = ctx.getImageData(0, 0, 8, 8).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += toLinear(data[i + k] / 255);
      this.wood.average = sum.map((s) => s / 64);
    }
  }

  propList() {
    return [...this.props.entries()].map(([name, p]) => ({ name, w: p.w, d: p.d, h: p.h }));
  }

  /** A wood material pulled towards the given sRGB colour; paint (no grain) when grain is false. */
  woodMaterial(rgb, grain, roughness) {
    const target = rgb.map(toLinear);
    const material = new THREE.MeshStandardMaterial({ roughness });
    if (grain && this.wood && this.wood.diff) {
      material.map = this.wood.diff;
      material.normalMap = this.wood.nor;
      material.normalScale.set(0.5, 0.5);
      material.color.setRGB(...target.map((c, i) => Math.min(c / this.wood.average[i], 3)));
    } else material.color.setRGB(...target);
    return material;
  }

  disposeContent() {
    this.content.traverse((o) => {
      if (!o.isMesh || o.userData.shared) return;
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        for (const key of ['map', 'roughnessMap', 'metalnessMap']) {
          if (m[key] && m[key].userData.owned) m[key].dispose();
        }
        m.dispose();
      }
    });
    this.content.clear();
  }

  /**
   * Rebuild everything from a layout plan.
   * opts: {style, titles, authors, wallType, wall:[r,g,b] sRGB, wood, lighting, aspect,
   *        ratings: 'off'|'stars'|'colour'|'shelves', legend: [{stars, color}] for the colour key}
   */
  build(plan, opts) {
    this.disposeContent();
    const { rows, shelfW, pitch, clearH } = plan;
    const boardW = shelfW + 2 * SHELF_END_MARGIN;
    const x0 = -shelfW / 2;
    const rowY = [...Array(rows).keys()].map((r) => BASE_Y + (rows - 1 - r) * pitch);
    const topY = rowY[0] + clearH;
    const bottomY = rowY[rows - 1] - SHELF_THICK;
    const identity = new THREE.Matrix4();
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const add = (mesh, cast = true) => {
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      this.content.add(mesh);
      return mesh;
    };

    // Shelves
    const bookcase = opts.style === 'bookcase';
    const side = bookcase ? 0.025 : 0;
    const boards = new Buffers();
    const along = { grain: 0 };
    const upright = { grain: 1 };
    for (const y of rowY) {
      boards.box(identity, -boardW / 2, boardW / 2, y - SHELF_THICK, y, 0, SHELF_DEPTH, null, along, 0.0025);
    }
    if (bookcase) {
      boards.box(identity, -boardW / 2 - side, -boardW / 2, bottomY, topY + side, 0, SHELF_DEPTH, null, upright);
      boards.box(identity, boardW / 2, boardW / 2 + side, bottomY, topY + side, 0, SHELF_DEPTH, null, upright);
      boards.box(identity, -boardW / 2, boardW / 2, topY, topY + side, 0, SHELF_DEPTH, null, along, 0.0025);
      boards.box(identity, -boardW / 2, boardW / 2, bottomY, topY, 0, 0.006, null, upright);
    }
    const finish = WOODS[opts.wood] || WOODS.honey;
    add(new THREE.Mesh(boards.toGeometry(),
      this.woodMaterial(hexToRgb(finish.tint.slice(1)), finish.grain, finish.roughness)));

    // Books: one mesh per cover finish, plus the page blocks
    const bookItems = plan.placements.filter((p) => p.kind !== 'prop');
    const solids = { cloth: new Buffers(), matte: new Buffers(), gloss: new Buffers(), pages: new Buffers() };
    const zSpine = (book) => SHELF_DEPTH - 0.014 - book.push;
    const m = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    for (const place of bookItems) {
      const book = place.book;
      const y = rowY[place.row];
      const matrix = new THREE.Matrix4();
      if (place.kind === 'up') {
        // Nearly, but not perfectly, square to the shelf.
        matrix.makeTranslation(x0 + place.x + book.t / 2, y, zSpine(book))
          .multiply(m.makeRotationY(book.yaw)).multiply(tmp.makeRotationZ(book.roll))
          .multiply(m.makeTranslation(-book.t / 2, 0, 0));
      } else if (place.kind === 'lean') {
        matrix.makeTranslation(x0 + place.pivot, y, zSpine(book)).multiply(m.makeRotationZ(-place.angle));
        if (place.angle > 0) matrix.multiply(tmp.makeTranslation(-book.t, 0, 0));
      } else {
        matrix.makeTranslation(x0 + place.cx, y + place.lift, SHELF_DEPTH - 0.016 - book.d / 2)
          .multiply(m.makeRotationY(place.rot))
          .multiply(tmp.makeTranslation(book.h / 2, 0, book.d / 2))
          .multiply(m.makeRotationZ(Math.PI / 2));
      }
      place.matrix = matrix;
      place.profile = spineProfile(book);
      const { t, d, h } = book;
      const cover = Math.min(book.hard ? 0.0025 : 0.0009, t * 0.2);
      const inset = book.hard ? 0.003 : 0.0003;
      const colour = book.color.map(toLinear);
      const solid = solids[book.finish] || solids.matte;
      solid.box(matrix, 0, cover, 0, h, -d, 0, colour);
      solid.box(matrix, t - cover, t, 0, h, -d, 0, colour);
      solid.box(matrix, cover, t - cover, 0, h, -cover, 0, colour);
      solid.spineCaps(matrix, h, place.profile, colour);
      const p = book.paper;
      solids.pages.box(matrix, cover + 0.0001, t - cover - 0.0001, inset, h - inset,
        -d + Math.max(inset, 0.0006), -cover, [p, p * 0.9, p * 0.7]);
    }
    for (const [name, buf] of Object.entries(solids)) {
      if (!buf.count) continue;
      const material = new THREE.MeshPhysicalMaterial({
        vertexColors: true, roughness: FINISHES[name] || 0.9, specularIntensity: BOOK_SHINE,
      });
      material.userData.book = true;
      add(new THREE.Mesh(buf.toGeometry(), material));
    }

    this.debugPlacements = bookItems;       // lets tests check how each book ended up on screen

    // Spines: artwork drawn on shared textures and wrapped over the curved spine
    const labelItems = bookItems.map((p) => ({ book: p.book, flat: p.kind === 'flat', matrix: p.matrix, profile: p.profile }));
    if (labelItems.length) {
      const canvases = buildLabelAtlases(labelItems, this.maxTexture,
        { titles: opts.titles, authors: opts.authors, stars: opts.ratings === 'stars' });
      this.debugLabels = { canvases, items: labelItems };      // for tests, like debugPlacements
      canvases.forEach((canvas, page) => {
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = anisotropy;
        texture.userData.owned = true;
        for (const [name, roughness] of Object.entries(FINISHES)) {
          const buf = new Buffers();
          for (const it of labelItems) {
            if (it.page === page && (it.book.finish || 'matte') === name) buf.spine(it.matrix, it.book.h, it.profile, it.uv);
          }
          if (!buf.count) continue;
          const material = new THREE.MeshPhysicalMaterial({
            map: texture, roughness, specularIntensity: BOOK_SHINE,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
          });
          material.userData.book = true;
          add(new THREE.Mesh(buf.toGeometry(), material), false);
        }
      });
    }

    // Decorations
    for (const place of plan.placements) {
      if (place.kind !== 'prop' || !this.props.has(place.name)) continue;
      const object = this.props.get(place.name).object.clone(true);
      object.traverse((o) => { o.userData.shared = true; });
      object.position.set(x0 + place.cx, rowY[place.row], SHELF_DEPTH / 2);
      object.rotation.y = place.rot;
      object.scale.setScalar(place.scale);
      this.content.add(object);
    }

    // A framed card, used for shelf labels and the colour key. Returns nothing; adds two meshes.
    const addCard = (canvas, cx, cy, z, width, height) => {
      const frame = new Buffers();
      frame.box(identity, cx - width / 2, cx + width / 2, cy - height / 2, cy + height / 2, z, z + 0.003, null, null, 0.001);
      add(new THREE.Mesh(frame.toGeometry(),
        new THREE.MeshStandardMaterial({ color: 0x8a6a34, metalness: 0.85, roughness: 0.38 })));
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = anisotropy;
      texture.userData.owned = true;
      const rim = 0.0028;
      const card = new THREE.Mesh(new THREE.PlaneGeometry(width - rim * 2, height - rim * 2),
        new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8 }));
      card.position.set(cx, cy, z + 0.0033);
      add(card, false);
    };

    // A shelf for each rating: a label holder on the front edge of every shelf.
    if (plan.rowLabels) {
      const plateW = Math.min(0.15, boardW * 0.3);
      const plateH = plateW * (120 / 440);
      rowY.forEach((y, r) => {
        if (plan.rowLabels[r] === undefined) return;
        addCard(ratingPlateCanvas(plan.rowLabels[r]), -boardW / 2 + plateW / 2 + 0.03,
          y - SHELF_THICK / 2 - 0.004, SHELF_DEPTH, plateW, plateH);
      });
    }

    // Cover colour by rating: a key on the wall under the shelves, so the picture explains itself.
    const blockW = boardW + 2 * side;
    let frameBottom = bottomY;
    if (opts.legend && opts.legend.length) {
      const canvas = ratingKeyCanvas(opts.legend);
      const keyW = Math.min(Math.max(opts.legend.length * 0.2, blockW * 0.6), blockW * 0.98);
      const keyH = keyW * (canvas.height / canvas.width);
      addCard(canvas, 0, bottomY - 0.04 - keyH / 2, 0.001, keyW, keyH);
      frameBottom = bottomY - 0.04 - keyH - 0.012;
    }

    // Camera
    const blockH = topY - frameBottom;
    const centreY = (topY + frameBottom) / 2;
    this.aspect = opts.aspect;
    let tanH = 18 / 50;                      // a 50 mm lens on a 36 mm sensor
    let tanV = tanH / this.aspect;
    if (this.aspect < 1) { tanV = 18 / 50; tanH = tanV * this.aspect; }
    const distance = Math.max((blockW / 2) * 1.12 / tanH, (blockH / 2) * 1.12 / tanV);
    this.camera.fov = (2 * Math.atan(tanV) * 180) / Math.PI;
    this.camera.aspect = this.aspect;
    this.camera.near = distance * 0.3;
    this.camera.far = distance * 2 + 5;
    this.camera.position.set(0, centreY, SHELF_DEPTH + distance);
    this.camera.lookAt(0, centreY, 0);

    // Wall
    const wallW = Math.max(blockW * 2.5, distance * 2.5, 6);
    const wallH = Math.max(blockH * 2.5, distance * 2.5, 4);
    if (opts.wallType === 'panel') {
      // Frame-and-panel woodwork with real relief, so it catches the light.
      const buf = new Buffers();
      const [cellW, cellH, rail, proud] = [0.62, 0.92, 0.085, 0.016];
      const [left, right, low, high] = [-wallW / 2, wallW / 2, centreY - wallH / 2, centreY + wallH / 2];
      buf.box(identity, left, right, low, high, -0.02, 0, null, upright);
      const cols = Math.ceil(wallW / cellW / 2) + 1;
      const rws = Math.ceil(wallH / cellH / 2) + 1;
      for (let i = -cols; i <= cols; i++) {
        const cx = (i + 0.5) * cellW;
        buf.box(identity, cx - rail / 2, cx + rail / 2, low, high, 0, proud, null, upright);
        for (let j = -rws; j <= rws; j++) {      // a raised field in the middle of each panel
          const py = centreY + j * cellH;
          buf.box(identity, cx - cellW + rail / 2 + 0.06, cx - rail / 2 - 0.06, py + rail / 2 + 0.06,
            py + cellH - rail / 2 - 0.06, 0, 0.008, null, upright, 0.004);
        }
      }
      for (let j = -rws; j <= rws; j++) {
        const cy = centreY + j * cellH;
        buf.box(identity, left, right, cy - rail / 2, cy + rail / 2, 0, proud * 0.98, null, along, 0.003);
      }
      add(new THREE.Mesh(buf.toGeometry(), this.woodMaterial(opts.wall, true, 0.48)));
    } else {
      const tiles = wallTextures(opts.wallType, opts.wall);
      const asTexture = (canvas, colour) => {
        const t = new THREE.CanvasTexture(canvas);
        if (colour) t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(wallW / tiles.size[0], wallH / tiles.size[1]);
        t.anisotropy = anisotropy;
        t.userData.owned = true;
        return t;
      };
      const surface = asTexture(tiles.surface, false);
      this.bump.repeat.set(wallW / 0.18, wallH / 0.18);
      const material = new THREE.MeshStandardMaterial({
        map: asTexture(tiles.colour, true), roughnessMap: surface, metalnessMap: surface,
        roughness: 1, metalness: 1, normalMap: this.bump,
      });
      material.normalScale.set(0.15, 0.15);
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallW, wallH), material);
      wall.position.set(0, centreY, 0);
      add(wall, false);
    }

    // Lighting
    this.geom = {
      centre: new THREE.Vector3(0, centreY, SHELF_DEPTH / 2),
      halfW: blockW / 2, halfH: blockH / 2, topY, distance,
      radius: 0.5 * Math.hypot(blockW, blockH) + 0.35,
    };
    this.applyLighting(opts.lighting, opts.wall);
    this.restart();
  }

  /** Set up the lights for a rig. wall (sRGB) tints the bounced light. */
  applyLighting(name, wall) {
    const rig = LIGHTING[name] || LIGHTING.soft;
    const g = this.geom;
    this.rig = rig;
    this.spotSpecs = rig.spots(g).slice(0, MAX_SPOTS);
    this.spots.forEach((light, k) => {
      const spec = this.spotSpecs[k];
      light.visible = Boolean(spec);
      if (!spec) return;
      const dist = spec.pos.distanceTo(spec.target);
      light.color.setRGB(...spec.color);
      light.intensity = spec.intensity;
      light.angle = Math.min(Math.atan(spec.cover / dist), 1.3);
      light.penumbra = spec.penumbra;
      light.map = spec.gobo ? this.gobos[spec.gobo] : null;
      const cam = light.shadow.camera;
      cam.near = Math.max(0.05, dist - g.radius - 0.6);
      cam.far = dist + g.radius + 1.5;
      cam.updateProjectionMatrix();
    });
    this.sky.color.setRGB(...rig.sky.color);
    this.sky.intensity = rig.sky.intensity;
    // Light bouncing around the room picks up some of the wall's colour.
    const lin = wall.map(toLinear);
    const peak = Math.max(...lin, 1e-3);
    this.ambient.color.setRGB(...lin.map((c) => 0.55 + 0.45 * (c / peak)));
    this.ambient.intensity = rig.ambient;
    this.renderer.toneMappingExposure = rig.exposure;      // used only by the single-frame fallback
    this.present.uniforms.exposure.value = rig.exposure;
    this.present.uniforms.vignette.value = rig.vignette;
    this.content.traverse((o) => {
      if (!o.isMesh) return;
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        // Books get only a little of the room's reflection: more lays a white sheen over the covers.
        mat.envMapIntensity = rig.reflections * (mat.userData.book ? BOOK_REFLECTION : 1);
      }
    });
  }

  restart() { this.frame = 0; }

  /** Set the drawing size in real pixels (the canvas's CSS size is left alone). */
  setRenderSize(width, height) {
    width = Math.max(2, Math.round(width));
    height = Math.max(2, Math.round(height));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    if (this.canAccumulate) {
      if (this.sample) { this.sample.dispose(); this.total.dispose(); }
      const options = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
      this.sample = new THREE.WebGLRenderTarget(width, height, { ...options, depthBuffer: true });
      this.total = new THREE.WebGLRenderTarget(width, height, { ...options, depthBuffer: false });
    }
    this.restart();
  }

  /** Render one frame with freshly sampled light positions and blend it into the running average. */
  renderSample() {
    const r = this.renderer;
    const i = this.frame + 1;
    const g = this.geom;
    const dir = new THREE.Vector3();
    const u = new THREE.Vector3();
    const w = new THREE.Vector3();
    const primes = [[2, 3], [5, 7], [11, 13], [17, 19]];

    // Each lamp is nudged around a small disc, which adds up to the soft shadow of a real, sized light.
    this.spotSpecs.forEach((spec, k) => {
      const light = this.spots[k];
      dir.subVectors(spec.pos, spec.target);
      const dist = dir.length();
      dir.normalize();
      u.set(0, 1, 0).cross(dir).normalize();
      w.crossVectors(dir, u);
      const angle = 2 * Math.PI * halton(i, primes[k][0]);
      const reach = spec.soft * dist * Math.sqrt(halton(i, primes[k][1]));
      light.position.copy(spec.pos).addScaledVector(u, reach * Math.cos(angle)).addScaledVector(w, reach * Math.sin(angle));
      light.target.position.copy(spec.target);
      light.target.updateMatrixWorld();
    });

    // Sky light: sampled across the whole room in front of the wall, which gives soft contact shadows.
    const phi = 2 * Math.PI * halton(i, 23);
    const sr = Math.sqrt(halton(i, 29)) * 0.92;
    dir.set(sr * Math.cos(phi), sr * Math.sin(phi) + 0.25, Math.sqrt(1 - sr * sr) + 0.15).normalize();
    this.sky.position.copy(g.centre).addScaledVector(dir, g.radius * 2.5);
    this.sky.target.position.copy(g.centre);
    this.sky.target.updateMatrixWorld();
    const cam = this.sky.shadow.camera;
    cam.left = cam.bottom = -g.radius;
    cam.right = cam.top = g.radius;
    cam.near = g.radius * 0.5;
    cam.far = g.radius * 4.5;
    cam.updateProjectionMatrix();

    if (!this.canAccumulate) {
      this.camera.clearViewOffset();
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      this.frame = this.previewFrames;
      return;
    }

    // Shift the picture by a fraction of a pixel each frame, which smooths every edge.
    this.camera.setViewOffset(this.width, this.height, halton(i, 2) - 0.5, halton(i, 3) - 0.5, this.width, this.height);
    r.setRenderTarget(this.sample);
    r.render(this.scene, this.camera);

    this.quad.material = this.blend;
    this.blend.uniforms.tex.value = this.sample.texture;
    this.blend.uniforms.weight.value = 1 / i;
    r.setRenderTarget(this.total);
    r.autoClear = false;
    r.render(this.quadScene, this.quadCamera);
    r.autoClear = true;

    this.quad.material = this.present;
    this.present.uniforms.tex.value = this.total.texture;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCamera);
    this.frame++;
  }

  /** Render at full size and return a PNG blob. longEdge is the longer side in pixels. */
  async exportImage(longEdge, frames = 128, onProgress = () => {}) {
    const limit = this.renderer.capabilities.maxTextureSize;
    longEdge = Math.min(longEdge, limit);
    const width = this.aspect >= 1 ? longEdge : Math.round(longEdge * this.aspect);
    const height = this.aspect >= 1 ? Math.round(longEdge / this.aspect) : longEdge;
    const previous = [this.width, this.height];
    this.busy = true;
    try {
      this.setRenderSize(width, height);
      this.restart();
      const total = this.canAccumulate ? frames : 1;
      for (let i = 0; i < total; i++) {
        this.renderSample();
        if (i % 8 === 7) {
          onProgress((i + 1) / total);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      const blob = await new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The browser could not create the image. Try a smaller size.');
      return { blob, width, height };
    } finally {
      this.setRenderSize(previous[0], previous[1]);
      this.restart();
      this.busy = false;
    }
  }
}
