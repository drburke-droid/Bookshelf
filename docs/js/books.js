// Book list logic: reading the CSV, choosing sizes and colours, and laying books out on shelves.
// No drawing happens here, so this file also runs under Node for testing.

// ---------------------------------------------------------------- sizes, in metres
export const SHELF_THICK = 0.022;
export const SHELF_DEPTH = 0.20;
export const SHELF_END_MARGIN = 0.025;
export const ROW_HEADROOM = 0.05;
export const MAX_BOOK_H = 0.240;
export const BOOK_GAP = 0.0006;
export const MIN_SHELF_W = 0.50;
export const ROW_SLACK = 0.07;
export const BASE_Y = 0.80;

export const PALETTES = {
  classic: ['3d2a55', '5a3a5e', '2e2f5e', '2f4a35', '5b6238', '2c5557', '1f2d4a', '4a4f5c',
    'b59a78', 'd9ccb0', '5c4033', '7a4a32', 'a4532f', '8c2f2a', 'a67f7b', 'b58e3a',
    '25232a', '3b5a48', '6b4a6e'],
  leather: ['4a2c1d', '6b3a22', '3a1f1a', '5a1e1e', '2a3a2a', '1f2a3a', '7a5230', '2b2320',
    '8a6a3a', '40302a', '6e2a2a', '24332b'],
  vivid: ['d7263d', 'f46036', 'f2c14e', '2e9e6b', '1b998b', '2274a5', '3a4fb5', '7b3fa0',
    'e75480', '111111', 'f5f1e6', 'ff8c42'],
  pastel: ['f4c7c3', 'f9dcc4', 'fbeec1', 'cfe8cf', 'bfe3e0', 'c5d8f0', 'd5c9ee', 'efc9e2',
    'e8e4da', 'b9c7b2', 'd8b9a0', 'aebfd0'],
  mono: ['111214', '2a2c30', '45484e', '6b6f76', '9a9da3', 'c9c9c6', 'e9e6de', 'f6f3ea',
    '3a3530', '8c857a'],
};

export const SPINE_FONTS = [
  { family: '"Gill Sans", "Gill Sans MT", "Trebuchet MS", "Segoe UI", sans-serif', weight: 600 },
  { family: 'Georgia, "Times New Roman", serif', weight: 700 },
  { family: '"Helvetica Neue", Helvetica, Arial, sans-serif', weight: 700 },
  { family: 'Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif', weight: 700 },
  { family: 'Futura, "Century Gothic", "Avenir Next", Verdana, sans-serif', weight: 600 },
  { family: 'Baskerville, "Baskerville Old Face", Garamond, "Times New Roman", serif', weight: 700 },
];

// ---------------------------------------------------------------- small helpers
export function crc32(text) {
  const bytes = new TextEncoder().encode(text);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Small seeded random number generator, so the same list and settings give the same shelf. */
export class Rng {
  constructor(seed) { this.state = (seed >>> 0) || 1; }
  random() {
    let t = (this.state += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a, b) { return a + (b - a) * this.random(); }
  int(a, b) { return a + Math.floor(this.random() * (b - a + 1)); }
  choice(list) { return list[Math.floor(this.random() * list.length)]; }
  shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
}

export function hexToRgb(hex) {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

const norm = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------- CSV
/** Parse CSV text into rows of cells. Handles quotes, commas and line breaks inside quotes. */
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.split('\n', 1)[0];
  let delimiter = ',';
  for (const cand of [';', '\t']) {
    if (firstLine.split(cand).length > firstLine.split(delimiter).length) delimiter = cand;
  }
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const COLUMN_ALIASES = {
  title: ['title', 'book title', 'name'],
  author: ['author', 'authors', 'author l f'],
  pages: ['number of pages', 'pages', 'page count', 'num pages'],
  shelf: ['exclusive shelf', 'read status', 'status', 'shelf'],
  dateRead: ['date read', 'last date read', 'date finished', 'finished'],
  dateAdded: ['date added'],
  rating: ['my rating', 'star rating', 'rating'],
  binding: ['binding', 'format'],
  year: ['original publication year', 'year published', 'year'],
};

const SHELF_WORDS = {
  read: 'read', finished: 'read',
  'currently reading': 'current', reading: 'current',
  'to read': 'to-read', 'want to read': 'to-read', tbr: 'to-read',
};

/** Returns {year, key} where key sorts chronologically, or null. */
export function parseDate(text) {
  text = (text || '').trim().split(/[ T]/)[0];
  if (!text) return null;
  let m = text.match(/^(\d{4})[/.-](\d{1,2})(?:[/.-](\d{1,2}))?$/);
  if (m) return { year: +m[1], key: +m[1] * 10000 + +m[2] * 100 + (+m[3] || 1) };
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return { year: +m[3], key: +m[3] * 10000 + +m[1] * 100 + +m[2] };
  m = text.match(/^(\d{4})$/);
  if (m) return { year: +m[1], key: +m[1] * 10000 + 101 };
  return null;
}

function parseNumber(text) {
  const m = (text || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** 'A Storm of Swords (A Song of Ice and Fire, #3)' -> 'A Storm of Swords'. */
export function cleanTitle(title, shorten) {
  title = title.split(/\s+/).join(' ').trim();
  title = title.replace(/\s*\([^()]*#\s*[\d.,\-–&\s]+[^()]*\)\s*$/, '');
  if (shorten && title.length > 26) {
    for (const sep of [': ', ' - ', ' — ', '; ']) {
      const head = title.split(sep)[0].trim();
      if (head.length >= 3 && head.length < title.length) { title = head; break; }
    }
    title = title.replace(/\s*\([^()]*\)\s*$/, '') || title;
  }
  return title;
}

/**
 * Turn CSV text into books. Throws an Error with a message fit to show the visitor.
 * options: {shelf: 'read'|'current'|'to-read'|'all', year: 0 or a year, shorten: bool}
 */
export function readBooks(text, options) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error('That file is empty.');
  const header = rows[0].map(norm);
  const col = {};
  for (const [key, names] of Object.entries(COLUMN_ALIASES)) {
    for (const name of names) {
      const idx = header.indexOf(name);
      if (idx >= 0) { col[key] = idx; break; }
    }
  }
  if (col.title === undefined) {
    throw new Error('No "Title" column found. The first row of the file must name the columns.');
  }
  const cell = (row, key) => (col[key] !== undefined && col[key] < row.length ? row[col[key]].trim() : '');
  const lastFirst = col.author !== undefined && header[col.author] === 'author l f';

  const books = [];
  const years = new Set();
  const counts = { total: 0, wrongShelf: 0, wrongYear: 0, hasShelves: col.shelf !== undefined };
  for (const row of rows.slice(1)) {
    const rawTitle = cell(row, 'title');
    if (!rawTitle) continue;
    counts.total++;
    const shelf = col.shelf === undefined ? 'read' : (SHELF_WORDS[norm(cell(row, 'shelf'))] || 'other');
    if (options.shelf !== 'all' && shelf !== options.shelf) { counts.wrongShelf++; continue; }
    const dateRead = parseDate(cell(row, 'dateRead'));
    if (dateRead) years.add(dateRead.year);
    if (options.year && (!dateRead || dateRead.year !== options.year)) { counts.wrongYear++; continue; }
    let author = cell(row, 'author');
    if (lastFirst) author = author.split(',', 2).map((p) => p.trim()).reverse().join(' ');
    else author = author.split(/[,;&]/)[0].trim();
    const pages = parseNumber(cell(row, 'pages'));
    const dateAdded = parseDate(cell(row, 'dateAdded'));
    books.push({
      title: cleanTitle(rawTitle, options.shorten),
      fullTitle: rawTitle,
      author,
      pages: pages && pages > 0 ? Math.round(pages) : null,
      dateKey: dateRead ? dateRead.key : (dateAdded ? dateAdded.key : 0),
      rating: parseNumber(cell(row, 'rating')) || 0,
      binding: cell(row, 'binding').toLowerCase(),
      year: parseNumber(cell(row, 'year')) || 0,
      index: books.length,
    });
  }
  return { books, counts, years: [...years].sort((a, b) => b - a) };
}

// ---------------------------------------------------------------- looks
function luminance([r, g, b]) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Give every book a thickness, height, depth, cover colour, lettering colour and typeface. */
export function assignLooks(books, opts) {
  const palette = (PALETTES[opts.palette] || PALETTES.classic).map(hexToRgb);
  for (const book of books) {
    const rng = new Rng(crc32(`${book.fullTitle}|${book.author}`) ^ Math.imul(opts.seed, 7919));
    const pages = book.pages || rng.int(180, 420);
    book.t = Math.min(Math.max((0.004 + pages * 0.000055) * opts.thickness, 0.007), 0.075);

    const binding = book.binding;
    let kind;
    if (binding.includes('mass market')) kind = 'pocket';
    else if (/hard|leather|library/.test(binding)) kind = 'hard';
    else if (/paper|soft/.test(binding)) kind = 'paper';
    else kind = ['paper', 'paper', 'paper', 'paper', 'paper', 'hard', 'hard', 'hard', 'pocket', 'pocket'][rng.int(0, 9)];
    if (kind === 'hard') { book.h = rng.uniform(0.212, MAX_BOOK_H); book.d = rng.uniform(0.148, 0.160); }
    else if (kind === 'pocket') { book.h = rng.uniform(0.168, 0.180); book.d = rng.uniform(0.104, 0.112); }
    else { book.h = rng.uniform(0.192, 0.214); book.d = rng.uniform(0.126, 0.140); }
    book.hard = kind === 'hard';

    const pick = opts.colorBy === 'author' && book.author
      ? new Rng(crc32(book.author) ^ opts.seed)
      : rng;
    const base = pick.choice(palette);
    const jitter = 1 + rng.uniform(-0.07, 0.07);
    book.color = base.map((c) => Math.min(c * jitter, 1));
    const lum = luminance(book.color);
    if (lum > 0.16) book.ink = 'dark';
    else if (lum < 0.05 && rng.random() < 0.35) book.ink = 'gold';
    else book.ink = 'light';
    book.bands = rng.random() < 0.35 && book.t > 0.012;
    book.push = rng.uniform(0, 0.008);
    book.font = rng.int(0, SPINE_FONTS.length - 1);
  }
}

function hue([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const sat = max === 0 ? 0 : d / max;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: h / 6, s: sat, v: max };
}

export function sortBooks(books, mode, reverse, seed) {
  const surname = (b) => (b.author.split(/\s+/).pop() || '').toLowerCase();
  const plain = (b) => b.title.toLowerCase().replace(/^(the|a|an)\s+/, '');
  if (mode === 'date') books.sort((a, b) => a.dateKey - b.dateKey || a.index - b.index);
  else if (mode === 'author') {
    books.sort((a, b) => surname(a).localeCompare(surname(b)) || a.author.localeCompare(b.author)
      || a.year - b.year || plain(a).localeCompare(plain(b)));
  } else if (mode === 'title') books.sort((a, b) => plain(a).localeCompare(plain(b)));
  else if (mode === 'thickness') books.sort((a, b) => b.t - a.t);
  else if (mode === 'rating') books.sort((a, b) => b.rating - a.rating || a.index - b.index);
  else if (mode === 'colour') {
    const key = (b) => { const c = hue(b.color); return c.s < 0.18 ? [0, c.v, 0] : [1, c.h, c.v]; };
    books.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    });
  } else if (mode === 'shuffle') new Rng(seed + 99).shuffle(books);
  if (reverse) books.reverse();
}

// ---------------------------------------------------------------- layout
const leanReach = (book, neighbourH, angle) => Math.min(book.h * Math.cos(angle), neighbourH) * Math.tan(angle);
const runWidth = (run) => run.reduce((sum, b) => sum + b.t + BOOK_GAP, 0);

/**
 * Decide where every book and decoration goes.
 * props: [{name, w, d, h}] decorations that may be used. aspect: picture width / height.
 * Returns {rows, shelfW, pitch, clearH, placements}.
 */
export function planLayout(books, opts, props, aspect) {
  const rng = new Rng(opts.seed * 104729 + 17);
  const pitch = MAX_BOOK_H + ROW_HEADROOM + SHELF_THICK;
  const clearH = pitch - SHELF_THICK;
  const totalW = runWidth(books);
  const meanT = totalW / Math.max(books.length, 1);

  const fitted = [];
  for (const p of props) {
    if (Math.min(p.w, p.d, p.h) <= 0) continue;
    const scale = Math.min(1, (clearH - 0.035) / p.h, (SHELF_DEPTH - 0.03) / p.d, 0.30 / p.w);
    fitted.push({ name: p.name, scale, w: p.w * scale });
  }
  const avgPropW = fitted.length ? fitted.reduce((s, p) => s + p.w, 0) / fitted.length : 0;

  const decorCounts = (n) => ({
    props: opts.decor && fitted.length ? Math.min(Math.floor(n * 0.5 + 0.5), n) : 0,
    stacks: opts.stacks && books.length >= 14 && n >= 2 ? Math.floor(n * 0.34 + 0.5) : 0,
  });
  const stackReserve = Math.max(0.21 - 3 * meanT, 0.05);
  const shelfWidthFor = (n) => {
    const c = decorCounts(n);
    const reserved = c.props * (avgPropW + 0.04) + c.stacks * stackReserve;
    return Math.max(MIN_SHELF_W, (totalW + reserved) / n / (1 - ROW_SLACK));
  };

  let nRows = opts.rows;
  if (!nRows) {
    // The shelf count that lets the books appear largest in the picture.
    let best = null;
    for (let n = 1; n <= 80; n++) {
      const width = shelfWidthFor(n) + 2 * SHELF_END_MARGIN;
      const zoom = Math.min(aspect / width, 1 / (n * pitch));
      if (!best || zoom > best.zoom * 1.001) best = { zoom, n };
    }
    nRows = best.n;
  }
  nRows = Math.max(1, Math.min(nRows, Math.max(1, books.length)));

  const counts = decorCounts(nRows);
  const order = rng.shuffle([...Array(nRows).keys()]);
  const rowStack = new Set(order.slice(0, counts.stacks));
  const propRows = order.slice(counts.stacks).concat(order.slice(0, counts.stacks)).slice(0, counts.props);
  const propCycle = rng.shuffle(fitted.slice());
  const rowProp = new Map(propRows.map((r, i) => [r, propCycle[i % propCycle.length]]));
  const reserved = [...Array(nRows).keys()].map((r) =>
    (rowProp.has(r) ? rowProp.get(r).w + 0.04 : 0) + (rowStack.has(r) ? stackReserve : 0));

  // Share the books out so every shelf ends up about equally full.
  const rows = [];
  let idx = 0;
  let remaining = totalW;
  for (let r = 0; r < nRows; r++) {
    if (r === nRows - 1) { rows.push(books.slice(idx)); break; }
    const reservedLeft = reserved.slice(r).reduce((a, b) => a + b, 0);
    const target = (remaining + reservedLeft) / (nRows - r) - reserved[r];
    const row = [];
    let acc = 0;
    const mustLeave = nRows - r - 1;
    while (idx < books.length - mustLeave) {
      const step = books[idx].t + BOOK_GAP;
      if (row.length && acc + step / 2 > target) break;
      row.push(books[idx]);
      acc += step;
      idx++;
    }
    remaining -= acc;
    rows.push(row);
  }

  // The left-to-right sequence of segments on every shelf.
  const rowSegments = rows.map((rowBooks, r) => {
    let run = rowBooks.slice();
    let stack = null;
    let stackSide = null;
    if (rowStack.has(r) && run.length >= 8) {
      const k = rng.choice([2, 3, 3, 4]);
      stackSide = rng.choice(['L', 'R']);
      let taken = stackSide === 'L' ? run.slice(0, k) : run.slice(-k);
      while (taken.length && taken.reduce((s, b) => s + b.t, 0) > clearH - 0.03) taken = taken.slice(0, -1);
      if (taken.length >= 2) {
        run = stackSide === 'L' ? run.slice(taken.length) : run.slice(0, run.length - taken.length);
        stack = { kind: 'stack', books: taken, w: Math.max(...taken.map((b) => b.h)) };
      } else stackSide = null;
    }
    const prop = rowProp.has(r) ? { ...rowProp.get(r), kind: 'prop' } : null;
    let segs;
    let endGap = null;
    const asRun = (list) => ({ kind: 'run', books: list });
    if (prop) {
      const sides = ['L', 'R', 'M'].filter((s) => s !== stackSide && (s !== 'M' || run.length >= 8));
      const side = rng.choice(sides);
      if (side === 'M') {
        const cut = rng.int(Math.floor(run.length * 0.35), Math.floor(run.length * 0.65));
        segs = [asRun(run.slice(0, cut)), prop, asRun(run.slice(cut))];
      } else segs = side === 'L' ? [prop, asRun(run)] : [asRun(run), prop];
    } else if (!stack && run.length >= 10 && rng.random() < 0.6) {
      const cut = rng.int(Math.floor(run.length * 0.3), Math.floor(run.length * 0.7));
      segs = [asRun(run.slice(0, cut)), asRun(run.slice(cut))];
    } else {
      segs = [asRun(run)];
      if (!stack) endGap = rng.random() < 0.7 ? 'R' : 'L';
    }
    if (stack) segs = stackSide === 'L' ? [stack, ...segs] : [...segs, stack];
    segs = segs.filter((s) => s.kind !== 'run' || s.books.length);
    for (const s of segs) if (s.kind === 'run') s.w = runWidth(s.books);
    return { segs, endGap };
  });

  const content = rowSegments.map(({ segs }) => segs.reduce((s, seg) => s + seg.w, 0));
  const shelfW = Math.max(MIN_SHELF_W, Math.max(...content) / (1 - ROW_SLACK));

  const placements = [];
  rowSegments.forEach(({ segs, endGap }, r) => {
    const free = shelfW - segs.reduce((s, seg) => s + seg.w, 0);
    const weights = new Array(segs.length + 1).fill(0);
    for (let j = 1; j < segs.length; j++) weights[j] = 1;
    if (segs.length && segs[0].kind !== 'run') weights[0] = 0.45;
    if (segs.length && segs[segs.length - 1].kind !== 'run') weights[segs.length] = 0.45;
    if (endGap === 'L') weights[0] = 1;
    else if (endGap === 'R') weights[segs.length] = 1;
    let sum = weights.reduce((a, b) => a + b, 0);
    if (!sum) { weights[segs.length] = 1; sum = 1; }
    const gaps = weights.map((w) => (free * w) / sum);
    for (let j = 1; j < segs.length; j++) {     // no wide holes between two runs of books
      if (segs[j - 1].kind === 'run' && segs[j].kind === 'run' && gaps[j] > 0.11) {
        gaps[segs.length] += gaps[j] - 0.11;
        gaps[j] = 0.11;
      }
    }

    if (opts.leaning) {
      for (let j = 0; j <= segs.length; j++) {
        if (gaps[j] < 0.03) continue;
        const left = j > 0 ? segs[j - 1] : null;
        const right = j < segs.length ? segs[j] : null;
        const options = [];
        if (left && left.kind === 'run' && left.books.length >= 3 && left.leanLast === undefined
            && left.books[left.books.length - 1].t < 0.045) options.push(['leanLast', left]);
        if (right && right.kind === 'run' && right.books.length >= 3 && right.leanFirst === undefined
            && right.books[0].t < 0.045) options.push(['leanFirst', right]);
        if (!options.length || rng.random() > 0.8) continue;
        const [key, seg] = rng.choice(options);
        const list = seg.books;
        const book = key === 'leanLast' ? list[list.length - 1] : list[0];
        const neighbour = key === 'leanLast' ? list[list.length - 2] : list[1];
        const angle = (rng.uniform(7, 17) * Math.PI) / 180;
        const extra = book.t * Math.cos(angle) + leanReach(book, neighbour.h, angle) - book.t;
        if (extra > gaps[j] - 0.012) continue;
        seg[key] = angle;
        seg.w += extra;
        gaps[j] -= extra;
      }
    }

    let x = 0;
    segs.forEach((seg, j) => {
      x += gaps[j];
      if (seg.kind === 'prop') {
        placements.push({ kind: 'prop', row: r, name: seg.name, scale: seg.scale, cx: x + seg.w / 2,
          rot: (rng.uniform(-10, 10) * Math.PI) / 180 });
      } else if (seg.kind === 'stack') {
        let z = 0;
        for (const book of seg.books.slice().sort((a, b) => b.h - a.h)) {
          placements.push({ kind: 'flat', row: r, book, lift: z,
            cx: x + seg.w / 2 + rng.uniform(-0.008, 0.008), rot: (rng.uniform(-5, 5) * Math.PI) / 180 });
          z += book.t + 0.0003;
        }
      } else {
        const run = seg.books;
        let cursor = x;
        run.forEach((book, i) => {
          if (i === 0 && seg.leanFirst !== undefined) {
            const angle = seg.leanFirst;
            const pivot = cursor + book.t * Math.cos(angle);
            placements.push({ kind: 'lean', row: r, book, pivot, angle });
            cursor = pivot + leanReach(book, run[1].h, angle);
          } else if (i === run.length - 1 && seg.leanLast !== undefined) {
            const angle = seg.leanLast;
            const pivot = cursor - BOOK_GAP + leanReach(book, run[run.length - 2].h, angle);
            placements.push({ kind: 'lean', row: r, book, pivot, angle: -angle });
            cursor = pivot + book.t * Math.cos(angle) + BOOK_GAP;
          } else {
            placements.push({ kind: 'up', row: r, book, x: cursor });
            cursor += book.t + BOOK_GAP;
          }
        });
      }
      x += seg.w;
    });
  });

  return { rows: nRows, shelfW, pitch, clearH, placements };
}

/** Break words into n lines so the longest line is as short as possible. */
export function splitLines(words, n) {
  if (n <= 1 || words.length <= 1) return [words.join(' ')];
  n = Math.min(n, words.length);
  let best = null;
  const cuts = [];
  const search = (start, left) => {
    if (left === 0) {
      const bounds = [0, ...cuts, words.length];
      const lines = bounds.slice(0, -1).map((a, i) => words.slice(a, bounds[i + 1]).join(' '));
      const longest = Math.max(...lines.map((l) => l.length));
      if (!best || longest < best.longest) best = { longest, lines };
      return;
    }
    for (let c = start; c <= words.length - left; c++) {
      cuts.push(c);
      search(c + 1, left - 1);
      cuts.pop();
    }
  };
  search(1, n - 1);
  return best.lines;
}
