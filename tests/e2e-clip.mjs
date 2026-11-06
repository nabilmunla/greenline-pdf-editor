// Clipboard (Electron 44 changed its API - every copy/paste had silently stopped working):
// copy selected text, copy a table (text + html), snapshot picture, paste picture.
// xvfb-run -a node tests/e2e-clip.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';

const TMP = resolve('tests/tmp-clip');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'spec.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-clip'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=clip', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.waitForFunction(() => window.__gcc?.active()?.pages.length > 0, null, { timeout: 60000 });
await sleep(800);
const read = () => app.evaluate(async ({ clipboard }) => { const out = {}; for (const it of await clipboard.read()) for (const t of it.types) if (/^(text\/plain|text\/html|image\/png)$/.test(t)) { const b = await it.getType(t); out[t] = t === 'image/png' ? (await b.arrayBuffer()).byteLength : await b.text(); } return out; });

await win.evaluate(() => window.gcc.copyText('plain words'));
ok((await read())['text/plain'] === 'plain words', 'copy text');
await win.evaluate(() => window.gcc.copyText('a\tb', '<table><tr><td>a</td><td>b</td></tr></table>'));
const t = await read();
ok(t['text/plain'] === 'a\tb' && /<td>a<\/td>/.test(t['text/html'] || ''), 'copy a table: text and html (Excel takes the html)');
// select text on the page with the mouse, Ctrl+C
const box = await win.locator('.pg[data-page="0"]').boundingBox();
const k = box.width / (await win.evaluate(() => window.__gcc.active().pages[0].w));
const c0 = await win.evaluate(async () => { const c = await window.__gcc.active().chars(0); for (let i = 0; i < c.text.length; i++) if (/\w/.test(c.text[i]) && c.box[i * 4 + 2] > c.box[i * 4]) return [c.box[i * 4], c.box[i * 4 + 1], c.box[i * 4 + 3]]; return null; });
if (c0) {
  const y = box.y + ((c0[1] + c0[2]) / 2) * k;
  await win.mouse.move(box.x + (c0[0] + 1) * k, y); await win.mouse.down(); await win.mouse.move(box.x + (c0[0] + 120) * k, y, { steps: 8 }); await win.mouse.up();
  await win.keyboard.press('Control+c');
  await sleep(400);
  const r = await read();
  ok((r['text/plain'] || '').trim().length > 3 && r['text/plain'] !== 'a\tb', 'Ctrl+C on selected page text: ' + JSON.stringify(r['text/plain']));
}
// a picture: copy, then paste back (Paste picture)
const png = await win.evaluate(async () => { const c = new OffscreenCanvas(30, 20); const g = c.getContext('2d'); g.fillStyle = '#c00'; g.fillRect(0, 0, 30, 20); return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())]; });
await win.evaluate((b) => window.gcc.copyImage(new Uint8Array(b)), png);
ok((await read())['image/png'] > 50, 'copy a picture (snapshot)');
const back = await win.evaluate(async () => { const r = await window.gcc.pasteImage(); return r ? r.length : 0; });
ok(back > 50, 'paste a picture: ' + back + ' bytes');
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
