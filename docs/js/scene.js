// Draws the bookshelf with three.js. Soft shadows come from averaging many frames, each lit from a
// slightly different direction, which is cheap for a still picture and needs no server.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  SHELF_THICK, SHELF_DEPTH, SHELF_END_MARGIN, BASE_Y, SPINE_FONTS, splitLines,
} from './books.js';

const LABEL_LIFT = 0.0004;
const MAX_TEXT_M = 0.026;
const INK = { light: '#ece4d0', gold: '#d9b565', dark: '#1f1b18' };
const PROP_NAMES = ['succulent', 'picture_frame', 'vase', 'elephant', 'bust', 'horse', 'cat'];
const WALL_CELL = 0.11;                    // width of one wallpaper diamond, metres

const css = ([r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

// ---------------------------------------------------------------- geometry buffers
class Buffers {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.uv = []; this.idx = []; this.count = 0; }

  /** A quad from four corners (counter-clockwise seen from outside), transformed by matrix. */
  quad(matrix, corners, normal, colour, uvs) {
    const v = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      v.set(corners[i][0], corners[i][1], corners[i][2]).applyMatrix4(matrix);
      this.pos.push(v.x, v.y, v.z);
      v.set(normal[0], normal[1], normal[2]).transformDirection(matrix);
      this.nor.push(v.x, v.y, v.z);
      if (colour) this.col.push(colour[0], colour[1], colour[2]);
      if (uvs) this.uv.push(uvs[i][0], uvs[i][1]);
    }
    const c = this.count;
    this.idx.push(c, c + 1, c + 2, c, c + 2, c + 3);
    this.count += 4;
  }

  /** An axis-aligned box in local space. uvScale (optional) maps metres to texture repeats. */
  box(matrix, x0, x1, y0, y1, z0, z1, colour, uvScale) {
    const faces = [
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], 0, 1],
      [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], 0, 1],
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], 2, 1],
      [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], 2, 1],
      [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], 0, 2],
      [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], 0, 2],
    ];
    for (const [a, b, c, d, n, long, short] of faces) {
      // Wood grain runs up the texture, so the long axis of a board maps to V.
      const uvs = uvScale ? [a, b, c, d].map((p) => [p[short] * uvScale + 0.37, p[long] * uvScale]) : null;
      this.quad(matrix, [a, b, c, d], n, colour, uvs);
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

// ---------------------------------------------------------------- spine labels
function fitTitle(ctx, book, wPx, hPx, density, flat) {
  const font = SPINE_FONTS[book.font];
  let words = book.title.split(/\s+/).filter(Boolean);
  if (words.length > 9) words = [...words.slice(0, 8), words.slice(8).join(' ')];
  if (!words.length) return null;
  const measure = (lines) => {
    ctx.font = `${font.weight} 100px ${font.family}`;
    return Math.max(...lines.map((l) => ctx.measureText(l).width)) / 100;
  };
  const blockEm = (n) => (n - 1) * 1.08 + 0.74;
  const maxPx = MAX_TEXT_M * density;
  const spineLen = hPx * (book.bands ? 0.78 : 0.84);
  let best = null;
  for (let n = 1; n <= Math.min(3, words.length); n++) {
    const lines = splitLines(words, n);
    const size = Math.min(spineLen / Math.max(measure(lines), 0.01), (wPx * 0.64) / blockEm(n), maxPx);
    if (!best || size > best.size * 1.02) best = { size, lines, vertical: true };
  }
  if (!flat && words.length <= 6) {
    for (let n = Math.max(1, words.length - 2); n <= words.length; n++) {
      const lines = splitLines(words, n);
      const size = Math.min((wPx * 0.82) / Math.max(measure(lines), 0.01), (hPx * 0.8) / blockEm(n), maxPx) * 0.9;
      if (size > best.size) best = { size, lines, vertical: false };
    }
  }
  best.font = font;
  return best;
}

function drawLabel(ctx, x, y, w, h, book, density, showTitle, flat) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 1, y - 1, w + 2, h + 2);
  ctx.clip();
  ctx.fillStyle = css(book.color);
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);

  // Darken the edges a little so a flat spine reads as gently rounded.
  const shade = ctx.createLinearGradient(x, 0, x + w, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.24)');
  shade.addColorStop(0.2, 'rgba(0,0,0,0)');
  shade.addColorStop(0.8, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.24)');
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = INK[book.ink];
  if (book.bands) {
    const bx = x + w * 0.1;
    const bw = w * 0.8;
    for (const [at, thick] of [[0.055, 0.0022], [0.075, 0.001], [0.945, 0.0022], [0.925, 0.001]]) {
      const t = Math.max(thick * density, 1);
      ctx.fillRect(bx, y + h * at - t / 2, bw, t);
    }
  }
  const fit = showTitle ? fitTitle(ctx, book, w, h, density, flat) : null;
  if (fit && fit.size >= 2) {
    ctx.font = `${fit.font.weight} ${fit.size}px ${fit.font.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.translate(x + w / 2, y + h / 2);
    if (fit.vertical) ctx.rotate(Math.PI / 2);      // reads from the top of the spine downwards
    const lineH = fit.size * 1.08;
    fit.lines.forEach((line, i) => {
      ctx.fillText(line, 0, (i - (fit.lines.length - 1) / 2) * lineH + fit.size * 0.35);
    });
  }
  ctx.restore();
}

/** Pack every spine label into as few large textures as possible. */
function buildLabelAtlases(items, maxSize, showTitles) {
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
    drawLabel(ctx, r.x, r.y, r.w, r.h, it.book, density, showTitles, it.flat);
    it.page = r.page;
    it.uv = { u0: r.x / canvas.width, u1: (r.x + r.w) / canvas.width,
      vTop: 1 - r.y / canvas.height, vBottom: 1 - (r.y + r.h) / canvas.height };
  });
  return pages.map((p) => p.canvas);
}

function wallpaperCanvas(wallRgb, pattern) {
  const w = 128;
  const h = 192;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const gold = [0.68, 0.54, 0.34];
  const sub = 3;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let hit = 0;
      if (pattern) {
        for (let sy = 0; sy < sub; sy++) {
          for (let sx = 0; sx < sub; sx++) {
            const u = (px + (sx + 0.5) / sub) / w;
            const v = (py + (sy + 0.5) / sub) / h;
            const da = Math.abs(((u + v) % 1) - 0.5);
            const db = Math.abs((((u - v) % 1) + 1) % 1 - 0.5);
            const m = Math.min(da, db);
            if (m < 0.011 || m > 0.42) hit++;
          }
        }
      }
      const k = hit / (sub * sub);
      const o = (py * w + px) * 4;
      for (let c = 0; c < 3; c++) img.data[o + c] = Math.round(255 * (wallRgb[c] * (1 - k) + gold[c] * k));
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------- the view
export class BookshelfView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.85;
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

    const shadowSize = r.capabilities.maxTextureSize >= 8192 ? 4096 : 2048;
    this.key = new THREE.DirectionalLight(new THREE.Color(1.0, 0.93, 0.84), 3.2);
    this.sky = new THREE.DirectionalLight(new THREE.Color(0.86, 0.9, 1.0), 1.15);
    for (const light of [this.key, this.sky]) {
      light.castShadow = true;
      light.shadow.mapSize.set(shadowSize, shadowSize);
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.003;
      this.scene.add(light, light.target);
    }
    this.scene.add(new THREE.AmbientLight(0xfff1e0, 0.1));

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
      uniforms: { tex: { value: null } },
      vertexShader,
      fragmentShader: 'uniform sampler2D tex; varying vec2 vUv;'
        + 'void main(){ gl_FragColor = vec4(texture2D(tex, vUv).rgb, 1.0);\n'
        + '#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blend);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);

    this.textures = new THREE.TextureLoader();
    this.wood = null;
    this.props = new Map();
    this.frame = 0;
    this.previewFrames = 64;
    this.busy = false;
    this.aspect = 16 / 9;
    this.bounds = { centre: new THREE.Vector3(0, 1, 0), radius: 2 };
    this.width = 0;
    this.height = 0;

    const tick = () => {
      if (!this.busy && this.width && this.frame < this.previewFrames) this.renderSample();
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
    this.wood = { diff, nor };
  }

  propList() {
    return [...this.props.entries()].map(([name, p]) => ({ name, w: p.w, d: p.d, h: p.h }));
  }

  disposeContent() {
    this.content.traverse((o) => {
      if (!o.isMesh || o.userData.shared) return;
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m.map && m.map.userData.owned) m.map.dispose(); m.dispose(); }
    });
    this.content.clear();
  }

  /** Rebuild everything from a layout plan. opts: {style, titles, wall:[r,g,b] sRGB, pattern, aspect}. */
  build(plan, opts) {
    this.disposeContent();
    const { rows, shelfW, pitch, clearH } = plan;
    const boardW = shelfW + 2 * SHELF_END_MARGIN;
    const x0 = -shelfW / 2;
    const rowY = [...Array(rows).keys()].map((r) => BASE_Y + (rows - 1 - r) * pitch);
    const topY = rowY[0] + clearH;
    const bottomY = rowY[rows - 1] - SHELF_THICK;
    const identity = new THREE.Matrix4();
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
    const uvScale = 1 / 1.1;
    for (const y of rowY) boards.box(identity, -boardW / 2, boardW / 2, y - SHELF_THICK, y, 0, SHELF_DEPTH, null, uvScale);
    if (bookcase) {
      boards.box(identity, -boardW / 2 - side, -boardW / 2, bottomY, topY + side, 0, SHELF_DEPTH, null, uvScale);
      boards.box(identity, boardW / 2, boardW / 2 + side, bottomY, topY + side, 0, SHELF_DEPTH, null, uvScale);
      boards.box(identity, -boardW / 2, boardW / 2, topY, topY + side, 0, SHELF_DEPTH, null, uvScale);
      boards.box(identity, -boardW / 2, boardW / 2, bottomY, topY, 0, 0.006, null, uvScale);
    }
    const woodMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.62, 0.5, 0.4), roughness: 0.5,
      map: this.wood && this.wood.diff, normalMap: this.wood && this.wood.nor,
    });
    if (!woodMaterial.map) woodMaterial.color.set(0x6b4526);
    woodMaterial.normalScale.set(0.5, 0.5);
    add(new THREE.Mesh(boards.toGeometry(), woodMaterial));

    // Books: covers and page blocks in one mesh, coloured per vertex
    const bookItems = plan.placements.filter((p) => p.kind !== 'prop');
    const solid = new Buffers();
    const zSpine = (book) => SHELF_DEPTH - 0.012 - book.push;
    const m = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    for (const place of bookItems) {
      const book = place.book;
      const y = rowY[place.row];
      const matrix = new THREE.Matrix4();
      if (place.kind === 'up') matrix.makeTranslation(x0 + place.x, y, zSpine(book));
      else if (place.kind === 'lean') {
        matrix.makeTranslation(x0 + place.pivot, y, zSpine(book)).multiply(m.makeRotationZ(-place.angle));
        if (place.angle > 0) matrix.multiply(tmp.makeTranslation(-book.t, 0, 0));
      } else {
        matrix.makeTranslation(x0 + place.cx, y + place.lift, SHELF_DEPTH - 0.014 - book.d / 2)
          .multiply(m.makeRotationY(place.rot))
          .multiply(tmp.makeTranslation(book.h / 2, 0, book.d / 2))
          .multiply(m.makeRotationZ(Math.PI / 2));
      }
      place.matrix = matrix;
      const { t, d, h } = book;
      const cover = Math.min(book.hard ? 0.0025 : 0.0009, t * 0.2);
      const inset = book.hard ? 0.003 : 0.0003;
      const colour = book.color.map(toLinear);
      solid.box(matrix, 0, cover, 0, h, -d, 0, colour);
      solid.box(matrix, t - cover, t, 0, h, -d, 0, colour);
      solid.box(matrix, cover, t - cover, 0, h, -cover, 0, colour);
      const paper = 0.62 + 0.1 * ((book.font % 3) / 2);
      solid.box(matrix, cover + 0.0001, t - cover - 0.0001, inset, h - inset, -d + Math.max(inset, 0.0006), -cover,
        [paper, paper * 0.9, paper * 0.72]);
    }
    if (bookItems.length) {
      add(new THREE.Mesh(solid.toGeometry(),
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.66 })));
    }

    // Spine labels: cover colour, bands and title, drawn on shared textures
    const labelItems = bookItems.map((p) => ({ book: p.book, flat: p.kind === 'flat', matrix: p.matrix }));
    if (labelItems.length) {
      const canvases = buildLabelAtlases(labelItems, this.maxTexture, opts.titles);
      canvases.forEach((canvas, page) => {
        const buf = new Buffers();
        for (const it of labelItems) {
          if (it.page !== page) continue;
          const { t, h } = it.book;
          const { u0, u1, vTop, vBottom } = it.uv;
          buf.quad(it.matrix, [[0, 0, LABEL_LIFT], [t, 0, LABEL_LIFT], [t, h, LABEL_LIFT], [0, h, LABEL_LIFT]],
            [0, 0, 1], null, [[u0, vBottom], [u1, vBottom], [u1, vTop], [u0, vTop]]);
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        texture.userData.owned = true;
        const material = new THREE.MeshStandardMaterial({
          map: texture, roughness: 0.66, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        });
        add(new THREE.Mesh(buf.toGeometry(), material), false);
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

    // Wall
    const blockW = boardW + 2 * side;
    const blockH = topY - bottomY;
    const centreY = (topY + bottomY) / 2;
    this.aspect = opts.aspect;
    let tanH = 18 / 50;                      // a 50 mm lens on a 36 mm sensor
    let tanV = tanH / this.aspect;
    if (this.aspect < 1) { tanV = 18 / 50; tanH = tanV * this.aspect; }
    const distance = Math.max((blockW / 2) * 1.12 / tanH, (blockH / 2) * 1.12 / tanV);
    const wallW = Math.max(blockW * 2.5, distance * 2.5, 6);
    const wallH = Math.max(blockH * 2.5, distance * 2.5, 4);
    const wallTexture = new THREE.CanvasTexture(wallpaperCanvas(opts.wall, opts.pattern));
    wallTexture.colorSpace = THREE.SRGBColorSpace;
    wallTexture.wrapS = wallTexture.wrapT = THREE.RepeatWrapping;
    wallTexture.repeat.set(wallW / WALL_CELL, wallH / (WALL_CELL * 1.5));
    wallTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    wallTexture.userData.owned = true;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallW, wallH),
      new THREE.MeshStandardMaterial({ map: wallTexture, roughness: 0.82 }));
    wall.position.set(0, centreY, 0);
    add(wall, false);

    // Camera and shadow coverage
    this.camera.fov = (2 * Math.atan(tanV) * 180) / Math.PI;
    this.camera.aspect = this.aspect;
    this.camera.near = distance * 0.3;
    this.camera.far = distance * 2 + 5;
    this.camera.position.set(0, centreY, SHELF_DEPTH + distance);
    this.camera.lookAt(0, centreY, 0);
    this.bounds.centre.set(0, centreY, SHELF_DEPTH / 2);
    this.bounds.radius = 0.5 * Math.hypot(blockW, blockH) + 0.35;
    this.restart();
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

  aimLight(light, direction) {
    const { centre, radius } = this.bounds;
    light.position.copy(centre).addScaledVector(direction, radius * 2.5);
    light.target.position.copy(centre);
    light.target.updateMatrixWorld();
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = radius * 0.5;
    cam.far = radius * 4.5;
    cam.updateProjectionMatrix();
  }

  /** Render one frame with freshly sampled light directions and blend it into the running average. */
  renderSample() {
    const r = this.renderer;
    const i = this.frame;
    const dir = new THREE.Vector3();

    // Key light: a soft source up and to the left.
    const ang = 2 * Math.PI * halton(i + 1, 3);
    const rad = 0.14 * Math.sqrt(halton(i + 1, 2));
    dir.set(-0.5 + rad * Math.cos(ang), 0.8 + rad * Math.sin(ang), 1.0).normalize();
    this.aimLight(this.key, dir);

    // Sky light: sampled across the whole room in front of the wall, which gives soft contact shadows.
    const u1 = halton(i + 1, 5);
    const phi = 2 * Math.PI * halton(i + 1, 7);
    const sr = Math.sqrt(u1) * 0.92;
    dir.set(sr * Math.cos(phi), sr * Math.sin(phi) + 0.25, Math.sqrt(1 - sr * sr) + 0.15).normalize();
    this.aimLight(this.sky, dir);

    if (!this.canAccumulate) {
      this.camera.clearViewOffset();
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      this.frame = this.previewFrames;
      return;
    }

    // Shift the picture by a fraction of a pixel each frame, which smooths every edge.
    this.camera.setViewOffset(this.width, this.height, halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5,
      this.width, this.height);
    r.setRenderTarget(this.sample);
    r.render(this.scene, this.camera);

    this.quad.material = this.blend;
    this.blend.uniforms.tex.value = this.sample.texture;
    this.blend.uniforms.weight.value = 1 / (i + 1);
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
  async exportImage(longEdge, frames = 96, onProgress = () => {}) {
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
      this.busy = false;
    }
  }
}
