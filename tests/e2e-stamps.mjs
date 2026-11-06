// Stamps (0.7): a stamp taken from a scanned page (paper removed, straightened, its ink colour,
// real size), saved and placed; picture stamps keep their proportions when resized (a tester's
// video); copy to all pages (same spot from the nearest corner, one undo); a stamp from a photo
// file; a signature from a scan. xvfb-run -a node tests/e2e-stamps.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-stamps');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const until = async (fn, ms = 10000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };

// a "scanned" letter: yellowish paper, black text, a blue stamp turned 5 degrees over the text
// (stamp: 200 x 80 pt); page 2 plain A4, page 3 A3 landscape
{
  const d = new mupdf.PDFDocument();
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const bold = d.addSimpleFont(new mupdf.Font('Helvetica-Bold'));
  const res = d.addObject({ Font: { F1: font, F2: bold } });
  let c = '0.95 0.92 0.83 rg 0 0 595 842 re f\n0 0 0 rg\n';
  for (let i = 0; i < 24; i++) c += `BT /F1 11 Tf 50 ${780 - i * 22} Td (The Contractor shall provide all labour, plant and materials - clause ${i}.) Tj ET\n`;
  // the stamp, centred at (300, 520), turned 5 degrees clockwise on screen (= -5 in PDF space)
  const a = (-5 * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
  c += `q ${co.toFixed(5)} ${si.toFixed(5)} ${(-si).toFixed(5)} ${co.toFixed(5)} 300 520 cm 0.1 0.25 0.7 RG 0.1 0.25 0.7 rg 3 w -100 -40 200 80 re S 1 w -94 -34 188 68 re S\n`;
  c += 'BT /F2 26 Tf -74 2 Td (APPROVED) Tj ET BT /F2 9 Tf -62 -22 Td (SAMPLE CONTRACTOR LLC) Tj ET Q\n';
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, res, c));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  d.insertPage(-1, d.addPage([0, 0, 1191, 842], 0, {}, ''));
  writeFileSync(join(TMP, 'letter.pdf'), d.saveToBuffer('').asUint8Array());
}
// a photo of a red round seal: a picture file (PNG, 300 dpi in its header)
{
  const d = new mupdf.PDFDocument();
  const bold = d.addSimpleFont(new mupdf.Font('Helvetica-Bold'));
  const res = d.addObject({ Font: { F2: bold } });
  const k = 0.5523;
  const circle = (r) => `${r} 0 m ${r} ${r * k} ${r * k} ${r} 0 ${r} c ${-r * k} ${r} ${-r} ${r * k} ${-r} 0 c ${-r} ${-r * k} ${-r * k} ${-r} 0 ${-r} c ${r * k} ${-r} ${r} ${-r * k} ${r} 0 c S`;
  const c = `0.93 0.9 0.84 rg 0 0 200 200 re f q 1 0 0 1 100 100 cm 0.75 0.12 0.12 RG 0.75 0.12 0.12 rg 3 w ${circle(70)} 1 w ${circle(60)} BT /F2 14 Tf -36 -5 Td (SEAL LLC) Tj ET Q`;
  d.insertPage(-1, d.addPage([0, 0, 200, 200], 0, res, c));
  const pix = d.loadPage(0).toPixmap([300 / 72, 0, 0, 300 / 72, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  pix.setResolution(300, 300);
  writeFileSync(join(TMP, 'seal.png'), pix.asPNG());
}

const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-stamps');
rmSync(PROFILE, { recursive: true, force: true });
const settings = () => JSON.parse(readFileSync(join(PROFILE, 'settings.json'), 'utf8'));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=stamps'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
const [WW, WH] = (process.env.WIN || '1600x1000').split('x').map(Number);
await app.evaluate(({ BrowserWindow }, [w, h]) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(w, h); }, [WW, WH]);
await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
if (process.env.DARK) await win.locator('.tb-btn[title="Dark theme"]').click().catch(() => {});
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'letter.pdf'));
await until(() => win.evaluate(() => window.__gcc.active()?.pages.length === 3), 20000, 'open');
await sleep(1200);
const E = (fn, a) => win.evaluate(fn, a);
const annots = (p = 0) => E(async (pg) => window.__gcc.active().annots(pg), p);
const pagePt = async (page, x, y) => {
  if (!(await win.locator(`.pg[data-page="${page}"]`).count())) { await E((p) => window.__gcc.viewer().goTo(p), page); await sleep(800); }
  const box = await win.locator(`.pg[data-page="${page}"]`).boundingBox();
  const w = await E((p) => window.__gcc.active().pages[p].w, page);
  const k = box.width / w;
  return [box.x + x * k, box.y + y * k];
};
const drag = async (a, b) => { await win.mouse.move(a[0], a[1]); await win.mouse.down(); await win.mouse.move(b[0], b[1], { steps: 8 }); await win.mouse.up(); };
/** the cleaned stamp in the dialog: size, share see-through, share blue among the solid pixels */
const result = () => E(() => {
  const c = document.querySelector('.sscan-out canvas');
  if (!c || !c.width) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let clear = 0, solid = 0, blue = 0, red = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 10) clear++; else if (d[i + 3] > 200) { solid++; if (d[i + 2] > d[i] + 60) blue++; if (d[i] > d[i + 2] + 60) red++; } }
  return { w: c.width, h: c.height, clear: clear / (c.width * c.height), blue: blue / Math.max(1, solid), red: red / Math.max(1, solid), solid };
});

// 1. Stamp from page: a box round the stamp (and a good part of the text round it)
await win.locator('.rtab', { hasText: 'Comment' }).click();
await win.locator('.ribbon [data-cmd="Stamp"]').first().click();
await win.locator('.scard', { hasText: 'From a page' }).click();
// page space: y down; the stamp's centre is at (300, 842 - 520 = 322)
await drag(await pagePt(0, 160, 240), await pagePt(0, 440, 405));
await win.locator('.modal h2', { hasText: 'Stamp from a scan' }).waitFor({ timeout: 15000 });
let r = await until(result, 20000, 'cleaned');
await sleep(800);
r = await result();
if (process.env.SHOTS) await win.screenshot({ path: join(process.env.SHOTS, 'scan-dialog.png') });
ok(r.w / r.h > 2 && r.w / r.h < 2.9, `straightened and cropped to the stamp: ${r.w} x ${r.h}`);
ok(r.clear > 0.55 && r.blue > 0.9, `paper and black text gone (${Math.round(r.clear * 100)}% see-through), the ink blue (${Math.round(r.blue * 100)}%)`);
ok(await win.locator('.sscan-ctl label', { hasText: /Straightened by 5/ }).count() === 1, 'it says it was straightened by 5 degrees');
const mm = Number(await win.locator('.sscan-ctl input[inputmode=decimal]').inputValue());
ok(Math.abs(mm - 71) < 5, `real size from the page: ${mm} mm wide (drawn 200 pt = 70.6 mm)`);
// colour: red, then back to its ink; clean-up slider; the picture as scanned
await win.locator('.sscan-ctl .seg button', { hasText: 'Red' }).click();
await until(async () => (await result())?.red > 0.9, 8000, 'red');
ok(true, 'colour changed to red');
await win.locator('.sscan-ctl .seg button', { hasText: 'Its ink' }).click();
await until(async () => (await result())?.blue > 0.9, 8000, 'blue again');
// 2. saved and placed
await win.locator('.sscan-ctl input:not([type])').last().fill('Approved – GC');
await win.locator('.modal .actions button', { hasText: 'Save & place' }).click();
await until(() => E(() => !document.querySelector('.modal')), 8000, 'dialog closed');
await win.mouse.click(...(await pagePt(1, 300, 400)));
const st = await until(async () => (await annots(1)).find((a) => a.type === 'Stamp'), 8000, 'placed');
const sw = st.rect[2] - st.rect[0], sh = st.rect[3] - st.rect[1];
ok(Math.abs(sw - 200) < 15 && sw / sh > 2 && sw / sh < 2.9, `placed at its real size and shape: ${sw.toFixed(0)} x ${sh.toFixed(0)} pt`);
ok((settings().stamps || []).some((x) => x.name === 'Approved – GC' && /^data:image\/png/.test(x.image)), 'kept in Your stamps');

// 3. resized from a corner: keeps its shape (the box was squashed to 3.8 : 1 before - a tester's video)
await win.keyboard.press('Escape');
await win.mouse.click(...(await pagePt(1, (st.rect[0] + st.rect[2]) / 2, (st.rect[1] + st.rect[3]) / 2)));
await sleep(400);
const hd = win.locator('.hd').nth(2);
const hb = await hd.boundingBox().catch(() => null);
if (hb) {
  await drag([hb.x + hb.width / 2, hb.y + hb.height / 2], [hb.x + hb.width / 2 + 120, hb.y + hb.height / 2 - 60]);
  await sleep(800);
  const st2 = (await annots(1)).find((a) => a.id === st.id);
  const r2 = (st2.rect[2] - st2.rect[0]) / (st2.rect[3] - st2.rect[1]);
  ok(Math.abs(r2 - sw / sh) < 0.08 && st2.rect[2] - st2.rect[0] > sw + 40, `bigger, same shape: ${(st2.rect[2] - st2.rect[0]).toFixed(0)} x ${(st2.rect[3] - st2.rect[1]).toFixed(0)} (was ${(sw / sh).toFixed(2)} : 1, now ${r2.toFixed(2)} : 1)`);
} else ok(false, 'corner handle found');
// a side handle too keeps the shape (a tester's stretched seal could still come back that way)
{
  const before = (await annots(1)).find((a) => a.id === st.id);
  const sideH = await win.locator('.hd').nth(5).boundingBox().catch(() => null);
  if (sideH) {
    await drag([sideH.x + sideH.width / 2, sideH.y + sideH.height / 2], [sideH.x + sideH.width / 2 + 70, sideH.y + sideH.height / 2]);
    await sleep(800);
    const st3 = (await annots(1)).find((a) => a.id === st.id);
    const r3 = (st3.rect[2] - st3.rect[0]) / (st3.rect[3] - st3.rect[1]);
    ok(Math.abs(r3 - sw / sh) < 0.08 && st3.rect[2] - st3.rect[0] > before.rect[2] - before.rect[0] + 20, `side handle: wider and taller together (${r3.toFixed(2)} : 1)`);
  } else ok(false, 'side handle found');
}

// 4. copy to all pages: same spot from the nearest corner, one undo
await win.locator('.ribbon [data-cmd="Copy to pages"]').click();
await win.locator('.modal h2', { hasText: 'Copy to pages' }).waitFor();
// a page list that isn't one: it says so
await win.locator('.modal input.input.sm').fill('99');
ok(await win.locator('.modal .hint.err', { hasText: 'No pages of this file' }).count() === 1, 'a list of no pages says so');
await win.locator('.modal input.input.sm').fill('2');
ok(await win.locator('.modal .hint.err', { hasText: 'the page it is on' }).count() === 1, 'its own page: says so');
await win.locator('.modal input.input.sm').fill('3-1');
ok(await win.locator('.modal .actions button', { hasText: /^Copy to 2 pages$/ }).count() === 1, '"3-1" works backwards too');
await win.locator('.modal input[type=radio]').first().check();
await win.locator('.modal .actions button', { hasText: /^Copy to 2 pages$/ }).click();
await until(async () => (await annots(0)).some((a) => a.type === 'Stamp') && (await annots(2)).some((a) => a.type === 'Stamp'), 8000, 'copies');
const src = (await annots(1)).find((a) => a.id === st.id), a3 = (await annots(2)).find((a) => a.type === 'Stamp'), a0 = (await annots(0)).find((a) => a.type === 'Stamp');
// (the same distance from the left or the right edge - whichever the stamp is nearer on page 2)
const right = (src.rect[0] + src.rect[2]) / 2 > 595 / 2;
const fromEdge = (r, w) => (right ? w - r[2] : r[0]);
ok(Math.abs(fromEdge(a3.rect, 1191) - fromEdge(src.rect, 595)) < 1 && Math.abs(a3.rect[1] - src.rect[1]) < 1, `A3: same distance from the nearest corner (${right ? 'right' : 'left'} edge, ${fromEdge(src.rect, 595).toFixed(0)} pt)`);
ok(Math.abs(a0.rect[0] - src.rect[0]) < 1 && Math.abs(a0.rect[1] - src.rect[1]) < 1, 'A4: same place');
await win.keyboard.press('Control+z');
await until(async () => !(await annots(0)).some((a) => a.type === 'Stamp') && !(await annots(2)).some((a) => a.type === 'Stamp'), 8000, 'undo');
ok(true, 'one Ctrl+Z takes back all the copies');

// 5. from a photo file (red seal): auto colour red, round, real size from its 300 dpi
await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, join(TMP, 'seal.png'));
await win.locator('.ribbon [data-cmd="Stamp"]').first().click();
await win.locator('.scard', { hasText: 'From a scan or photo' }).click();
await win.locator('.modal h2', { hasText: 'Stamp from a scan' }).waitFor({ timeout: 15000 });
r = await until(async () => { const x = await result(); return x && x.solid > 500 ? x : null; }, 20000, 'seal cleaned');
await sleep(600);
r = await result();
ok(Math.abs(r.w / r.h - 1) < 0.08 && r.red > 0.9, `round red seal: ${r.w} x ${r.h}, red ${Math.round(r.red * 100)}%`);
const mm2 = Number(await win.locator('.sscan-ctl input[inputmode=decimal]').inputValue());
ok(Math.abs(mm2 - 51) < 5, `real size from the file's 300 dpi: ${mm2} mm (drawn 146 pt = 51 mm)`);
await win.locator('.modal .actions button', { hasText: 'Save stamp' }).click();
await win.locator('.modal h2', { hasText: /^Stamps$/ }).waitFor({ timeout: 8000 });
ok(await win.locator('.scard img').count() >= 2, 'both in Your stamps');
if (process.env.SHOTS) await win.screenshot({ path: join(process.env.SHOTS, 'stamps-dialog.png') });
await win.locator('.modal .actions button', { hasText: 'Close' }).click();

// 5b. Stamp from page round a stamp that is a markup (one placed earlier): taken as shown
await win.locator('.rtab', { hasText: 'Comment' }).click();
// (this time through Find a tool)
await win.keyboard.press('Alt+q');
await win.keyboard.type('stamp from page');
await sleep(300);
await win.keyboard.press('Enter');
await sleep(300);
{
  const m = (await annots(1)).find((a) => a.id === st.id);
  await drag(await pagePt(1, m.rect[0] - 10, m.rect[1] - 10), await pagePt(1, m.rect[2] + 10, m.rect[3] + 10));
  await win.locator('.modal h2', { hasText: 'Stamp from a scan' }).waitFor({ timeout: 15000 });
  const g = await until(async () => { const x = await result(); return x && x.solid > 300 ? x : null; }, 20000, 'markup grabbed');
  ok(g.blue > 0.9, 'a stamp that is a markup is taken too (' + g.solid + ' solid pixels)');
  await win.locator('.modal .actions button', { hasText: 'Back' }).click();
  await until(() => E(() => !document.querySelector('.modal h2')?.textContent?.includes('from a scan')), 5000, 'back');
  if (await win.locator('.modal').count()) await win.locator('.modal .actions button', { hasText: 'Close' }).click().catch(() => {});
}

// 6. a signature from a scan: cleaned the same way
await win.locator('.ribbon [data-cmd="Signature"]').first().click();
await win.locator('.modal button', { hasText: 'From a picture / scan' }).click();
await until(() => E(() => !document.querySelector('.modal')), 15000, 'signature cleaned');
await sleep(500);
const sigs = settings().signatures || [];
const sigOk = sigs.length === 1 && /^data:image\/png/.test(sigs[0].image);
ok(sigOk, 'signature from a scan saved (cleaned picture)');

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
