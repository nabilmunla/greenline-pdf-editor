// Phase 6 step 4: timed open of big PDFs, one app copy against another (0.10.0 against the release
// head), each file opened fresh RUNS times: pages known, first page drawn, first view complete.
//   xvfb-run -a node tests/timed-open.mjs <app dir> <label> <file.pdf> [more...]
// One JSON line per file and run on stdout.
import { _electron as electron } from 'playwright';
import { resolve, basename, join } from 'node:path';
import { rmSync, mkdirSync, copyFileSync } from 'node:fs';

const [dir, label, ...files] = process.argv.slice(2);
const RUNS = Number(process.env.RUNS || 3);
const TMP = resolve('tests/tmp-timed-open');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return Date.now() - t; await sleep(25); } return -1; };
for (const file of files) {
  for (let run = 1; run <= RUNS; run++) {
    rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
    const F = join(TMP, basename(file)); copyFileSync(file, F);
    rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-timed'), { recursive: true, force: true });
    const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve(dir), '--no-sandbox', '--profile=timed'] });
    const win = await app.firstWindow();
    await win.waitForFunction(() => !!window.__gcc, null, { timeout: 90000 });
    await sleep(1500);
    const E = (fn, a) => win.evaluate(fn, a);
    const t = Date.now();
    await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), F);
    const known = await until(() => E((n) => window.__gcc.active()?.name === n && window.__gcc.active().pages.length > 0, basename(F)));
    const knownAt = known < 0 ? -1 : Date.now() - t;
    const tile = await until(() => E(() => window.__gcc.tiles.stats().tiles > 0));
    const tileAt = tile < 0 ? -1 : Date.now() - t;
    const done = await until(async () => { const s = await E(() => window.__gcc.tiles.stats()); if (s.queued || s.inflight || !s.tiles) return false; await sleep(200); const s2 = await E(() => window.__gcc.tiles.stats()); return !s2.queued && !s2.inflight; });
    console.log(JSON.stringify({ label, file: basename(file), run, pagesKnownMs: knownAt, firstTileMs: tileAt, viewCompleteMs: done < 0 ? -1 : Date.now() - t }));
    await Promise.race([app.close().catch(() => {}), sleep(5000)]);
    try { app.process().kill('SIGKILL'); } catch { /* gone */ }
  }
}
rmSync(TMP, { recursive: true, force: true });
