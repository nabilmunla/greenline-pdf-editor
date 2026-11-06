// Offline translator plumbing: download (checksums), install, engine process, page text ->
// paragraphs -> translation -> panel / PDF. Mozilla's servers and the Bergamot runtime are
// replaced by local stand-ins (the real ones are blocked in the build sandbox).
// xvfb-run -a node tests/e2e-mt.mjs
import { _electron as electron } from 'playwright';
import http from 'node:http';
import crypto from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync, readdirSync, statSync, truncateSync } from 'node:fs';

const TMP = resolve('tests/tmp-mt');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
copyFileSync('tests/data/long-spec.pdf', join(TMP, 'long-spec.pdf'));
copyFileSync('tests/data/scan.pdf', join(TMP, 'scan.pdf'));
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-mt');
rmSync(PROFILE, { recursive: true, force: true });

// ---------------------------------------------------------------- stand-in for Mozilla
const files = {
  'w/runtime.wasm': Buffer.from('\0asm-fake-runtime'),
  'm/model.enar.bin': Buffer.concat([Buffer.from('FAKEMODEL'), crypto.randomBytes(300000)]),
  'm/lex.enar.bin': crypto.randomBytes(40000),
  'm/vocab.enar.spm': crypto.randomBytes(20000),
  'm/model.aren.bin': Buffer.concat([Buffer.from('FAKEMODEL'), crypto.randomBytes(200000)]),
  'm/lex.aren.bin': crypto.randomBytes(30000),
  'm/vocab.aren.spm': crypto.randomBytes(10000),
  // a newer en->ar pack, published later in the test
  'm/model.enar.v23.bin': Buffer.concat([Buffer.from('FAKEMODEL'), crypto.randomBytes(310000)]),
  'm/lex.enar.v23.bin': crypto.randomBytes(41000),
  'm/vocab.enar.v23.spm': crypto.randomBytes(21000),
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let corrupt = true; // first download attempt: one file comes back damaged
const rec = (fileType, name, loc, version = '2.2', filter = '') => ({ fromLang: 'en', toLang: 'ar', fileType, name, version, filter_expression: filter, attachment: { location: loc, hash: sha(files[loc]), size: files[loc].length } });
const records = [
  rec('model', 'model.enar.intgemm.alphas.bin', 'm/model.enar.bin'),
  rec('lex', 'lex.50.50.enar.s2t.bin', 'm/lex.enar.bin'),
  rec('vocab', 'vocab.enar.spm', 'm/vocab.enar.spm'),
  { ...rec('model', 'model.aren.intgemm.alphas.bin', 'm/model.aren.bin'), fromLang: 'ar', toLang: 'en' },
  { ...rec('lex', 'lex.50.50.aren.s2t.bin', 'm/lex.aren.bin'), fromLang: 'ar', toLang: 'en' },
  { ...rec('vocab', 'vocab.aren.spm', 'm/vocab.aren.spm'), fromLang: 'ar', toLang: 'en' },
  // a newer major version (needs a newer runtime) and an Android-only one must be ignored
  { ...rec('model', 'model.enar.zst', 'm/model.enar.bin', '3.0') },
  { ...rec('model', 'model.enar.android', 'm/model.enar.bin', '2.9', "env.appinfo.OS == 'Android'") },
];
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  if (req.url.startsWith('/records')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: records })); return; }
  const key = req.url.replace(/^\/cdn\//, '').replace(/^main-workspace\/translations-wasm\/.*$/, 'w/runtime.wasm');
  const b = files[key];
  if (!b) { res.writeHead(404); res.end(); return; }
  res.writeHead(200);
  if (corrupt && key === 'm/lex.enar.bin') { corrupt = false; res.end(crypto.randomBytes(b.length)); return; }
  res.end(b);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let app, win;
const E = (fn, arg) => win.evaluate(fn, arg);
const until = async (fn, ms = 30000, what = 'condition') => {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(100); }
  throw new Error('timed out waiting for ' + what);
};
const ok = (c, m) => { if (!c) throw new Error(m); };
async function step(name, fn) {
  const t = Date.now();
  try { const info = await fn(); results.push({ ok: true }); console.log(`PASS ${name} (${Date.now() - t} ms)${info ? ' – ' + info : ''}`); }
  catch (e) { results.push({ ok: false }); console.log(`FAIL ${name}: ${e.message}`); await win.screenshot({ path: join(TMP, 'fail-' + name.replace(/\W+/g, '_').slice(0, 50) + '.png') }).catch(() => {}); }
}

app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron'),
  args: [resolve('.'), '--no-sandbox', '--profile=mt', join(TMP, 'long-spec.pdf')],
  env: { ...process.env, PDFED_MT_RECORDS_TTL: '1500', PDFED_MT_RECORDS: base + '/records', PDFED_MT_CDN: base + '/cdn/', PDFED_MT_WASM_SHA: sha(files['w/runtime.wasm']), PDFED_MT_GLUE: resolve('tests/fixtures/fake-bergamot.js') },
});
win = await app.firstWindow();
win.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await app.evaluate(({ dialog }) => {
  globalThis.__q = { save: [] };
  dialog.showSaveDialog = async () => { const f = globalThis.__q.save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  dialog.showMessageBox = async () => ({ response: 0 });
});
await until(() => E(() => window.__gcc?.active()?.pages.length > 0), 30000, 'file open');
const panel = () => win.locator('.ai-panel');

await step('Translate works without any AI key: offline engine offered, pack not installed yet', async () => {
  await win.locator('.rtab', { hasText: 'AI' }).click();
  await win.locator('.ribbon .rb', { hasText: 'Translate' }).click();
  await panel().waitFor();
  await until(() => panel().locator('button', { hasText: 'Download language pack' }).count(), 20000, 'download button');
  ok(await panel().locator('.ai-engine button.on', { hasText: 'On this PC' }).count(), 'on this PC selected');
  return await panel().locator('button', { hasText: 'Download language pack' }).textContent();
});

await step('a damaged download is refused (checksum), nothing installed', async () => {
  await panel().locator('button', { hasText: 'Download language pack' }).click();
  await until(() => win.locator('.toast', { hasText: /checksum/i }).count(), 20000, 'checksum error');
  await until(() => panel().locator('button', { hasText: 'Download language pack' }).count(), 10000, 'still offered');
  const dir = join(PROFILE, 'translator', 'models');
  const all = existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
  ok(!all.some((f) => f.includes('lex.50.50')), 'bad file not kept: ' + all.join(','));
  return 'refused';
});

await step('download again: installed, newest usable version picked', async () => {
  await panel().locator('button', { hasText: 'Download language pack' }).click();
  await until(() => panel().locator('.hint', { hasText: 'Language pack on this PC' }).count(), 20000, 'installed');
  const all = readdirSync(join(PROFILE, 'translator', 'models'), { recursive: true }).map(String);
  ok(all.some((f) => /2\.2/.test(f)) && !all.some((f) => /3\.0|2\.9/.test(f)), all.join(','));
  return all.filter((f) => /\.(bin|spm)$/.test(f)).length + ' files';
});

await step('translate this page offline: paragraphs, page heading, no network', async () => {
  const before = hits;
  const info = await E(() => [...document.querySelectorAll('.ai-panel button')].map((b) => JSON.stringify(b.textContent) + (b.disabled ? ' (disabled)' : '')).join(' | '));
  console.log('  buttons:', info);
  await panel().locator('button', { hasText: /Translate page/ }).click();
  await until(async () => (await panel().locator('.tr-out .rich').count()) && !(await panel().locator('.tr-out .busyline').count()), 20000, 'done');
  const txt = await panel().locator('.tr-out .rich').textContent();
  ok(/Page 1/.test(txt) && /\[ar\] /.test(txt), txt.slice(0, 200));
  ok(hits === before, 'no network used');
  await win.screenshot({ path: join(TMP, 'translated.png') });
  const paras = (txt.match(/\[ar\] /g) || []).length;
  return `${paras} paragraphs; ${JSON.stringify(txt.slice(0, 120))}`;
});

await step('a language without an offline model says so', async () => {
  await panel().locator('.tr-into').selectOption('French');
  await until(() => panel().locator('.err', { hasText: /No offline model/ }).count(), 20000, 'message');
  ok(await panel().locator('button', { hasText: /Translate page/ }).isDisabled(), 'button disabled');
  await panel().locator('.tr-into').selectOption('Arabic');
  return 'ok';
});

await step('switch direction (Arabic -> English) in the same session: new pack, engine swapped, works', async () => {
  // the source is chosen by hand here (the sample is English text; the stand-in engine doesn't care)
  await panel().locator('.tr-from').selectOption('ar');
  await panel().locator('.tr-into').selectOption('English');
  await until(() => panel().locator('button', { hasText: 'Download language pack' }).count(), 20000, 'download offered for ar-en');
  await panel().locator('button', { hasText: 'Download language pack' }).click();
  await until(() => panel().locator('.hint', { hasText: 'Language pack on this PC' }).count(), 20000, 'installed');
  await panel().locator('button', { hasText: /Translate page/ }).click();
  await until(async () => !(await panel().locator('.tr-out .busyline').count()) && ((await panel().locator('.tr-out .rich').count()) || (await panel().locator('.tr-out .err').count())), 20000, 'done');
  const err = await panel().locator('.tr-out .err').count() ? await panel().locator('.tr-out .err').textContent() : '';
  ok(!err, err);
  const txt = await panel().locator('.tr-out .rich').textContent();
  ok(/\[en\] /.test(txt), txt.slice(0, 120));
  // and back again
  await panel().locator('.tr-from').selectOption('auto');
  await panel().locator('.tr-into').selectOption('Arabic');
  await until(() => panel().locator('.hint', { hasText: 'Language pack on this PC' }).count(), 20000, 'ready');
  await panel().locator('button', { hasText: /Translate page/ }).click();
  await until(async () => !(await panel().locator('.tr-out .busyline').count()) && (await panel().locator('.tr-out .rich').count()), 20000, 'done');
  ok(/\[ar\] /.test(await panel().locator('.tr-out .rich').textContent()), 'back to en->ar');
  return 'ok';
});

await step('Mozilla publishes a newer pack: the installed one keeps working, the update is offered, then used', async () => {
  records.push(rec('model', 'model.enar.intgemm.alphas.bin', 'm/model.enar.v23.bin', '2.3'), rec('lex', 'lex.50.50.enar.s2t.bin', 'm/lex.enar.v23.bin', '2.3'), rec('vocab', 'vocab.enar.spm', 'm/vocab.enar.v23.spm', '2.3'));
  await sleep(1800); // the list is asked for again after its time (a day in real use)
  await panel().locator('.tr-into').selectOption('English');
  await sleep(300);
  await panel().locator('.tr-into').selectOption('Arabic');
  await until(() => panel().locator('button', { hasText: /^Update/ }).count(), 20000, 'update offered');
  const offer = await panel().locator('button', { hasText: /^Update/ }).textContent();
  ok(await panel().locator('button', { hasText: /Translate page/ }).isEnabled(), 'translate still enabled with the installed pack');
  const before = hits;
  await panel().locator('button', { hasText: /Translate page/ }).click();
  await until(async () => !(await panel().locator('.tr-out .busyline').count()) && (await panel().locator('.tr-out .rich').count()), 20000, 'done');
  ok(/\[ar\] /.test(await panel().locator('.tr-out .rich').textContent()) && hits - before <= 1, 'translated with the installed pack, no download');
  await panel().locator('button', { hasText: /^Update/ }).click();
  await until(() => panel().locator('.hint', { hasText: 'translation runs offline' }).count(), 20000, 'updated');
  const dirs = readdirSync(join(PROFILE, 'translator', 'models', 'en-ar')).map(String);
  ok(dirs.length === 1 && dirs[0] === '2.3', 'only the new version kept: ' + dirs.join(','));
  await panel().locator('button', { hasText: /Translate page/ }).click();
  await until(async () => !(await panel().locator('.tr-out .busyline').count()) && (await panel().locator('.tr-out .rich').count()), 20000, 'done');
  ok(/\[ar\] /.test(await panel().locator('.tr-out .rich').textContent()), 'translates with the new pack');
  return offer.trim();
});

await step('a scanned page without text: told to OCR first (no garbage)', async () => {
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'scan.pdf'));
  await until(() => E(() => window.__gcc.active()?.name === 'scan.pdf'), 20000, 'scan open');
  await win.locator('.ribbon .rb', { hasText: 'Translate' }).click();
  await until(() => panel().locator('.hint', { hasText: 'Language pack on this PC' }).count(), 20000, 'ready');
  await panel().locator('button', { hasText: /Translate page/ }).click();
  await until(async () => (await panel().locator('.tr-out .rich').count()) && !(await panel().locator('.tr-out .busyline').count()), 20000, 'done');
  const txt = await panel().locator('.tr-out .rich').textContent();
  ok(/Run OCR/.test(txt), txt);
  return 'ok';
});

await step('a language-pack file cut short on disk: Download is offered again, and puts it right', async () => {
  const dir = join(PROFILE, 'translator', 'models', 'en-ar');
  const v = join(dir, readdirSync(dir).map(String)[0]);
  const big = readdirSync(v).map((n) => join(v, String(n))).sort((a, b) => statSync(b).size - statSync(a).size)[0];
  const size = statSync(big).size;
  truncateSync(big, Math.floor(size / 2));
  await panel().locator('.tr-into').selectOption('English');
  await sleep(400);
  await panel().locator('.tr-into').selectOption('Arabic');
  await until(() => panel().locator('button', { hasText: /Download language pack/ }).count(), 20000, 'download offered');
  await panel().locator('button', { hasText: /Download language pack/ }).click();
  await until(() => panel().locator('.hint', { hasText: 'translation runs offline' }).count(), 20000, 'installed again');
  ok(statSync(big).size === size, 'file restored to full size');
  await panel().locator('button', { hasText: /Translate page/ }).click();
  await until(async () => (await panel().locator('.tr-out .rich').count()) && !(await panel().locator('.tr-out .busyline').count()), 20000, 'done');
  return 'repaired';
});

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
server.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
