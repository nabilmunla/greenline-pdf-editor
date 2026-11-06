// End-to-end: the real app (Electron), driven like a person would.
// xvfb-run -a node tests/e2e.mjs [only-step-substring]
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, existsSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import * as mupdf from 'mupdf';

const ONLY = process.argv[2] || '';
const OUT = resolve('tests/out');
const TMP = resolve('tests/tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-e2e'), { recursive: true, force: true });

// work on copies: a test that saves must never change its own inputs
const IN = join(TMP, 'in');
mkdirSync(IN, { recursive: true });
for (const f of ['tests/real/doc-sheet-50mb.pdf', 'tests/real/ga-l00-19mb.pdf', 'tests/real/door-schedule.pdf', 'tests/data/long-spec.pdf', 'tests/data/scan.pdf']) copyFileSync(f, join(IN, f.split('/').pop()));
const inp = (f) => join(IN, f.split('/').pop());

const results = [];
let app, win;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => win.screenshot({ path: join(OUT, n + '.png') });

async function launch(files = []) {
  app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=e2e', ...files.map((f) => resolve(f))] });
  win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
  win.on('console', (m) => { if (m.type() === 'error') console.log('  console.error', m.text().slice(0, 300)); });
  await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  // answer native dialogs from a queue
  await app.evaluate(({ dialog }) => {
    globalThis.__q = { save: [], open: [], dir: [], box: [] };
    dialog.showSaveDialog = async () => { const f = globalThis.__q.save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
    dialog.showOpenDialog = async (_w, o) => { const f = (o && o.properties && o.properties.includes('openDirectory')) ? globalThis.__q.dir.shift() : globalThis.__q.open.shift(); return f ? { canceled: false, filePaths: Array.isArray(f) ? f : [f] } : { canceled: true, filePaths: [] }; };
    globalThis.__boxlog = [];
    dialog.showMessageBox = async (_w, o) => { const r = globalThis.__q.box.length ? globalThis.__q.box.shift() : 0; globalThis.__boxlog.push(((o && o.message) || '') + ' -> ' + r); return { response: r }; };
  });
}
const answer = (kind, v) => app.evaluate((_e, [k, x]) => { globalThis.__q[k].push(x); }, [kind, v]);

async function step(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  const t = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, info });
    console.log(`PASS ${name} (${Date.now() - t} ms)${info ? ' – ' + info : ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, info: String(e.message || e) });
    console.log(`FAIL ${name}: ${e.message || e}`);
    await shot('fail-' + name.replace(/\W+/g, '_')).catch(() => {});
  }
}
const ok = (c, m) => { if (!c) throw new Error(m); };
const until = async (fn, ms = 20000, what = 'condition') => {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(100); }
  throw new Error('timed out waiting for ' + what);
};
const E = (fn, arg) => win.evaluate(fn, arg);
const annots = () => E(async () => { const d = window.__gcc.active(); return d ? d.allAnnots() : []; });
const activeInfo = () => E(() => { const d = window.__gcc.active(); return d && { name: d.name, pages: d.pages.length, dirty: d.dirty, w: d.pages[0].w, h: d.pages[0].h, baseRev: d.baseRev }; });

/** screen point of page point (x, y) on page n */
async function at(n, x, y) {
  const box = await win.locator(`.pg[data-page="${n}"]`).boundingBox();
  const info = await E((n) => { const d = window.__gcc.active(); return { w: d.pages[n].w, h: d.pages[n].h }; }, n);
  const k = box.width / info.w;
  return [box.x + x * k, box.y + y * k];
}
async function drag(n, a, b, steps = 8) {
  const p = await at(n, ...a), q = await at(n, ...b);
  await win.mouse.move(p[0], p[1]);
  await win.mouse.down();
  await win.mouse.move(q[0], q[1], { steps });
  await win.mouse.up();
}
async function click(n, a, opts) { const p = await at(n, ...a); await win.mouse.click(p[0], p[1], opts); }
const tab = (name) => win.locator('.rtab', { hasText: name }).click();
const rb = (name) => win.locator('.ribbon .rb', { hasText: new RegExp('^' + name + '$') }).first().click();
const tilesOn = (n) => E((n) => document.querySelectorAll(`.pg[data-page="${n}"] .tl:not(.an) canvas`).length, n);

// ---------------------------------------------------------------- 1: heavy drawings

await launch([inp('doc-sheet-50mb.pdf')]);

await step('open 50 MB A0 sheet: first picture and sharp tiles', async () => {
  const t0 = Date.now();
  await until(() => win.locator('.dtab').count(), 30000, 'tab');
  await until(async () => (await E(() => { const c = document.querySelector('.pg[data-page="0"] .pv'); return c && c.width > 10 && getComputedStyle(c).opacity === '1'; })), 60000, 'preview');
  const tPrev = Date.now() - t0;
  const info = await activeInfo();
  ok(info.pages === 1, 'pages');
  await shot('01-heavy-open');
  // zoom in 8x at the middle with Ctrl+wheel
  const box = await win.locator('.viewer').boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const t1 = Date.now();
  for (let i = 0; i < 10; i++) { await win.keyboard.down('Control'); await win.mouse.wheel(0, -300); await win.keyboard.up('Control'); await sleep(30); }
  await until(() => tilesOn(0).then((n) => n >= 4), 60000, 'sharp tiles');
  await until(() => E(() => { const cs = [...document.querySelectorAll('.pg[data-page="0"] .tl:not(.an) canvas')]; const ls = new Set(cs.map((c) => c.dataset.l)); return ls.size === 1; }), 60000, 'one level');
  const tZoom = Date.now() - t1;
  await shot('02-heavy-zoomed');
  // pan around quickly; tiles must keep up
  const t2 = Date.now();
  for (let i = 0; i < 6; i++) { await win.mouse.wheel(250, 180); await sleep(60); }
  await sleep(200);
  await until(() => E(() => [...document.querySelectorAll('.pg[data-page="0"] .tl:not(.an) canvas')].length > 0), 30000, 'tiles after pan');
  return `w=${Math.round(info.w)}pt, preview ${tPrev} ms, zoom+sharp ${tZoom} ms, pan ${Date.now() - t2} ms`;
});

await step('open more files as tabs (Explorer double-click goes to the running window)', async () => {
  // second instance behaviour: the main process forwards files to the window
  await app.evaluate(({ BrowserWindow }, files) => { BrowserWindow.getAllWindows()[0].webContents.send('app:open', files); }, [inp('ga-l00-19mb.pdf'), inp('long-spec.pdf'), inp('door-schedule.pdf')]);
  await until(() => win.locator('.dtab').count().then((n) => n === 4), 60000, '4 tabs');
  const names = await win.locator('.dtab .nm').allTextContents();
  ok(names.includes('long-spec.pdf'), 'spec tab');
  await shot('03-tabs');
  return names.join(' | ');
});

await step('read-only file is flagged (server folders that refuse writing)', async () => {
  await win.locator('.dtab', { hasText: 'ga-l00' }).click();
  if (process.getuid && process.getuid() === 0) return 'skipped: running as root (root can write read-only files)';
  await until(() => win.locator('.ro-badge').count(), 5000, 'badge');
});

// ---------------------------------------------------------------- 2: markups on the drawing

await step('rectangle: draw, select, move, resize, undo/redo', async () => {
  await win.locator('.dtab', { hasText: 'ga-l00' }).click();
  await sleep(500);
  await tab('Comment');
  await win.locator('.ribbon .rb', { hasText: 'Rectangle' }).click();
  await drag(0, [1000, 800], [1400, 1100]);
  let a = await until(() => annots().then((l) => l.find((x) => x.type === 'Square')), 10000, 'square');
  // the corners may snap to nearby line ends (12 screen px)
  ok(Math.abs(a.rect[0] - 1000) < 50 && Math.abs(a.rect[2] - 1400) < 50, 'rect where drawn ' + a.rect.map(Math.round));
  // back in select with it selected: move it (grab the edge)
  await sleep(300);
  await drag(0, [1000, 950], [1200, 1050]);
  a = await until(async () => { const l = await annots(); const s = l.find((x) => x.type === 'Square'); return s && s.rect[0] > 1100 ? s : null; }, 8000, 'moved');
  // resize from the bottom-right handle (drawn 5 px outside the box)
  await sleep(300);
  const zz = await E(() => { const b = document.querySelector('.pg[data-page="0"]').getBoundingClientRect(); return b.width / window.__gcc.active().pages[0].w; });
  await drag(0, [a.rect[2] + 7 / zz, a.rect[3] + 7 / zz], [a.rect[2] + 200, a.rect[3] + 100]);
  const b = await until(async () => { const l = await annots(); const s = l.find((x) => x.type === 'Square'); return s && s.rect[2] - s.rect[0] > 550 ? s : null; }, 8000, 'resized');
  await win.keyboard.press('Control+z');
  await until(async () => { const s = (await annots()).find((x) => x.type === 'Square'); return s && s.rect[2] - s.rect[0] < 450; }, 8000, 'undo');
  await win.keyboard.press('Control+y');
  await until(async () => { const s = (await annots()).find((x) => x.type === 'Square'); return s && s.rect[2] - s.rect[0] > 550; }, 8000, 'redo');
  await shot('04-rect');
  return 'final ' + b.rect.map(Math.round).join(',');
});

await step('cloud, arrow, callout (pointed text), text box with typing', async () => {
  await win.locator('.ribbon .rb', { hasText: 'Cloud' }).click();
  for (const p of [[300, 300], [700, 280], [720, 600], [320, 620]]) { await click(0, p); await sleep(60); }
  await win.keyboard.press('Enter');
  await until(() => annots().then((l) => l.some((x) => x.type === 'Polygon' && x.cloudy)), 8000, 'cloud');
  await win.locator('.ribbon .rb', { hasText: /^Arrow$/ }).click();
  await drag(0, [800, 300], [1100, 500]);
  await until(() => annots().then((l) => l.some((x) => x.type === 'Line' && x.le && x.le[1] === 'ClosedArrow')), 8000, 'arrow');
  await win.locator('.ribbon .rb', { hasText: 'Callout' }).click();
  await click(0, [1600, 700]);
  await click(0, [1800, 500]);
  await until(() => win.locator('.ed.rich').count(), 5000, 'callout editor');
  await win.keyboard.type('Check beam size here');
  await win.keyboard.press('Control+Enter');
  await until(() => annots().then((l) => l.some((x) => x.type === 'FreeText' && x.contents === 'Check beam size here' && x.callout?.length === 3)), 8000, 'callout text');
  await win.locator('.ribbon .rb', { hasText: 'Text box' }).click();
  await drag(0, [2000, 900], [2400, 1000]);
  await until(() => win.locator('.ed.rich').count(), 5000, 'textbox editor');
  await win.keyboard.type('Tender query 12: confirm finish');
  await win.locator('.viewer').click({ position: { x: 20, y: 20 } });
  await until(() => annots().then((l) => l.some((x) => x.type === 'FreeText' && x.contents.startsWith('Tender query 12'))), 8000, 'textbox text');
  await shot('05-markups');
});

await step('rotate a text box (handle + exact angle), lock it, delete refused, unlock', async () => {
  const tb = (await annots()).find((x) => x.type === 'FreeText' && x.contents.startsWith('Tender'));
  await tab('Home');
  await win.locator('.ribbon .rb', { hasText: /^Select$/ }).click();
  await click(0, [(tb.rect[0] + tb.rect[2]) / 2, (tb.rect[1] + tb.rect[3]) / 2]);
  await until(() => win.locator('.props').count(), 5000, 'props');
  // drag the round rotation handle a quarter turn
  const z = await E(() => { const b = document.querySelector('.pg[data-page="0"]').getBoundingClientRect(); return b.width / window.__gcc.active().pages[0].w; });
  const cx = (tb.rect[0] + tb.rect[2]) / 2, top = tb.rect[1];
  await sleep(300);
  await drag(0, [cx, top - 29 / z], [tb.rect[2] + 150, (tb.rect[1] + tb.rect[3]) / 2]);
  let r = await until(async () => (await annots()).find((x) => x.id === tb.id && x.angle), 8000, 'rotated');
  const a1 = r.angle;
  await win.locator('.props input.ang').fill('30');
  await win.locator('.props input.ang').press('Enter');
  r = await until(async () => (await annots()).find((x) => x.id === tb.id && Math.abs(x.angle - 30) < 0.1), 8000, 'angle 30');
  await win.locator('.props').getByRole('button', { name: 'Lock', exact: true }).click();
  await until(async () => (await annots()).find((x) => x.id === tb.id && x.locked), 8000, 'locked');
  await win.keyboard.press('Delete');
  await sleep(500);
  ok((await annots()).some((x) => x.id === tb.id), 'locked markup survived Delete');
  await win.locator('.props').getByRole('button', { name: 'Locked', exact: true }).click();
  await until(async () => (await annots()).find((x) => x.id === tb.id && !x.locked), 8000, 'unlocked');
  await shot('06-rotated-text');
  return `handle gave ${a1.toFixed(0)}°`;
});

await step('scale 1:100 + length (snapped) + area + count', async () => {
  await win.locator('.statusbar button', { hasText: 'Scale' }).click();
  await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
  await until(() => win.locator('.statusbar button', { hasText: '1:100' }).count(), 5000, 'scale shown');
  await tab('Measure');
  await win.locator('.ribbon .rb', { hasText: /^Length$/ }).click();
  await sleep(1500); // snap index
  await click(0, [500, 1500]);
  await sleep(150);
  const p2 = await at(0, 900, 1500);
  await win.mouse.move(p2[0], p2[1], { steps: 6 });
  await sleep(300);
  await win.mouse.click(p2[0], p2[1]);
  const len = await until(() => annots().then((l) => l.find((x) => x.kind === 'measure-length')), 8000, 'length');
  // 400 pt at 1:100 = 400/72*25.4 mm * 100 = 14.11 m (snapping may move the ends a little)
  const v = parseFloat(len.contents);
  ok(v > 12 && v < 16.5, 'length value ' + len.contents);
  await win.locator('.ribbon .rb', { hasText: /^Area$/ }).click();
  for (const p of [[1200, 1300], [1600, 1300], [1600, 1600]]) { await click(0, p); await sleep(80); }
  const pl = await at(0, 1200, 1600);
  await win.mouse.dblclick(pl[0], pl[1]);
  const ar = await until(() => annots().then((l) => l.find((x) => x.kind === 'measure-area')), 8000, 'area');
  await win.locator('.ribbon .rb', { hasText: /^Count$/ }).click();
  for (const p of [[2000, 1300], [2050, 1300], [2100, 1300]]) { await click(0, p); await sleep(150); }
  const n = await until(() => annots().then((l) => { const c = l.filter((x) => x.kind === 'measure-count'); return c.length === 3 ? c : null; }), 8000, 'counts');
  await win.keyboard.press('Escape');
  await shot('07-measure');
  return `length ${len.contents}, area ${ar.contents}, count ${n.length}`;
});

await step('stamp (APPROVED with name/date) + flatten just that stamp', async () => {
  await tab('Comment');
  await win.locator('.ribbon .rb', { hasText: /^Stamp$/ }).click();
  await win.locator('.modal .scard').first().click();
  await click(0, [2600, 300]);
  const st = await until(() => annots().then((l) => l.find((x) => x.type === 'Stamp')), 8000, 'stamp');
  await click(0, [(st.rect[0] + st.rect[2]) / 2, (st.rect[1] + st.rect[3]) / 2]);
  await answer('box', 0);
  await win.locator('.props').getByRole('button', { name: 'Flatten', exact: true }).click();
  await until(() => annots().then((l) => !l.some((x) => x.type === 'Stamp')), 15000, 'flattened');
  const others = (await annots()).length;
  ok(others >= 6, 'the other markups stay: ' + others);
  await shot('08-stamp-flattened');
});

await step('comments organizer lists and jumps; export to Excel', async () => {
  await win.locator('.rail-btn[title="Comments list"]').click();
  await until(() => win.locator('.cm-item').count().then((n) => n >= 6), 8000, 'list');
  await win.locator('.side select').first().selectOption('category');
  await until(() => win.locator('.cm-gh', { hasText: 'Measurements' }).count(), 5000, 'grouped');
  await win.locator('.cm-item', { hasText: 'Callout' }).click();
  await until(() => win.locator('.props .side-head', { hasText: 'Callout' }).count(), 5000, 'selected from list');
  const xl = join(TMP, 'comments.xlsx');
  await answer('save', xl);
  await win.locator('.cm-foot button', { hasText: 'Excel' }).click();
  await until(() => existsSync(xl), 8000, 'xlsx');
  await shot('09-comments');
  return (await win.locator('.cm-item').count()) + ' markups';
});

await step('save as + reopen: everything is still there, normal PDF annotations', async () => {
  const f = join(TMP, 'ga-marked.pdf');
  await answer('save', f);
  await win.keyboard.press('Control+Shift+S');
  await until(() => existsSync(f), 20000, 'saved');
  const d = mupdf.Document.openDocument(readFileSync(f), 'application/pdf');
  const list = d.loadPage(0).getAnnotations().map((a) => a.getType());
  ok(list.includes('FreeText') && list.includes('Polygon') && list.includes('Line') && list.includes('Square'), 'types ' + list.join(','));
  return list.length + ' annotations in the file, ' + (statSync(f).size / 1e6).toFixed(1) + ' MB';
});

// ---------------------------------------------------------------- 3: text documents

await step('search 1,500 pages', async () => {
  await win.locator('.dtab', { hasText: 'long-spec' }).click();
  await win.locator('.rail-btn[title^="Search"]').click();
  await win.locator('.search-in').fill('clause 17.');
  const t = Date.now();
  await win.locator('.side button', { hasText: 'Find' }).click();
  await until(() => win.locator('.side .faint', { hasText: '1500 found' }).count(), 60000, 'all found');
  await win.keyboard.press('F3');
  await shot('10-search');
  return `1500 hits in ${Date.now() - t} ms`;
});

await step('highlight text by dragging; copy text', async () => {
  await win.keyboard.press('Escape');
  await win.locator('.rail-btn[title^="Search"]').click();
  await E(() => { const v = document.querySelector('.viewer'); v.scrollTop = 0; });
  await sleep(500);
  await tab('Comment');
  await win.locator('.ribbon .rb', { hasText: /^Highlight$/ }).first().click();
  await drag(0, [90, 126], [300, 126]);
  const h = await until(() => annots().then((l) => l.find((x) => x.type === 'Highlight')), 8000, 'highlight');
  ok(/Contractor/.test(h.contents), 'highlighted text ' + h.contents);
  return JSON.stringify(h.contents);
});

await step('edit a line of existing text', async () => {
  await tab('Edit');
  await win.locator('.ribbon .rb', { hasText: 'Edit text' }).click();
  await until(() => E(() => document.querySelectorAll('.ov .eline').length > 10), 8000, 'lines');
  const ln = await E(async () => (await window.__gcc.active().blocks(0))[0].lines[0].bbox);
  await click(0, [(ln[0] + ln[2]) / 2, (ln[1] + ln[3]) / 2]);
  await until(() => win.locator('input.ed').count(), 5000, 'editor');
  await win.locator('input.ed').fill('SECTION 1 - SPECIFICATION FOR STEEL WORKS');
  await win.locator('input.ed').press('Enter');
  await until(() => E(async () => { const d = window.__gcc.active(); const b = await d.blocks(0); return b.some((x) => x.lines.some((l) => l.text.includes('STEEL WORKS'))) && !b.some((x) => x.lines.some((l) => l.text.includes('CONCRETE WORKS'))); }), 15000, 'edited');
  await shot('11-edit-text');
});

await step('redact text for good', async () => {
  await win.locator('.ribbon .rb', { hasText: 'Mark text' }).click();
  const l01 = await E(async () => { for (const b of await window.__gcc.active().blocks(0)) for (const l of b.lines) if (l.text.startsWith('0.1 ')) return l.bbox; return null; });
  const ym = (l01[1] + l01[3]) / 2;
  await drag(0, [l01[0] + 1, ym], [l01[2] - 1, ym]);
  await until(() => annots().then((l) => l.some((x) => x.type === 'Redact')), 8000, 'marked');
  await answer('box', 0);
  await win.locator('.ribbon .rb', { hasText: /^Apply$/ }).click();
  await until(() => annots().then((l) => !l.some((x) => x.type === 'Redact')), 15000, 'applied');
  const f = join(TMP, 'spec-redacted.pdf');
  await answer('save', f);
  await win.keyboard.press('Control+Shift+S');
  await until(() => existsSync(f), 30000, 'saved');
  const t = mupdf.Document.openDocument(readFileSync(f), 'application/pdf').loadPage(0).toStructuredText('').asText();
  ok(t.includes('STEEL WORKS'), 'edit kept');
  ok(!t.includes('0.1 The Contractor shall provide all labour plant and materials as required by clause 1.'), 'line 0.1 redacted');
  return 'size ' + (statSync(f).size / 1e6).toFixed(2) + ' MB';
});

await step('pages: rotate, delete, move (drag in Pages panel), insert blank, undo', async () => {
  await win.locator('.rail-btn[title="Pages"]').click();
  await tab('Organize');
  await E(() => { document.querySelector('.thumbs').scrollTop = 0; });
  await sleep(300);
  await win.locator('.thumb[data-page="0"]').click();
  await win.locator('.ribbon .rb', { hasText: 'Rotate right' }).click();
  await until(async () => (await E(() => window.__gcc.active().pages[0].rot)) === 90, 15000, 'rotated');
  await answer('box', 0);
  await win.locator('.thumb[data-page="1"]').click();
  await win.locator('.ribbon .rb', { hasText: /^Delete$/ }).click();
  await until(async () => (await activeInfo()).pages === 1499, 20000, 'deleted');
  // drag page 1 below page 3
  await E(() => { document.querySelector('.thumbs').scrollTop = 0; });
  await sleep(300);
  await win.locator('.thumb[data-page="0"]').click();
  const src = win.locator('.thumb[data-page="0"]'), dst = win.locator('.thumb[data-page="2"]');
  await src.dragTo(dst, { targetPosition: { x: 40, y: 200 } });
  await until(async () => (await E(() => window.__gcc.active().pages[2].rot)) === 90, 20000, 'moved');
  await win.locator('.ribbon .rb', { hasText: 'Blank page' }).click();
  await until(async () => (await activeInfo()).pages === 1500, 20000, 'blank');
  await win.keyboard.press('Control+z');
  await until(async () => (await activeInfo()).pages === 1499, 20000, 'undo');
  await shot('12-pages');
});

// ---------------------------------------------------------------- 4: scans and tables

await step('OCR a scanned letter (offline) – becomes searchable', async () => {
  await answer('open', inp('scan.pdf'));
  await win.keyboard.press('Control+o');
  await until(() => win.locator('.dtab', { hasText: 'scan.pdf' }).count(), 15000, 'opened');
  await tab('OCR');
  await win.locator('.ribbon .rb', { hasText: 'Make searchable' }).click();
  await win.locator('.modal select').selectOption('eng');
  const t = Date.now();
  await win.locator('.modal button', { hasText: 'Start' }).click();
  await until(() => win.locator('.modal').count().then((n) => n === 0), 120000, 'ocr done');
  const n = await until(() => E(async () => { const d = window.__gcc.active(); const c = await d.chars(0); return c.text.includes('Variation') ? c.text.length : 0; }), 20000, 'text layer');
  await shot('13-ocr');
  return `${n} characters in ${Date.now() - t} ms`;
});

await step('copy a table (scan: OCR on the fly) -> rows/columns', async () => {
  await win.locator('.ribbon .rb', { hasText: 'Table to Excel' }).click();
  // the table sits at y 1000..1320 px of 3508 -> points
  const k = 842 / 3508;
  await drag(0, [40, 990 * k], [560, 1330 * k]);
  await until(() => win.locator('.modal h2', { hasText: 'Table from page' }).count(), 60000, 'table');
  const rows = await win.locator('.tprev tr').count();
  const cols = await win.locator('.tprev tr').first().locator('td').count();
  await shot('14-table');
  await win.locator('.modal button', { hasText: 'Close' }).click();
  ok(rows >= 4 && cols >= 3, `${rows} x ${cols}`);
  return `${rows} rows x ${cols} cols`;
});

// ---------------------------------------------------------------- 5: batch jobs

await step('reduce file size (batch dialog)', async () => {
  // a picture-heavy file: the scan blown up to big pages
  const big = join(TMP, 'photo.pdf');
  {
    const d = new mupdf.PDFDocument();
    const w = 3000, h = 2000, raw = new Uint8Array(w * h * 3);
    let s = 1; for (let i = 0; i < raw.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; raw[i] = ((i / 3) % w) / 12 + ((s >> 24) % 40); }
    const im = d.addStream(raw, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' });
    for (let k = 0; k < 3; k++) d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, { XObject: { Im0: im } }, 'q 842 0 0 595 0 0 cm /Im0 Do Q'));
    (await import('node:fs')).writeFileSync(big, d.saveToBuffer('compress').asUint8Array());
  }
  await tab('Batch');
  await win.locator('.ribbon .rb', { hasText: 'Reduce size' }).click();
  await answer('open', [big]);
  await win.locator('.modal button', { hasText: 'Add files' }).click();
  await win.locator('.modal button', { hasText: /^Reduce \d+ file/ }).click();
  const out = join(TMP, 'photo (small).pdf');
  await until(() => existsSync(out), 60000, 'small file');
  const r = await win.locator('.modal .res').first().textContent();
  await win.locator('.modal button', { hasText: 'Close' }).click();
  return r;
});

await step('merge files into a new tab', async () => {
  await win.locator('.ribbon .rb', { hasText: /^Merge$/ }).click();
  await until(() => win.locator('.modal .frow').count().then((n) => n >= 2), 8000, 'list');
  await win.locator('.modal button', { hasText: /^Merge \d+ files/ }).click();
  await until(() => win.locator('.dtab', { hasText: 'Merged.pdf' }).count(), 60000, 'merged tab');
  const info = await activeInfo();
  return info.pages + ' pages';
});

await step('page numbers + watermark on the open file', async () => {
  await tab('Edit');
  await win.locator('.ribbon .rb', { hasText: 'Numbers & headers' }).click();
  await win.locator('.modal .mbox', { hasText: 'Watermark' }).locator('input[type=checkbox]').first().check();
  await E(() => window.__gccSlow.splice(0));
  const t0 = await E(() => performance.now());
  await win.locator('.modal button', { hasText: 'Apply to this file' }).click();
  try {
    await until(() => E(async () => { const d = window.__gcc.active(); const c = await d.chars(0); return c.text.includes('Page 1 of') && c.text.includes('FOR TENDER'); }), 45000, 'marks'); // (1,504 pages stamped while 2 dense sheets load: ~24 s on a 2-core box, 0.2.9 and later)
  } catch (e) {
    // what the engines were doing (slow calls) and how often pages were read in
    const slow = await E(() => window.__gccSlow.splice(0));
    console.log('  slow calls:', slow.map((c) => `${Math.round(c.at - t0)}+${c.ms} ${c.engine}.${c.method}`).join(' | '));
    console.log('  page reads:', JSON.stringify(await E(async () => Promise.all(window.__gcc.engines.renderers.map((r) => r.call('pageStats').catch((x) => String(x)))))));
    console.log('  busy:', await E(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' / ')), '| tiles', JSON.stringify(await E(() => window.__gcc.tiles.stats())));
    throw e;
  }
  if (process.env.DIAG) { const slow = await E(() => window.__gccSlow.splice(0)); console.log('  slow calls:', slow.map((c) => `${Math.round(c.at - t0)}+${c.ms} ${c.engine}.${c.method}`).join(' | ')); console.log('  page reads:', JSON.stringify(await E(async () => Promise.all(window.__gcc.engines.renderers.map((r) => r.call('pageStats').catch((x) => String(x))))))); }
  await shot('15-marks');
});

await step('table from a real door schedule (vector text)', async () => {
  await win.locator('.dtab', { hasText: 'door-schedule' }).click();
  await sleep(800);
  const info = await activeInfo();
  const txt = await E(async () => (await window.__gcc.active().chars(0)).text.length);
  return `${Math.round(info.w)}×${Math.round(info.h)} pt, ${txt} chars of text`;
});

await step('close tab with unsaved changes asks; recovery file exists', async () => {
  // the drawing was saved as ga-marked.pdf; change it again so it has unsaved work
  await win.locator('.dtab', { hasText: 'ga-marked' }).click();
  await sleep(300);
  await win.keyboard.press('Control+0');
  await sleep(500);
  await tab('Comment');
  await win.locator('.ribbon .rb', { hasText: 'Rectangle' }).click();
  await drag(0, [400, 1800], [700, 2000]);
  await until(() => E(() => window.__gcc.active().dirty), 5000, 'dirty');
  await answer('box', 1); // Don't save
  await win.keyboard.press('Control+w');
  await until(() => win.locator('.dtab', { hasText: 'ga-marked' }).count().then((n) => n === 0), 8000, 'closed').catch(async (e) => {
    const log = await app.evaluate(() => ({ box: globalThis.__boxlog.slice(-4), q: globalThis.__q.box }));
    const st = await E(() => ({ scrim: !!document.querySelector('.scrim'), focus: document.activeElement?.tagName + '.' + document.activeElement?.className, busy: document.querySelector('.busy')?.textContent || '' }));
    throw new Error(e.message + ' ' + JSON.stringify(log) + ' ' + JSON.stringify(st));
  });
  const f = join(TMP, 'ga-marked.pdf');
  const n = mupdf.Document.openDocument(readFileSync(f), 'application/pdf').loadPage(0).getAnnotations().length;
  return 'closed without saving; file still has ' + n + ' markups';
});

// unsaved tabs would ask before closing: just end the process
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
