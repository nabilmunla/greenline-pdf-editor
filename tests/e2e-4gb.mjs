// Drawing engines past 2 GB (0.9.7), in the real app: every drawing engine starts with its memory
// taken up to 2.1 GB (PDFED_TEST_FILL), so all its work lands past 2 GB - pages drawn, zoomed
// tiles, a scan, search, links - and no engine stops or restarts.
//   xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-4gb.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-e2e-4gb');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const SPEC = join(TMP, 'spec.pdf'), SCAN = join(TMP, 'scan.pdf'), LINK = join(TMP, 'link.pdf');
copyFileSync('tests/data/long-spec.pdf', SPEC);
copyFileSync('tests/data/scan.pdf', SCAN);
{
  const d = new mupdf.PDFDocument();
  const page = d.addPage([0, 0, 595, 842], 0, {}, '0 0 1 rg 70 690 130 30 re f');
  page.put('Annots', [d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Link'), Rect: [70, 690, 200, 720], Border: [0, 0, 0], A: { S: d.newName('URI'), URI: d.newString('https://example.com/past-2gb') } })]);
  d.insertPage(-1, page);
  writeFileSync(LINK, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-4gb'), { recursive: true, force: true });
const GB = 1024 ** 3;
const FILL = Number(process.env.E2E_FILL || 2.1); // (GB)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; return c; };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; };

const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron'),
  args: [resolve('.'), '--no-sandbox', '--profile=4gb', SPEC],
  env: { ...process.env, PDFED_TEST_FILL: String(FILL), PDFED_RECYCLE_AT: String(4.5 * GB) },
});
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
const E = (fn, a) => win.evaluate(fn, a);
/** dark pixels drawn on page `pg` (all its canvases) */
const inked = (pg = 0) => E((p) => {
  let n = 0;
  for (const c of document.querySelectorAll(`.pg[data-page="${p}"] canvas`)) {
    if (!c.width || !c.height) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++;
  }
  return n;
}, pg);
const heaps = () => E(() => Promise.all(window.__gcc.engines.renderers.map((r) => r.call('heap'))));

try {
  await win.waitForFunction(() => window.__gcc?.active()?.pages.length > 0, null, { timeout: 90000 });
  const h0 = await until(async () => { const h = await heaps(); return h.length && h.every((x) => x > FILL * GB) ? h : null; }, 60000);
  ok(!!h0, `every drawing engine works past ${FILL} GB (${(h0 || await heaps()).map((x) => (x / GB).toFixed(2) + ' GB').join(', ')})`);
  const n = (await heaps()).length;

  ok(!!(await until(async () => (await inked(0)) > 500)), 'the spec\'s first page is drawn');
  const hits = await E(() => window.__gcc.engines.renderers[0].call('find', [window.__gcc.active().id, 'contract', 0, 3, false, false]));
  ok(Array.isArray(hits) && hits.length > 0 && hits[0].rects?.[0]?.length === 4, `search finds text (${hits?.length} hits)`);
  const chars = await E(() => window.__gcc.engines.renderers[0].call('chars', [window.__gcc.active().id, 0]));
  ok(chars?.text?.length > 100 && chars.box?.length >= chars.text.length * 4, `page text and its boxes read (${chars?.text?.length} chars)`);

  // zoomed in: tiles drawn sharp by the engines
  await E(() => window.__gcc.viewer().setZoom(4));
  await sleep(2500);
  ok(!!(await until(async () => (await inked(0)) > 500)), 'zoomed to 400%: the page is drawn');

  // a scan and a link, each in a tab of its own
  for (const [f, k] of [[SCAN, 2], [LINK, 3]]) {
    await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), f);
    await until(async () => (await E(() => window.__gcc.docs().length)) >= k, 30000);
  }
  const docs = await until(async () => { const l = await E(() => window.__gcc.docs().map((d) => d.name)); return l.length >= 3 ? l : null; }, 30000);
  ok(!!docs, 'the scan and the link file opened (' + (docs || []).join(', ') + ')');
  if (docs) {
    await win.locator('.dtab', { hasText: 'scan' }).first().click();
    await E(() => window.__gcc.viewer().setZoom(1));
    ok(!!(await until(async () => (await inked(0)) > 2000)), 'the scan is drawn');
    await win.locator('.dtab', { hasText: 'link' }).first().click();
    const lk = await until(async () => { const id = await E(() => window.__gcc.active()?.id); const l = await E((i) => window.__gcc.engines.renderers[0].call('links', [i, 0]), id); return l?.length ? l : null; });
    ok(JSON.stringify(lk || '').includes('https://example.com/past-2gb'), 'the link is read');
  }

  // nothing stopped or started afresh: the same engines, still past 2 GB
  const h1 = await heaps();
  ok(h1.length === n && h1.every((x) => x > FILL * GB), `the same ${n} engines all along (${h1.map((x) => (x / GB).toFixed(2)).join(', ')} GB)`);
  const log = await E(() => window.__gcc.engines.renderers.map((r) => r.name + ':' + (r.restarts ?? 0))).catch(() => []);
  console.log('  engines:', log.join(' '));
} catch (e) {
  ok(false, 'error: ' + (e?.message || e));
} finally {
  console.log(`\n${passes} passed, ${fails} failed`);
  // (several files open: closing asks "Close all, or just this file?" - nobody here to answer)
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(5000).then(() => false)]);
  if (!closed) app.process().kill('SIGKILL');
  process.exit(fails ? 1 : 0);
}
