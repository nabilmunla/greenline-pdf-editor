// Layers on a heavy sheet (PLAN 7.4 step 4): a layer switched while the heavy page is still being
// merged for display, then one layer switched 50 times - the screen follows, the engines' memory
// stays flat, no engine stops, no page error.   xvfb-run -a node tests/e2e-layers-stress.mjs
// The sheet: 5 million strokes (tests/bench/gen-synthetic.py - merged for display, 4 million and
// up) with its line work in a layer "Lines" and a red block on top in a layer "Mark".
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as mupdf from 'mupdf';
import { deflateSync } from 'node:zlib';

const TMP = resolve('tests/tmp-layers-stress');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'heavy-layers.pdf'), SRC = join(TMP, 'sheet-5m.pdf');
execFileSync('python3', ['tests/bench/gen-synthetic.py', SRC, '5000000', '5']);
{
  const d = mupdf.Document.openDocument(readFileSync(SRC), 'application/pdf');
  const pg = d.findPage(0);
  const ocg = (name) => { const o = d.newDictionary(); o.put('Type', d.newName('OCG')); o.put('Name', d.newString(name)); return d.addObject(o); };
  const L = ocg('Lines'), M = ocg('Mark');
  const ocp = d.newDictionary(), all = d.newArray(), D = d.newDictionary(), order = d.newArray();
  all.push(L); all.push(M); order.push(L); order.push(M);
  D.put('Order', order); ocp.put('OCGs', all); ocp.put('D', D);
  d.getTrailer().get('Root').put('OCProperties', ocp);
  const res = pg.get('Resources').resolve();
  const props = d.newDictionary(); props.put('L1', L); props.put('M1', M);
  res.put('Properties', props);
  // (Flate-compressed like the rest: a page whose parts are not all Flate is not merged for display)
  const flate = (text) => { const dict = d.newDictionary(); dict.put('Filter', d.newName('FlateDecode')); return d.addRawStream(deflateSync(Buffer.from(text)), dict); };
  const was = pg.get('Contents'), list = d.newArray();
  list.push(flate('q /OC /L1 BDC\n'));
  if (was.isArray()) for (let i = 0; i < was.length; i++) list.push(was.get(i)); else list.push(was);
  const [x0, y0, x1, y1] = pg.get('MediaBox').asJS ? pg.get('MediaBox').asJS() : [0, 0, 3370, 2384];
  const w = x1 - x0, h = y1 - y0;
  list.push(flate(`\nEMC Q\n/OC /M1 BDC 1 0 0 rg ${x0 + w * 0.3} ${y0 + h * 0.3} ${w * 0.4} ${h * 0.4} re f EMC\n`));
  pg.put('Contents', list);
  writeFileSync(F, d.saveToBuffer('').asUint8Array());
}

const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-layersstress');
rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=layersstress'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
let exits = 0;
app.process().stdout?.on('data', (b) => { if (/exited 70|restarted \(exit 70\)/.test(String(b))) exits++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
const E = (fn, a) => win.evaluate(fn, a);
await until(() => E(() => !!window.__gcc));
/** red and black pixels on the drawn page 0 */
const screen = () => E(() => {
  const n = { red: 0, black: 0 };
  for (const c of document.querySelectorAll('.pg[data-page="0"] canvas')) {
    if (!c.width || !c.height) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; if (d[i] > 170 && d[i + 1] < 80 && d[i + 2] < 80) n.red++; else if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] < 70) n.black++; }
  }
  return n;
});
const settled = async (want) => { const v = await until(async () => { const s = await screen(); const t = E(() => window.__gcc.tiles.stats()); const st = await t; return !st.queued && !st.inflight && want(s) ? s : null; }, 60000); return v || await screen(); };
const engineMem = () => app.evaluate(({ app: a }) => a.getAppMetrics().filter((x) => x.type === 'Utility').reduce((n, x) => n + (x.memory?.workingSetSize || 0), 0) * 1024);
const tick = (name) => win.locator('.ly-row', { hasText: name }).locator('input');

try {
  // open, and at once (the heavy page is still being looked at / merged) hide "Mark"
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
  await until(() => E(() => window.__gcc.active()?.pages.length === 1), 60000);
  await win.locator('.rail-btn[title="Layers"]').click();
  await until(() => tick('Mark').count(), 15000);
  const merging = await E(() => { const d = window.__gcc.active(); return !!(d.preparing?.size || d.mergeRun); });
  await tick('Mark').click();
  console.log('   (Mark hidden while the page was ' + (merging ? 'being merged' : 'already merged') + ')');
  const s1 = await settled((s) => s.red < 100 && s.black > 1000);
  ok(s1.red < 100 && s1.black > 1000, `"Mark" hidden during the merge: no red, the line work drawn (red ${s1.red}, black ${s1.black})`);
  // the line work's own layer off and on again (the merged line work follows its layer)
  await tick('Lines').click();
  const s2 = await settled((s) => s.black < 1000);
  ok(s2.black < 1000, `"Lines" hidden: the merged line work goes too (black ${s2.black})`);
  await tick('Lines').click();
  const s3 = await settled((s) => s.black > 1000);
  ok(s3.black > 1000, `"Lines" shown again (black ${s3.black})`);
  console.log('   merged for display: ' + await E(() => window.__gcc.active().merges?.size) + ' (' + await E(() => [...(window.__gcc.active().looked || [])].length) + ' looked)');
  // 50 switches of "Mark"; the engines' memory before and after
  await sleep(2000);
  const m0 = await engineMem();
  for (let i = 0; i < 50; i++) { await tick('Mark').click(); await sleep(i % 10 === 9 ? 1500 : 120); }
  const s4 = await settled((s) => s.red < 100 && s.black > 1000);
  ok(s4.red < 100 && s4.black > 1000, `after 50 switches "Mark" is hidden as the panel says (red ${s4.red})`);
  ok(!(await tick('Mark').isChecked()), 'the panel says hidden');
  await sleep(3000);
  const m1 = await engineMem();
  ok(m1 - m0 < 300 * 2 ** 20, `engines' memory flat over 50 switches: ${Math.round(m0 / 2 ** 20)} -> ${Math.round(m1 / 2 ** 20)} MB`);
  const st = await E(() => { const d = window.__gcc.active(); return { dirty: d.dirty, canUndo: d.canUndo }; });
  ok(!st.dirty && !st.canUndo, 'switching layers did not change the file');
  ok(exits === 0, `no engine stopped (${exits})`);
} catch (e) {
  ok(false, 'threw: ' + (e?.message || e));
} finally {
  await Promise.race([app.close().catch(() => {}), sleep(15000)]);
  try { app.process().kill('SIGKILL'); } catch { /* gone */ }
  rmSync(TMP, { recursive: true, force: true });
}
console.log(fails ? `${fails} failed` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
