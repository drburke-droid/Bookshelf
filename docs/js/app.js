// Page wiring: file upload, settings, and keeping the picture up to date.
import { readBooks, assignLooks, sortBooks, planLayout, hexToRgb } from './books.js';
import { BookshelfView } from './scene.js';
import { SCENES, WALLS, WOODS, LIGHTING } from './scenes.js';

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('canvas'), overlay: $('overlay'), status: $('status'), error: $('error'),
  file: $('file'), fileName: $('file-name'), drop: $('drop'), sample: $('sample'),
  download: $('download'), size: $('size'),
  shelf: $('shelf'), year: $('year'), limit: $('limit'), sort: $('sort'), reverse: $('reverse'),
  shape: $('shape'), style: $('style'), rows: $('rows'), palette: $('palette'), colorBy: $('color-by'),
  ratings: $('ratings'), ratingsHelp: $('ratings-help'),
  scene: $('scene'), wallType: $('wall-type'), wall: $('wall'), wood: $('wood'), lighting: $('lighting'),
  thickness: $('thickness'), seed: $('seed'), shuffle: $('shuffle'),
  titles: $('titles'), authors: $('authors'), shorten: $('shorten'), leaning: $('leaning'), stacks: $('stacks'),
  decor: $('decor'),
};

for (let n = 1; n <= 12; n++) el.rows.add(new Option(String(n), String(n)));
for (const [key, scene] of Object.entries(SCENES)) el.scene.add(new Option(scene.label, key));
for (const [key, label] of Object.entries(WALLS)) el.wallType.add(new Option(label, key));
for (const [key, wood] of Object.entries(WOODS)) el.wood.add(new Option(wood.label, key));
for (const [key, rig] of Object.entries(LIGHTING)) el.lighting.add(new Option(rig.label, key));

/** Fill in the individual settings from a named scene. */
function applyScene(key) {
  const scene = SCENES[key];
  if (!scene) return;
  el.wallType.value = scene.wall;
  el.wall.value = scene.wallColor;
  el.wood.value = scene.wood;
  el.lighting.value = scene.lighting;
  el.style.value = scene.style;
  el.palette.value = scene.palette;
}
applyScene(el.scene.value);

const state = { csv: null, source: '', years: [] };
let view = null;

function showOverlay(message) {
  el.overlay.textContent = message || '';
  el.overlay.hidden = !message;
}

function showError(message) {
  el.error.textContent = message || '';
  el.error.hidden = !message;
}

function settings() {
  return {
    shelf: el.shelf.value,
    year: parseInt(el.year.value, 10) || 0,
    limit: Math.max(0, parseInt(el.limit.value, 10) || 0),
    sort: el.sort.value,
    reverse: el.reverse.checked,
    aspect: parseFloat(el.shape.value),
    style: el.style.value,
    rows: parseInt(el.rows.value, 10) || 0,
    palette: el.palette.value,
    colorBy: el.colorBy.value,
    ratings: el.ratings.value,
    wallType: el.wallType.value,
    wall: hexToRgb(el.wall.value.slice(1)),
    wood: el.wood.value,
    lighting: el.lighting.value,
    thickness: parseFloat(el.thickness.value) || 1,
    seed: Math.max(1, parseInt(el.seed.value, 10) || 1),
    titles: el.titles.checked,
    authors: el.authors.checked,
    shorten: el.shorten.checked,
    leaning: el.leaning.checked,
    stacks: el.stacks.checked,
    decor: el.decor.checked,
  };
}

function fillYears(years) {
  if (years.join() === state.years.join()) return;
  state.years = years;
  const current = el.year.value;
  el.year.length = 1;
  for (const y of years) el.year.add(new Option(String(y), String(y)));
  el.year.value = years.includes(+current) ? current : '0';
}

function resizePreview() {
  if (!view) return;
  const aspect = parseFloat(el.shape.value);
  el.canvas.style.setProperty('--aspect', String(aspect));
  const shown = el.canvas.clientWidth || 800;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  view.setRenderSize(shown * scale, (shown * scale) / aspect);
}

function rebuild() {
  if (!view || state.csv === null) return;
  const opts = settings();
  let result;
  try {
    result = readBooks(state.csv, opts);
  } catch (err) {
    showError(err.message);
    return;
  }
  fillYears(result.years);
  let { books } = result;
  if (!books.length) {
    const c = result.counts;
    let why = `${c.total} rows found`;
    if (c.wrongShelf) why += `, ${c.wrongShelf} on other shelves (try Books: All)`;
    if (c.wrongYear) why += `, ${c.wrongYear} not read in ${opts.year}`;
    showError(`No books to show: ${why}.`);
    return;
  }
  showError('');
  assignLooks(books, opts);
  sortBooks(books, opts.sort, opts.reverse, opts.seed);
  if (opts.limit && books.length > opts.limit) {
    books = opts.sort === 'date' && !opts.reverse ? books.slice(-opts.limit) : books.slice(0, opts.limit);
  }
  // Showing ratings: top-rated books on the top shelf, or stars on the spines.
  if (opts.ratings === 'shelves') {
    opts.groups = [5, 4, 3, 2, 1, 0].map((n) => ({ label: n, books: books.filter((b) => b.stars === n) }));
  }
  const notes = {
    shelves: 'Five-star books go on the top shelf, then four, and so on. Each shelf is labelled.',
    stars: 'Your star rating is printed at the foot of each spine.',
  };
  let note = notes[opts.ratings] || '';
  if (note && !books.some((b) => b.stars > 0)) note = 'None of these books has a rating in your file.';
  el.ratingsHelp.textContent = note;
  el.ratingsHelp.hidden = !note;
  el.rows.disabled = opts.ratings === 'shelves';

  const plan = planLayout(books, opts, opts.decor ? view.propList() : [], opts.aspect);
  resizePreview();
  view.build(plan, opts);
  const noun = books.length === 1 ? 'book' : 'books';
  const shelves = plan.rows === 1 ? 'shelf' : 'shelves';
  el.status.textContent = `${books.length} ${noun} on ${plan.rows} ${shelves} · ${state.source}`;
}

let pending = 0;
function scheduleRebuild() {
  clearTimeout(pending);
  pending = setTimeout(rebuild, 120);
}

function decode(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

async function useFile(file) {
  if (!file) return;
  try {
    state.csv = decode(await file.arrayBuffer());
  } catch {
    showError('That file could not be read.');
    return;
  }
  state.source = file.name;
  el.fileName.textContent = file.name;
  el.year.value = '0';
  rebuild();
}

async function useSample() {
  try {
    const response = await fetch('sample.csv');
    if (!response.ok) throw new Error(String(response.status));
    state.csv = await response.text();
  } catch {
    showError('The sample list could not be loaded.');
    return;
  }
  state.source = 'sample list';
  el.fileName.textContent = 'Choose your CSV file';
  el.file.value = '';
  el.year.value = '0';
  rebuild();
}

async function download() {
  if (!view || state.csv === null) return;
  el.download.disabled = true;
  const label = el.download.textContent;
  try {
    const { blob, width, height } = await view.exportImage(parseInt(el.size.value, 10), 128, (done) => {
      el.download.textContent = `Rendering ${Math.round(done * 100)}%`;
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `bookshelf-${width}x${height}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  } catch (err) {
    showError(err.message || 'The picture could not be created.');
  } finally {
    el.download.textContent = label;
    el.download.disabled = false;
  }
}

// ---------------------------------------------------------------- events
el.file.addEventListener('change', () => useFile(el.file.files[0]));
el.sample.addEventListener('click', useSample);
el.download.addEventListener('click', download);
el.shuffle.addEventListener('click', () => {
  el.seed.value = String(1 + Math.floor(Math.random() * 9999));
  rebuild();
});
el.scene.addEventListener('input', () => { applyScene(el.scene.value); scheduleRebuild(); });
for (const key of ['shelf', 'year', 'limit', 'sort', 'reverse', 'shape', 'style', 'rows', 'palette', 'colorBy',
  'ratings', 'wallType', 'wall', 'wood', 'lighting', 'thickness', 'seed', 'titles', 'authors', 'shorten', 'leaning', 'stacks',
  'decor']) {
  el[key].addEventListener('input', scheduleRebuild);
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  useFile(e.dataTransfer.files[0]);
});
new ResizeObserver(resizePreview).observe(el.canvas);

// ---------------------------------------------------------------- start
async function start() {
  try {
    view = new BookshelfView(el.canvas);
  } catch {
    showOverlay('This browser could not start 3D graphics (WebGL), which the picture needs. '
      + 'Try a recent version of Chrome, Firefox, Safari or Edge.');
    el.status.textContent = '';
    return;
  }
  window.bookshelfView = view;        // handy for testing from the browser console
  resizePreview();
  await view.loadAssets();
  await useSample();
}
start();
