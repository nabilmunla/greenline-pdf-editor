// PLAN 8.2: right-click in a text box / form field shows a native menu - spelling suggestions,
// Add to dictionary, Cut / Copy / Paste / Select all. The app runs with --no-menu-popup: the menu's
// labels are recorded on the window record (nothing is popped up). A tiny English dictionary is
// built here and served to the window, so a real misspelling ("teh") is underlined and suggested
// with no network. xvfb-run -a node tests/e2e-spell.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-spell');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// ---------------------------------------------------------------- a small Chromium dictionary (.bdic)
// (format: third_party/hunspell/google/bdict.h - header, an aff part, then the words in a trie of
// list nodes; a word's end is a 0 entry leading to a 2-byte leaf)
function makeBdic(words) {
  const root = {};
  for (const w of words) { let n = root; for (const b of Buffer.from(w, 'utf8')) n = n[b] ??= {}; n[0] = true; }
  const enc = (node) => {
    const keys = Object.keys(node).map(Number).sort((a, b) => a - b);
    if (keys.length > 15) throw new Error('more than 15 letters in one place');
    const kids = keys.map((k) => (k === 0 ? Buffer.from([0, 0]) : enc(node[k])));
    const head = Buffer.alloc(1 + keys.length * 3);
    head[0] = 0xf0 | keys.length;
    let off = 0;
    keys.forEach((k, i) => { head[1 + i * 3] = k; head.writeUInt16LE(off, 2 + i * 3); off += kids[i].length; });
    return Buffer.concat([head, ...kids]);
  };
  const other = Buffer.from("SET UTF-8\nTRY esianrtolcdugmphbyfvkwzESIANRTOLCDUGMPHBYFVKWZ'\n\0");
  const affHeader = Buffer.alloc(16);
  const aff = 32;
  affHeader.writeUInt32LE(aff + 16, 0); // affix groups: none (just the end byte)
  affHeader.writeUInt32LE(aff + 17, 4); // affix rules: none
  affHeader.writeUInt32LE(aff + 18, 8); // replacements: none
  affHeader.writeUInt32LE(aff + 19, 12); // other rules
  const affPart = Buffer.concat([affHeader, Buffer.from([0, 0, 0]), other, Buffer.alloc(8)]);
  const dicOffset = aff + affPart.length;
  const body = Buffer.concat([affPart, enc(root)]);
  const header = Buffer.alloc(32);
  header.write('BDic', 0, 'latin1');
  header.writeUInt16LE(2, 4); header.writeUInt16LE(0, 6);
  header.writeUInt32LE(aff, 8); header.writeUInt32LE(dicOffset, 12);
  createHash('md5').update(body).digest().copy(header, 16);
  return Buffer.concat([header, body]);
}
const WORDS = ['the', 'tech', 'tea', 'ten', 'tee', 'tel', 'please', 'check', 'beam', 'depth', 'here', 'is', 'a', 'name', 'and', 'of'];
const server = createServer((req, res) => { res.setHeader('content-type', 'application/octet-stream'); res.end(makeBdic(WORDS)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const DICT_URL = `http://127.0.0.1:${server.address().port}/dict/`;

// ---------------------------------------------------------------- a page with a text form field
const raw = `%PDF-1.7
1 0 obj<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[4 0 R]/DA(/Helv 0 Tf 0 g)/DR<</Font<</Helv 5 0 R>>>>>>>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Annots[4 0 R]/Resources<<>>>>endobj
4 0 obj<</Type/Annot/Subtype/Widget/FT/Tx/T(name)/V()/Rect[100 700 400 730]/F 4/DA(/Helv 12 Tf 0 g)/P 3 0 R>>endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R/Size 6>>
`;
const FILE = join(TMP, 'form.pdf');
writeFileSync(FILE, mupdf.PDFDocument.openDocument(Buffer.from(raw), 'application/pdf').saveToBuffer('').asUint8Array());
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-spell'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0, shotN = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else { fails++; void win.screenshot({ path: join(TMP, `fail-${++shotN}.png`) }).catch(() => {}); } return c; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=spell', '--no-menu-popup', FILE] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
await sleep(800);
await win.evaluate(() => window.__gcc.viewer().fit('page'));
await sleep(600);
const E = (fn, a) => win.evaluate(fn, a);
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(80); } return null; };

try {
  // the window's spelling language is English, from the dictionary served above
  const dictErr = await app.evaluate(({ session }, url) => new Promise((done) => {
    const s = session.defaultSession;
    const t = setTimeout(() => done('no dictionary after 20 s'), 20000);
    s.once('spellcheck-dictionary-initialized', () => { clearTimeout(t); done(''); });
    s.once('spellcheck-dictionary-download-failure', (_e, l) => { clearTimeout(t); done('download failed: ' + l); });
    s.setSpellCheckerDictionaryDownloadURL(url);
    s.setSpellCheckerLanguages([]);
    s.setSpellCheckerLanguages(['en-US']);
  }), DICT_URL);
  ok(!dictErr, 'test dictionary loaded' + (dictErr ? ' - ' + dictErr : ''));

  // what the last right-click menu showed (null: none since the last reset)
  const menu = () => app.evaluate(() => [...globalThis.__pdfedWins.values()][0].lastMenu ?? null).catch(() => null);
  const resetMenu = () => app.evaluate(() => { for (const w of globalThis.__pdfedWins.values()) w.lastMenu = null; }).catch(() => {});
  const EDIT = ['Cut', 'Copy', 'Paste', 'Select all'];
  const tail = (m) => m && m.slice(-4).join('|') === EDIT.join('|');
  async function at(x, y) { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const k = box.width / 595; return [box.x + x * k, box.y + y * k]; }
  /** centre of `word` inside the typing box (text nodes) */
  const wordPos = (word) => E((w) => {
    const el = document.querySelector('.ed.rich');
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length);
      const b = r.getBoundingClientRect();
      return [b.x + b.width / 2, b.y + b.height / 2];
    }
    return null;
  }, word);
  /** centre of `word` in a textarea / input (measured with the box's own font) */
  const inputWordPos = (word) => E((w) => {
    const el = document.querySelector('textarea.ed, input.ed');
    const cs = getComputedStyle(el), c = document.createElement('canvas').getContext('2d');
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const i = el.value.indexOf(w), b = el.getBoundingClientRect();
    const x0 = b.x + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) + c.measureText(el.value.slice(0, i)).width;
    return [x0 + c.measureText(w).width / 2, b.y + b.height / 2];
  }, word);
  /** right-click on a misspelled word until the menu has suggestions (Chromium underlines a word a
   *  second or two after it is typed; clicking again and again keeps delaying that, so wait between) */
  async function rightClickWord(posFn, word) {
    let m = null;
    for (let i = 0; i < 8 && !(m && m.length > 4); i++) {
      await sleep(i ? 2000 : 1500);
      await resetMenu();
      const [x, y] = await posFn(word);
      await win.mouse.click(x, y, { button: 'right' });
      m = await until(() => menu(), 1500);
    }
    return m;
  }

  // ---------------------------------------------------------------- a text box (RichBox)
  await win.locator('.rtab', { hasText: 'Comment' }).click();
  await win.locator('.ribbon .rb', { hasText: 'Text box' }).first().click();
  { const p = await at(100, 300), q = await at(420, 360); await win.mouse.move(...p); await win.mouse.down(); await win.mouse.move(...q, { steps: 8 }); await win.mouse.up(); }
  await until(() => win.locator('.ed.rich').count());
  const T = 'Please check teh beam depth here ';
  await win.keyboard.type(T);
  let m = await rightClickWord(wordPos, 'teh');
  ok(!!m, 'right-click on a misspelled word in a text box: a menu reaches main ' + JSON.stringify(m));
  ok(m && m[0] === 'the', 'first suggestion is "the"');
  ok(m && m.indexOf('Add to dictionary') > 0 && m.indexOf('Add to dictionary') <= 5 && m[m.indexOf('Add to dictionary') + 1] === '-' && tail(m), 'then Add to dictionary, a separator, Cut / Copy / Paste / Select all');
  ok(m && m.filter((x, i) => i < m.indexOf('Add to dictionary')).length <= 5, 'at most 5 suggestions');
  ok(await win.locator('.ed.rich').count() === 1, 'the editor stays open after the right-click');
  ok(await E(() => document.querySelector('.ed.rich').textContent) === T, 'its text is untouched: ' + JSON.stringify(await E(() => document.querySelector('.ed.rich').textContent)));
  ok(await E(() => document.activeElement?.matches('.ed.rich')), 'and it still has the keyboard');
  // a right-click on a correct word: the edit items only
  await resetMenu();
  { const [x, y] = await wordPos('beam'); await win.mouse.click(x, y, { button: 'right' }); }
  m = await until(() => menu());
  ok(m && m.join('|') === EDIT.join('|'), 'right-click on a correct word: only the edit items ' + JSON.stringify(m));

  // picking "the" (what the menu's item calls): the text changes, and the editor's own state has it
  await rightClickWord(wordPos, 'teh');
  await app.evaluate(() => { const w = [...globalThis.__pdfedWins.values()][0]; w.win.webContents.replaceMisspelling('the'); });
  const fixed = await until(() => E(() => { const t = document.querySelector('.ed.rich')?.textContent; return t && !t.includes('teh') ? t : null; }), 4000);
  ok(fixed === 'Please check the beam depth here ', 'replaceMisspelling changed the text in the box: ' + JSON.stringify(fixed));
  await win.locator('.edbar .done').click();
  await sleep(900);
  const frees = () => E(async () => (await window.__gcc.active().annots(0)).filter((a) => a.type === 'FreeText').map((a) => ({ id: a.id, contents: a.contents })));
  let fr = await frees();
  ok(fr.length === 1 && fr[0].contents.trim() === 'Please check the beam depth here', 'saved annotation text read back: ' + JSON.stringify(fr[0]?.contents));

  // ---------------------------------------------------------------- a callout's editor
  await win.keyboard.press('Escape');
  await win.locator('.ribbon .rb', { hasText: 'Callout' }).first().click();
  { const p = await at(120, 520); await win.mouse.click(...p); const q = await at(300, 560); await win.mouse.click(...q); }
  await until(() => win.locator('.ed.rich').count());
  await win.keyboard.type('Please check teh beam ');
  m = await rightClickWord(wordPos, 'teh');
  ok(m && m[0] === 'the' && tail(m), 'callout editor: suggestions and edit items ' + JSON.stringify(m));
  ok(await win.locator('.ed.rich').count() === 1 && await E(() => document.querySelector('.ed.rich').textContent) === 'Please check teh beam ', 'callout editor still open with its text');
  await win.keyboard.press('Escape');
  await sleep(500);

  // ---------------------------------------------------------------- a form field (a plain textarea)
  await win.locator('.ribbon [data-tool="select"]').first().click().catch(() => {});
  await win.keyboard.press('Escape');
  { const p = await at(150, 120); await win.mouse.click(...p); }
  await until(() => win.locator('textarea.ed.field').count());
  ok(await win.locator('textarea.ed.field').count() === 1, 'the form field opens for typing');
  await win.keyboard.type('teh name ');
  m = await rightClickWord(inputWordPos, 'teh');
  ok(m && m[0] === 'the' && tail(m), 'form field: suggestions and edit items ' + JSON.stringify(m));
  ok(await win.locator('textarea.ed.field').count() === 1 && await E(() => document.querySelector('textarea.ed.field').value) === 'teh name ', 'the field is still open with its text');
  await app.evaluate(() => { const w = [...globalThis.__pdfedWins.values()][0]; w.win.webContents.replaceMisspelling('the'); });
  const fv = await until(() => E(() => { const v = document.querySelector('textarea.ed.field')?.value; return v && !v.includes('teh') ? v : null; }), 4000);
  ok(fv === 'the name ', 'replaceMisspelling changed the text in the field: ' + JSON.stringify(fv));
  await win.keyboard.press('Enter'); // finishes a one-line field: the value must be the replaced one
  await sleep(900);
  const val = await E(async () => (await window.__gcc.active().annots(0)).find((a) => a.type === 'Widget')?.field?.value);
  ok(typeof val === 'string' && val.trim() === 'the name', 'the field\'s saved value read back: ' + JSON.stringify(val));

  // ---------------------------------------------------------------- a field of the window itself: edit items only
  const inp = await E(() => { const i = [...document.querySelectorAll('input')].find((x) => (!x.type || x.type === 'text' || x.type === 'number') && x.offsetParent && !x.closest('.viewer')); if (!i) return null; const b = i.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
  ok(!!inp, 'a text field of the window found');
  if (inp) {
    await resetMenu();
    await win.mouse.click(inp[0], inp[1], { button: 'right' });
    m = await until(() => menu());
    ok(m && m.join('|') === EDIT.join('|'), 'right-click in a window field: Cut / Copy / Paste / Select all ' + JSON.stringify(m));
    await win.keyboard.press('Escape');
  }

  // ---------------------------------------------------------------- a mocked event: the template main builds
  const emit = (p) => app.evaluate((_x, params) => { const w = [...globalThis.__pdfedWins.values()][0]; w.lastMenu = null; w.win.webContents.emit('context-menu', {}, params); return w.lastMenu; }, p);
  const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
  m = await emit({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech', 'tea', 'ten', 'tee', 'tel', 'tew'], editFlags: flags });
  ok(m && m.join('|') === ['the', 'tech', 'tea', 'ten', 'tee', 'Add to dictionary', '-', ...EDIT].join('|'), 'mocked spelling params: 5 suggestions, Add to dictionary, edit items ' + JSON.stringify(m));
  m = await emit({ isEditable: true, misspelledWord: 'qwzx', dictionarySuggestions: [], editFlags: flags });
  ok(m && m[0] === 'No suggestions', 'no suggestions: the greyed line');
  m = await emit({ isEditable: false, misspelledWord: '', dictionarySuggestions: [], editFlags: flags });
  ok(m === null, 'not editable: nothing recorded');

  // ---------------------------------------------------------------- the app's own right-click menus still work
  await win.keyboard.press('Escape');
  await resetMenu();
  { const p = await at(450, 600); await win.mouse.click(...p, { button: 'right' }); }
  ok(!!(await until(() => win.locator('.cmenu button').count())), 'right-click on the page: the app\'s own menu opens');
  await sleep(300);
  ok(await menu() === null, 'and no text-box menu came with it');
  await win.keyboard.press('Escape');
} catch (e) {
  console.log('FAIL exception: ' + (e && e.stack || e));
  fails++;
}
console.log(`\n${passes} passed, ${fails} failed`);
server.close();
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(fails ? 1 : 0);
