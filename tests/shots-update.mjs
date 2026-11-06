// Screenshots of the update card and Settings › Updates (light and dark).
// xvfb-run -a node tests/shots-update.mjs
import { _electron as electron } from 'playwright';
import crypto from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// (only a signed latest.json is trusted from 0.8.2: electron/updsig.cjs)
const signedJson = (p) => JSON.stringify(createRequire(import.meta.url)('../electron/updsig.cjs').signLatest(p, createRequire(import.meta.url)('node:fs').readFileSync('keys/update-signing-key.pem', 'utf8')), null, 2);
const TMP = resolve('tests/tmp-update-shots'), OUT = resolve('tests/out/update');
rmSync(TMP, { recursive: true, force: true }); rmSync(OUT, { recursive: true, force: true });
const INST = join(TMP, 'install'), SHARE = join(TMP, 'share');
for (const d of [INST, SHARE, OUT, join(INST, 'resources', 'app.old')]) mkdirSync(d, { recursive: true });
const pkg = crypto.randomBytes(2_400_000);
writeFileSync(join(SHARE, 'app-v0.9.0.zip'), pkg);
writeFileSync(join(SHARE, 'latest.json'), signedJson({ version: '0.9.0', runtime: '', notes: ['Installer and automatic updates', 'Faster drawing of dense sheets', 'Highlights can be resized after placing them'], app: { file: 'app-v0.9.0.zip', sha256: crypto.createHash('sha256').update(pkg).digest('hex'), size: 21_400_000 } }));
writeFileSync(join(INST, 'install.json'), JSON.stringify({ scope: 'user', version: '0.4.0' }));
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: '\\\\gcc-fs01\\Software\\PDF Editor' }));
writeFileSync(join(INST, 'resources', 'app.old', 'package.json'), JSON.stringify({ version: '0.3.9' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-upshots');
for (const theme of ['light', 'dark']) {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify({ theme, updateSource: SHARE }));
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=upshots'], env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_FIRST: '800' } });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1300, 800); });
  await win.locator('.upcard').waitFor({ timeout: 10000 });
  await sleep(500);
  await win.screenshot({ path: join(OUT, theme + '-1-available.png'), clip: { x: 850, y: 420, width: 450, height: 380 } });
  await win.evaluate(() => window.gcc.updateDownload());
  await win.locator('.upcard', { hasText: 'is ready' }).waitFor({ timeout: 10000 });
  await sleep(400);
  await win.screenshot({ path: join(OUT, theme + '-2-ready.png'), clip: { x: 850, y: 420, width: 450, height: 380 } });
  await win.locator('.tb-btn[title="Settings"]').click();
  await sleep(600);
  await win.locator('.modal .row', { hasText: 'Updates' }).scrollIntoViewIfNeeded();
  await win.screenshot({ path: join(OUT, theme + '-3-settings.png') });
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sleep(800);
}
console.log('shots in', OUT);
process.exit(0);
