// "Find a tool" (title bar, Alt+Q): finds tools by name, plain words and with typos, shows where
// they are, and Enter takes you there and runs them. xvfb-run -a node tests/e2e-find.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
const TMP = resolve('tests/tmp-find');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'spec.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-find'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=find'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1500, 950); });
for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc)); i++) await sleep(200);
await sleep(500);

const rows = () => win.evaluate(() => [...document.querySelectorAll('.tsearch-row')].map((r) => ({ nm: r.querySelector('.nm')?.textContent || '', wh: r.querySelector('.wh')?.textContent || '', dis: r.classList.contains('dis') })));
const ask = async (text) => {
  await win.keyboard.press('Alt+q');
  await sleep(150);
  await win.keyboard.press('Control+a');
  await win.keyboard.type(text, { delay: 15 });
  await sleep(250);
  return rows();
};
const activeTab = () => win.evaluate(() => document.querySelector('.rtab.on')?.textContent);

// --- no file open
let r = await ask('rotate left');
ok(r[0]?.nm === 'Rotate left' && /Organize › Pages/.test(r[0].wh) && r[0].dis, `no file: "rotate left" -> ${JSON.stringify(r[0])}`);
await win.keyboard.press('Enter');
await sleep(500);
ok((await activeTab()) === 'Organize', 'Enter on a tool that needs a file: its tab comes up');
ok(await win.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /open a file first/i.test(t.textContent))), 'and a note says to open a file first');
r = await ask('merge');
ok(r.some((x) => x.nm === 'Merge files' && !x.dis) && r.some((x) => x.nm === 'Merge' && /Batch/.test(x.wh)), `"merge" finds both places: ${r.map((x) => x.nm + ' @ ' + x.wh).join(' | ')}`);
await win.keyboard.press('Escape');

// --- with a file
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
for (let i = 0; i < 100 && !(await win.evaluate(() => window.__gcc.active()?.pages.length > 0)); i++) await sleep(100);
await sleep(800);

r = await ask('page numbers');
ok(r[0]?.nm === 'Numbers & headers' && /Edit › Page marks/.test(r[0].wh), `"page numbers" -> ${JSON.stringify(r[0])}`);
await win.keyboard.press('Enter');
await sleep(700);
ok((await activeTab()) === 'Edit', 'Enter: the Edit tab comes up');
ok(await win.locator('.modal', { hasText: 'Page numbers, headers' }).count() === 1, 'and the page marks dialog opens');
await win.keyboard.press('Escape');
await sleep(300);

r = await ask('compres');
ok(r[0]?.nm === 'Reduce size' && /Batch › Files/.test(r[0].wh), `typo "compres" -> ${JSON.stringify(r[0])}`);
await win.keyboard.press('Escape');

r = await ask('mesure area');
ok(r[0]?.nm === 'Area' && /Measure › Measure/.test(r[0].wh), `"mesure area" -> ${JSON.stringify(r[0])}`);
await win.keyboard.press('Enter');
await sleep(500);
ok((await activeTab()) === 'Measure' && (await win.evaluate(() => !!document.querySelector('.ribbon [data-tool="m-area"].on'))), 'Enter: Measure tab, Area tool on');
await win.keyboard.press('Escape');

r = await ask('redact');
const mark = r.find((x) => x.nm === 'Mark area');
ok(!!mark && /Edit › Redact/.test(mark.wh) && /Protect › Redact/.test(mark.wh), `a tool on two tabs is one result with both places: ${JSON.stringify(mark)}`);
await win.keyboard.press('Escape');

r = await ask('password');
ok(r[0]?.nm === 'Protect' && /Protect › Password/.test(r[0].wh), `"password" -> ${JSON.stringify(r[0])}`);
await win.keyboard.press('Escape');

r = await ask('wheel');
ok(r[0]?.nm.startsWith('Wheel zooms'), `check boxes are found too: ${JSON.stringify(r[0])}`);
await win.keyboard.press('Escape');

r = await ask('bookmarks');
ok(r[0]?.nm === 'Bookmarks' && /Left panel/.test(r[0].wh), `left panel: ${JSON.stringify(r[0])}`);
await win.keyboard.press('Enter');
await sleep(400);
ok(await win.evaluate(() => !!document.querySelector('.rail-btn.on[title="Bookmarks"]')), 'Enter opens the Bookmarks panel');

r = await ask('xqzw');
ok(r.length === 0 && (await win.evaluate(() => /Nothing called that/.test(document.querySelector('.tsearch-pop')?.textContent || ''))), 'nonsense: nothing found, says so');
await win.keyboard.press('Escape');

// empty box: recently used
await win.keyboard.press('Alt+q');
await sleep(200);
r = await rows();
ok(r.length >= 3 && r[0].nm === 'Bookmarks', `empty box shows recently used: ${r.map((x) => x.nm).join(', ')}`);
await win.keyboard.press('Escape');
await win.screenshot({ path: 'tests/out/find-tool.png' });

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
