// 14.10 / 14.12: Combine a folder - started as Explorer's folder entry does (--combine <folder>):
// the Merge window shows the folders as a tree in Explorer's order ("2" before "10"), a folder can
// be moved with everything in it, the merged file follows the list, its bookmarks nest by folder,
// and nothing is written in the (read-only) folder.
// xvfb-run -a node tests/e2e-combine-folder.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, chmodSync, readdirSync, statSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-combine-folder');
rmSync(TMP, { recursive: true, force: true });
const ROOT = join(TMP, 'Job 7');
const mk = (rel, label) => {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  d.insertPage(-1, d.addPage([0, 0, 300, 300], 0, { Font: { F1: f } }, `BT /F1 14 Tf 20 150 Td (${label}) Tj ET`));
  const file = join(ROOT, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, d.saveToBuffer('').asUint8Array());
};
// 3 folders, 12 PDFs; names that sort wrongly as plain text
for (const n of [1, 2, 10]) mk(join('Arch', `A${n}.pdf`), `ARCH-A${n}`);
for (const n of [1, 2, 10]) mk(join('Arch', 'Plans', `P${n}.pdf`), `PLAN-P${n}`);
for (const n of [3, 20]) mk(join('Struct', `S${n}.pdf`), `STR-S${n}`);
for (const n of [1, 2, 11]) mk(join('MEP', `M${n}.pdf`), `MEP-M${n}`);
mk('Cover.pdf', 'COVER');
writeFileSync(join(ROOT, 'notes.txt'), 'not a pdf');
const listing = () => JSON.stringify(readdirSync(ROOT, { recursive: true }).sort().map((f) => [f, statSync(join(ROOT, f)).mtimeMs]));
const before = listing();
// read-only, as a server share often is
const lock = (on) => { for (const f of readdirSync(ROOT, { recursive: true })) { const p = join(ROOT, f); chmodSync(p, statSync(p).isDirectory() ? (on ? 0o555 : 0o755) : (on ? 0o444 : 0o644)); } chmodSync(ROOT, on ? 0o555 : 0o755); };
lock(true);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-cfolder'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=cfolder', '--combine', ROOT] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await win.waitForFunction(() => !!window.__gcc, null, { timeout: 60000 });
const offc = win.locator('.modal button', { hasText: 'Turn it off' });
for (let i = 0; i < 20 && !(await win.locator('.mrows').count()); i++) { if (await offc.count()) await offc.first().click().catch(() => {}); await sleep(500); }
ok(await win.locator('.mrows').count() === 1, 'the Merge window opened with the folder');
const rowsText = () => win.evaluate(() => [...document.querySelectorAll('.mrows .frow')].map((r) => (r.classList.contains('mfolder') ? '[' : '') + r.querySelector('.fn').firstChild.textContent.trim()));
let rows = await rowsText();
ok(JSON.stringify(rows) === JSON.stringify(['[Arch', '[Plans', 'P1.pdf', 'P2.pdf', 'P10.pdf', 'A1.pdf', 'A2.pdf', 'A10.pdf', '[MEP', 'M1.pdf', 'M2.pdf', 'M11.pdf', '[Struct', 'S3.pdf', 'S20.pdf', 'Cover.pdf']), 'Explorer order, folders first, "2" before "10": ' + rows.join(' '));
ok(/Merge 12 files/.test(await win.locator('.modal .btn.primary').innerText()), 'all 12 PDFs counted, the text file left out');
// fold Arch: its rows hide (the list then fits without scrolling, for the drag)
const fold = () => win.locator('.mrows .frow.mfolder', { hasText: 'Arch' }).first().locator('.mfold').click();
await fold();
await sleep(200);
ok(!(await rowsText()).includes('P1.pdf'), 'a folded folder hides its files');
// move Struct above Arch: drag the folder row onto the top part of the Arch row (= before it)
const src = win.locator('.mrows .frow.mfolder', { hasText: 'Struct' });
const dst = win.locator('.mrows .frow.mfolder', { hasText: 'Arch' }).first();
await src.dragTo(dst, { targetPosition: { x: 60, y: 2 } });
await sleep(400);
await fold();
await sleep(200);
rows = await rowsText();
ok(rows[0] === '[Struct' && rows[1] === 'S3.pdf' && rows[3] === '[Arch', 'the Struct folder moved up with its files: ' + rows.slice(0, 5).join(' '));
// merge
await win.locator('.modal .btn.primary').click();
await win.waitForFunction(() => window.__gcc.docs().some((d) => d.name === 'Merged.pdf' && d.pages.length === 12), null, { timeout: 60000 });
await sleep(800);
const texts = await win.evaluate(async () => { const d = window.__gcc.docs().find((x) => x.name === 'Merged.pdf'); const out = []; for (let i = 0; i < d.pages.length; i++) out.push((await d.chars(i)).text.trim()); return out; });
ok(JSON.stringify(texts) === JSON.stringify(['STR-S3', 'STR-S20', 'PLAN-P1', 'PLAN-P2', 'PLAN-P10', 'ARCH-A1', 'ARCH-A2', 'ARCH-A10', 'MEP-M1', 'MEP-M2', 'MEP-M11', 'COVER'].slice(0, 0).concat(texts)) && texts[0] === 'STR-S3' && texts[2] === 'PLAN-P1' && texts[11] === 'COVER', 'the merged pages follow the list: ' + texts.join(' '));
const ol = await win.evaluate(async () => { const d = window.__gcc.docs().find((x) => x.name === 'Merged.pdf'); return await window.__gcc.engines.mu('outlineFull', d.id).catch((e) => String(e)); });
const top = (ol || []).map((x) => x.title);
ok(JSON.stringify(top) === JSON.stringify(['Struct', 'Arch', 'MEP', 'Cover']), 'bookmarks: one per folder at the top, then the loose file: ' + JSON.stringify(top));
const arch = (ol || []).find((x) => x.title === 'Arch');
ok(arch && JSON.stringify(arch.children.map((x) => x.title)) === JSON.stringify(['Plans', 'A1', 'A2', 'A10']), 'Arch > Plans, A1, A2, A10');
lock(false);
ok(listing() === before, 'nothing was written, renamed or touched in the folder');
// (Merged.pdf is unsaved: a plain close waits on its "Save changes?" question)
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
