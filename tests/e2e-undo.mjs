// Page operations + undo/redo in the app: the right pages come back, untouched pages keep their
// pictures, copies are independent. xvfb-run -a node tests/e2e-undo.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
const TMP = resolve('tests/tmp-undo');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'spec.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-undo'), { recursive: true, force: true });
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=undo', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1500, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
const texts = (n = 6) => E(async (k) => { const d = window.__gcc.active(); const o = []; for (let i = 0; i < k; i++) o.push((await d.chars(i)).text.slice(0, 60)); return o; }, n);
const crev = () => E(() => window.__gcc.active().crev.slice(0, 6));

const t0 = await texts(), c0 = await crev();
await E(() => window.__gcc.active().deletePages([2]));
const t1 = await texts();
ok(t1[2] === t0[3] && (await E(() => window.__gcc.active().pages.length)) === 1499, 'delete page 3: page 4 moves up');
await E(() => window.__gcc.active().undo());
const t2 = await texts(), c2 = await crev();
ok(JSON.stringify(t2) === JSON.stringify(t0), 'undo: all pages back with the right text');
ok(c2[0] === c0[0] && c2[1] === c0[1] && c2[3] === c0[3] && c2[2] !== c0[2], 'undo: untouched pages keep their pictures, the restored one is redrawn: ' + c0 + ' -> ' + c2);
await E(() => window.__gcc.active().redo());
ok(JSON.stringify(await texts()) === JSON.stringify(t1), 'redo: deleted again');
await E(() => window.__gcc.active().undo());

// move page 1 after page 4, undo
await E(() => window.__gcc.active().arrange([1, 2, 3, 0, ...Array.from({ length: 1496 }, (_, k) => k + 4)], 'Move pages'));
ok((await texts())[3] === t0[0], 'move page 1 after page 4');
await E(() => window.__gcc.active().undo());
ok(JSON.stringify(await texts()) === JSON.stringify(t0), 'undo the move');

// rotate + undo + redo
await E(() => window.__gcc.active().rotate([4], 90));
ok((await E(() => window.__gcc.active().pages[4].rot)) === 90, 'rotate page 5');
await E(() => window.__gcc.active().undo());
ok((await E(() => window.__gcc.active().pages[4].rot)) === 0, 'undo rotation');
await E(() => window.__gcc.active().redo());
ok((await E(() => window.__gcc.active().pages[4].rot)) === 90, 'redo rotation');

// duplicate page 1, markup on the copy only
await E(() => window.__gcc.active().arrange([0, 0, ...Array.from({ length: 1499 }, (_, k) => k + 1)], 'Duplicate pages'));
await E(() => window.__gcc.active().create(1, { type: 'Square', rect: [50, 50, 150, 120], color: [1, 0, 0] }));
const n0 = await E(async () => (await window.__gcc.active().annots(0)).length), n1 = await E(async () => (await window.__gcc.active().annots(1)).length);
ok(n0 === 0 && n1 === 1, `duplicate is its own page: original ${n0} markups, copy ${n1}`);

// insert blank + undo
const before = await E(() => window.__gcc.active().pages.length);
await E(() => window.__gcc.active().insertBlank(2, 595, 842));
await E(() => window.__gcc.active().undo());
ok((await E(() => window.__gcc.active().pages.length)) === before, 'insert blank + undo');

// OCR text layers: searchable straight away (the drawing engines get them a moment later)
await E(() => window.__gcc.active().addTextLayer(10, [{ text: 'zebrafish', box: [100, 100, 180, 112] }]));
const found = await E(async () => (await window.__gcc.active().chars(10)).text.includes('zebrafish'));
ok(found, 'text added by OCR is there for search/copy at once');

// save, then undo still works (the file now has two versions)
await E(() => window.__gcc.active().save());
await E(() => window.__gcc.active().create(5, { type: 'Circle', rect: [50, 50, 100, 100], color: [0, 0, 1] }));
await E(() => window.__gcc.active().save());
await E(() => window.__gcc.active().undo());
ok((await E(async () => (await window.__gcc.active().annots(5)).length)) === 0, 'undo after saving twice removes the markup');

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
