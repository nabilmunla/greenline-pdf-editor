// Text in any font and in Arabic: typed into text boxes / callouts / typewriter and onto the page,
// shown right in the app, saved with the font inside, drawn the same by other PDF programs.
// xvfb-run -a node tests/e2e-fonts.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TMP = resolve('tests/tmp-fonts');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'spec.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-fonts'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=fonts'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1500, 950); });
for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc)); i++) await sleep(200);
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0);
await sleep(800);
const E = (fn, a) => win.evaluate(fn, a);
await E(() => window.__gcc.viewer().fit('width'));
await sleep(700);
const at = async (x, y) => { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const w = await E(() => window.__gcc.active().pages[0].w); const k = box.width / w; return [box.x + x * k, box.y + y * k, k]; };
const frees = () => E(async () => (await window.__gcc.active().allAnnots()).filter((a) => a.type === 'FreeText'));
/** coloured pixels of the page inside a page-space box, as the app draws it */
async function inkIn(r) {
  const [x0, y0] = await at(r[0] + 2, r[1] + 2), [x1, y1] = await at(r[2] - 2, r[3] - 2);
  const buf = await win.screenshot({ clip: { x: x0, y: y0, width: Math.max(4, x1 - x0), height: Math.max(4, y1 - y0) } });
  const out = join(TMP, 'clip.png');
  (await import('node:fs')).writeFileSync(out, buf);
  return Number(execFileSync('python3', ['-c', `from PIL import Image\nim=Image.open(${JSON.stringify(out)}).convert('RGB')\nprint(sum(1 for p in im.getdata() if min(p)<110))`]).toString().trim());
}
const AR = 'الخرسانة المسلحة للأساسات';

// 1. the font list knows this PC's typefaces
await win.locator('.rtab', { hasText: /^Comment$/ }).click();
await win.locator('.ribbon [data-tool="textbox"]').click();
await sleep(300);
const fonts = await E(() => [...document.querySelectorAll('.props select')].flatMap((s) => [...s.querySelectorAll('optgroup')].map((g) => g.label + ':' + [...g.querySelectorAll('option')].map((o) => o.value).join(','))).join(' | '));
ok(/From this PC/.test(fonts) && /Arial/.test(fonts), 'font list: built-in + this PC (' + fonts.slice(0, 160) + ')');

// 2. type Arabic into a new text box
let [px, py] = await at(80, 120);
await win.mouse.click(px, py);
await win.locator('.ed.rich').waitFor({ timeout: 5000 });
await win.keyboard.insertText(AR);
ok(await E(() => document.querySelector('.ed.rich').matches(':dir(rtl)')), 'the typing box runs right to left for Arabic');
await win.locator('.edbar .done').click();
await sleep(1200);
let fr = await frees();
ok(fr.length === 1 && fr[0].contents === AR, 'saved with its Arabic text: ' + (fr[0] && fr[0].contents));
const arBox = fr[0].rect;
ok((await inkIn(arBox)) > 300, 'the Arabic shows in the box in the app (not an empty box)');

// 3. pick another typeface + bold for it in the right-hand panel
await win.locator('.ribbon [data-tool="select"]').first().click().catch(() => {});
{ const [cx, cy] = await at((arBox[0] + arBox[2]) / 2, (arBox[1] + arBox[3]) / 2); await win.mouse.click(cx, cy); }
await sleep(500);
const sel = win.locator('.props select').filter({ has: win.locator('optgroup') }).first();
await sel.selectOption('Calibri');
await sleep(800);
await win.locator('.props .bi-b').first().click();
await sleep(900);
fr = await frees();
ok(fr[0].font && fr[0].font.family === 'Calibri' && fr[0].font.bold === true, 'font changed to Calibri bold: ' + JSON.stringify(fr[0].font));
ok((await inkIn(fr[0].rect)) > 300, 'still drawn (Arabic letters come from a font that has them)');
await win.keyboard.press('Escape');

// 4. the tool's own default font: new boxes get it
await win.locator('.ribbon [data-tool="textbox"]').click();
await sleep(300);
// (the tool's settings are in the right-hand panel while the tool is picked)
await win.locator('.props select').filter({ has: win.locator('optgroup') }).first().selectOption('Times New Roman');
await win.locator('.props .bi-i').first().click();
[px, py] = await at(320, 120);
await win.mouse.click(px, py);
await win.locator('.ed.rich').waitFor({ timeout: 5000 });
await win.keyboard.insertText('Times italic note – “quoted”');
ok(await E(() => getComputedStyle(document.querySelector('.ed.rich')).fontStyle === 'italic'), 'the typing box shows the italic');
await win.keyboard.press('Control+Enter');
await sleep(1200);
fr = await frees();
const tn = fr.find((a) => a.contents.startsWith('Times'));
ok(tn && tn.font.family === 'Times New Roman' && tn.font.italic === true && !tn.font.bold, 'a new box takes the tool\'s font: ' + JSON.stringify(tn && tn.font));
ok(tn && (await inkIn(tn.rect)) > 200, 'and shows');

// 5. Arabic in a callout and a typewriter text
await E(async (ar) => {
  const d = window.__gcc.active();
  await d.create(0, { type: 'FreeText', rect: [300, 300, 520, 340], contents: ar, color: [1, 1, 1], bw: 1, font: { size: 12, color: [0.8, 0, 0] }, intent: 'FreeTextCallout', callout: [[250, 400]], kind: 'callout' });
  await d.create(0, { type: 'FreeText', rect: [60, 420, 260, 436], contents: 'مرحبا ' + ar, color: null, bw: 0, font: { size: 11, color: [0, 0, 0.6] }, kind: 'typewriter', autoWidth: 300 });
}, AR);
await sleep(1200);
fr = await frees();
const co = fr.find((a) => a.intent === 'FreeTextCallout'), tw = fr.find((a) => a.kind === 'typewriter');
ok(co && (await inkIn(co.rect)) > 200, 'Arabic callout shows');
ok(tw && (await inkIn(tw.rect)) > 150, 'Arabic typewriter text shows');

// 6. Arabic typed onto the page (Edit text)
await win.locator('.rtab', { hasText: /^Edit$/ }).click();
await win.locator('.ribbon [data-tool="edit-text"]').click();
await sleep(300);
const line = await E(async () => { const c = await window.__gcc.active().chars(0); const i = c.text.indexOf('0.7 The Contractor'); const b = c.box.slice(i * 4, i * 4 + 4); return Array.from(b); });
{ const [lx, ly] = await at(line[0] + 30, (line[1] + line[3]) / 2); await win.mouse.click(lx, ly); }
await win.locator('input.ed.line').waitFor({ timeout: 5000 });
await win.locator('input.ed.line').fill('يجب على المقاول توفير جميع العمالة');
await win.keyboard.press('Enter');
await sleep(1500);
const txt = await E(async () => (await window.__gcc.active().chars(0)).text);
ok(/المقاول/.test(txt), 'the Arabic line is real text on the page (found the right way round)');
ok(!/0\.7 The Contractor/.test(txt), 'and replaced the old line');

// 7. saved: other PDF programs draw it all (Poppler here)
const out = join(TMP, 'out.pdf');
await E((p) => window.__gcc.active().save(p), out);
await sleep(800);
execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', '-png', out, join(TMP, 'pop')]);
const pinks = JSON.parse(execFileSync('python3', ['-c', `
from PIL import Image
import json, glob
im = Image.open(glob.glob(${JSON.stringify(join(TMP, 'pop'))} + '*.png')[0]).convert('RGB')
boxes = ${JSON.stringify(fr.map((a) => a.rect))}
out = []
for r in boxes:
    c = im.crop((int(r[0]) + 2, int(r[1]) + 2, int(r[2]) - 2, int(r[3]) - 2))
    out.append(sum(1 for p in c.getdata() if min(p) < 110))
print(json.dumps(out))
`]).toString());
ok(pinks.every((n) => n > 50), 'every text box draws in another PDF program: ' + pinks.join(', '));
const fontsIn = execFileSync('python3', ['-c', `
import pikepdf
p = pikepdf.open(${JSON.stringify(out)})
names = set()
for a in p.pages[0].Annots:
    if str(a.Subtype) == '/FreeText':
        for k, v in a.AP.N.Resources.Font.items(): names.add(str(v.get('/BaseFont')))
print(' '.join(sorted(names)))
`]).toString().trim();
ok(/\+/.test(fontsIn), 'PC fonts are embedded as subsets: ' + fontsIn);

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
