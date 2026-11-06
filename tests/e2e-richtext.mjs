// Rich text in text boxes / callouts / typewriter text, as a person uses it: select a word, press
// Bold - only that word; colour, size, font, italic, underline per word; Ctrl+B/I/U; nothing
// selected = the whole box; undo inside the box; saved, opened again - still there, and in the
// file's standard rich text for other programs; plain boxes stay as they were.
// xvfb-run -a node tests/e2e-richtext.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-richtext');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const d0 = new mupdf.PDFDocument();
d0.insertPage(-1, d0.addPage([0, 0, 595, 842], 0, {}, '0.9 0.9 0.9 RG 1 w 40 40 515 762 re S'));
const FILE = join(TMP, 'page.pdf');
writeFileSync(FILE, d0.saveToBuffer('').asUint8Array());
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-richtext'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0, shotN = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else { fails++; void win.screenshot({ path: join(TMP, `fail-${++shotN}.png`) }).catch(() => {}); } return c; };
let app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=richtext', FILE] });
let win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
await sleep(800);
await win.evaluate(() => window.__gcc.viewer().fit('page'));
await sleep(600);
const E = (fn, a) => win.evaluate(fn, a);
const frees = () => E(async () => (await window.__gcc.active().annots(0)).filter((a) => a.type === 'FreeText').map((a) => ({ id: a.id, kind: a.kind, rect: a.rect, contents: a.contents, font: a.font, runs: a.runs })));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(80); } return null; };
async function at(x, y) { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const k = box.width / 595; return [box.x + x * k, box.y + y * k]; }
async function drag(a, b) { const p = await at(...a), q = await at(...b); await win.mouse.move(...p); await win.mouse.down(); await win.mouse.move(...q, { steps: 10 }); await win.mouse.up(); }
const pickTool = async (label, tab = 'Comment') => { await win.locator('.rtab', { hasText: tab }).click(); await win.locator('.ribbon .rb', { hasText: label }).first().click(); };
/** the typing box's text and the styled pieces in it */
const typing = () => E(() => { const el = document.querySelector('.ed.rich'); if (!el) return null; return { text: el.textContent, spans: [...el.querySelectorAll('span')].map((s) => ({ t: s.textContent, w: getComputedStyle(s).fontWeight, st: getComputedStyle(s).fontStyle, col: getComputedStyle(s).color, deco: getComputedStyle(s).textDecorationLine, size: parseFloat(getComputedStyle(s).fontSize) })) }; });
/** select text [s, e) in the typing box with the keyboard, as a person would */
async function selectChars(s, e) {
  await win.keyboard.press('Control+Home');
  for (let i = 0; i < s; i++) await win.keyboard.press('ArrowRight');
  for (let i = s; i < e; i++) await win.keyboard.press('Shift+ArrowRight');
}
const runOf = (a, word) => (a.runs || []).find((r) => r.t.includes(word));

try {
  // ---------------------------------------------------------------- a word in bold, only that word
  await pickTool('Text box');
  await drag([100, 120], [400, 170]);
  await until(() => win.locator('.ed.rich').count());
  ok(await win.locator('.ed.rich').count() === 1, 'the typing box opens');
  ok(await E(() => document.activeElement?.matches('.ed.rich')), 'the keyboard is in it');
  const T = 'Please check the beam depth here';
  await win.keyboard.type(T);
  await selectChars(17, 27);
  ok(await E(() => getSelection().toString()) === 'beam depth', 'selected: ' + await E(() => getSelection().toString()));
  await win.locator('.edbar .bi-b').click();
  await sleep(200);
  let ty = await typing();
  ok(ty && ty.text === T, 'text unchanged by the bold: ' + (ty && ty.text));
  ok(ty && ty.spans.some((s) => s.t === 'beam depth' && s.w === '700') && ty.spans.filter((s) => s.w === '700').every((s) => s.t === 'beam depth'), 'only "beam depth" bold while typing: ' + JSON.stringify(ty && ty.spans.map((s) => s.t + ':' + s.w)));
  ok(await E(() => getSelection().toString()) === 'beam depth', 'the selection stays after the bold');
  ok(await E(() => document.querySelector('.edbar .bi-b').classList.contains('on')), 'the B button shows on for the selection');
  ok(await E(() => document.activeElement?.matches('.ed.rich')), 'the keyboard stays in the text after the bar');
  // typing goes on: at the end, in the box's own style
  await win.keyboard.press('Control+End');
  ok(await E(() => !document.querySelector('.edbar .bi-b').classList.contains('on')), 'B off at the end of the plain text');
  await win.keyboard.type(' please');
  await win.locator('.edbar .done').click();
  await sleep(900);
  let fr = await frees();
  let tb = fr[0];
  ok(tb && tb.contents === T + ' please', 'saved text: ' + (tb && tb.contents));
  ok(tb && !tb.font.bold, 'the box itself is not bold');
  ok(tb && runOf(tb, 'beam depth')?.b === true && runOf(tb, 'beam depth').t === 'beam depth', 'runs in the file: ' + JSON.stringify(tb && tb.runs));
  ok(tb && (tb.runs || []).filter((r) => r.b).length === 1, 'nothing else bold');

  // ---------------------------------------------------------------- colour, size, italic, underline per word
  { const [cx, cy] = await at(tb.rect[0] + 20, tb.rect[1] + 8); await win.mouse.dblclick(cx, cy); }
  await until(() => win.locator('.ed.rich').count());
  ty = await typing();
  ok(ty && ty.spans.some((s) => s.t === 'beam depth' && s.w === '700'), 'opened again: the bold word shows bold');
  await selectChars(28, 32); // "here"
  await win.locator('.edbar .sw').nth(2).click(); // red
  await sleep(150);
  await win.locator('.edbar .barpick[title="Size"]').click();
  await win.locator('.edpop button', { hasText: /^16 pt$/ }).click();
  await sleep(150);
  await win.keyboard.press('Control+i');
  await win.keyboard.press('Control+u');
  await sleep(150);
  ty = await typing();
  const here = ty && ty.spans.find((s) => s.t === 'here');
  ok(here && /rgb\(217, 26, 26\)/.test(here.col) && here.st === 'italic' && /underline/.test(here.deco), 'while typing: "here" red, italic, underlined: ' + JSON.stringify(here));
  ok(here && Math.abs(here.size / (ty.spans.find((s) => s.t.startsWith('Please')).size) - 16 / 11) < 0.02, '"here" at 16 pt against 11 pt');
  ok(await E(() => document.querySelector('.edbar .barpick[title="Size"]').textContent.includes('16')), 'the bar shows the selection\'s size');
  ok(ty && ty.spans.filter((s) => s.st === 'italic').every((s) => s.t === 'here'), 'only "here" italic');
  // the font for one word
  await selectChars(0, 6); // "Please"
  await win.locator('.edbar .barpick[title="Font"]').click();
  await win.locator('.edpop button', { hasText: /^Times$/ }).click();
  await sleep(150);
  // Ctrl+B on a selection toggles that selection only
  await selectChars(7, 12); // "check"
  await win.keyboard.press('Control+b');
  await win.keyboard.press('ArrowRight');
  await sleep(200);
  const shotBox = async (name) => { const [x0, y0] = await at(tb.rect[0] - 10, tb.rect[1] - 10), [x1, y1] = await at(tb.rect[2] + 10, tb.rect[1] + 60); await win.screenshot({ path: join(TMP, name), clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }); };
  await shotBox('typing.png');
  await win.keyboard.press('Control+Enter');
  await sleep(900);
  await shotBox('typed.png');
  fr = await frees();
  tb = fr.find((a) => a.id === tb.id);
  const h = tb && runOf(tb, 'here');
  ok(h && h.t === 'here' && h.i === true && h.u === true && h.s === 16 && h.c && Math.abs(h.c[0] - 0.85) < 0.01, '"here" in the file: ' + JSON.stringify(h));
  ok(tb && runOf(tb, 'Please')?.f === 'TiRo' && runOf(tb, 'Please').t === 'Please', '"Please" in Times: ' + JSON.stringify(tb && runOf(tb, 'Please')));
  ok(tb && runOf(tb, 'check')?.b === true && runOf(tb, 'check').t === 'check', '"check" bold by Ctrl+B');
  ok(tb && tb.font.size === 11 && tb.font.family === 'Helv', 'the box keeps its own size and font: ' + JSON.stringify(tb && tb.font));
  // the line with 16 pt text is taller: the box grew to fit it
  ok(tb && tb.rect[3] - tb.rect[1] >= 16 * 1.2, 'box tall enough for the 16 pt word: ' + (tb && (tb.rect[3] - tb.rect[1]).toFixed(1)));

  // ---------------------------------------------------------------- nothing selected: the whole box
  { const [cx, cy] = await at(tb.rect[0] + 20, tb.rect[1] + 8); await win.mouse.dblclick(cx, cy); }
  await until(() => win.locator('.ed.rich').count());
  await win.keyboard.press('Control+End');
  await win.locator('.edbar .sw').nth(3).click(); // blue, whole box
  await sleep(700);
  fr = await frees();
  tb = fr.find((a) => a.id === tb.id);
  ok(tb && Math.abs(tb.font.color[2] - 0.75) < 0.01, 'nothing selected: the box\'s colour changes: ' + JSON.stringify(tb && tb.font.color));
  ty = await typing();
  ok(ty && ty.spans.every((s) => s.col === 'rgb(13, 77, 191)' || s.col === 'rgb(13, 76, 191)'), 'all of the text takes it (the red word too): ' + JSON.stringify(ty && ty.spans.map((s) => s.col)));
  // undo inside the box (Ctrl+Z) takes back the last style given to a selection
  await selectChars(0, 6);
  await win.keyboard.press('Control+b');
  ty = await typing();
  ok(ty && ty.spans.some((s) => s.t === 'Please' && s.w === '700'), 'Ctrl+B on "Please"');
  await win.keyboard.press('Control+z');
  ty = await typing();
  ok(ty && ty.spans.some((s) => s.t === 'Please' && s.w !== '700'), 'Ctrl+Z inside the box takes it back');
  await win.keyboard.press('Control+y');
  ty = await typing();
  ok(ty && ty.spans.some((s) => s.t === 'Please' && s.w === '700'), 'Ctrl+Y puts it back');
  await win.keyboard.press('Control+z');
  // Enter makes a new line, typed on in place
  await win.keyboard.press('Control+End');
  await win.keyboard.press('Enter');
  await win.keyboard.type('Second line');
  ty = await typing();
  ok(ty && ty.text.endsWith('please\nSecond line'), 'Enter: a new line: ' + JSON.stringify(ty && ty.text.slice(-20)));
  await win.keyboard.press('Control+Enter');
  await sleep(900);
  fr = await frees();
  tb = fr.find((a) => a.id === tb.id);
  ok(tb && tb.contents === 'Please check the beam depth here please\nSecond line', 'text with its new line: ' + JSON.stringify(tb && tb.contents));
  ok(tb && runOf(tb, 'Please')?.b !== true, 'the undone bold stayed undone');
  ok(tb && runOf(tb, 'beam depth')?.b === true && !runOf(tb, 'beam depth').c, 'bold word kept, its colour now the box\'s');

  // ---------------------------------------------------------------- a plain box stays plain
  await pickTool('Text box');
  await drag([100, 300], [300, 330]);
  await until(() => win.locator('.ed.rich').count());
  ok(await E(() => getComputedStyle(document.querySelector('.ed.rich'), '::before').content.includes('Type here')), 'a new box shows "Type here" until typed in');
  await win.keyboard.type('Plain note');
  ok(await E(() => getComputedStyle(document.querySelector('.ed.rich'), '::before').content === 'none'), '... and not once typed in');
  await win.keyboard.press('Control+a');
  await win.keyboard.press('Control+b');
  await win.keyboard.press('Control+Enter');
  await sleep(900);
  fr = await frees();
  const plain = fr.find((a) => a.contents === 'Plain note');
  ok(plain && plain.font.bold === true && !plain.runs, 'all of it bold = a bold box, no runs: ' + JSON.stringify(plain && { font: plain.font, runs: plain.runs }));

  // ---------------------------------------------------------------- Arabic with a styled word
  await E(async () => {
    const d = window.__gcc.active();
    const a = await d.create(0, { type: 'FreeText', rect: [100, 420, 360, 450], contents: '', color: [1, 1, 1], bw: 1, font: { size: 12, color: [0, 0, 0] }, kind: 'textbox', autoWidth: 300 });
    const runs = [{ t: 'ملاحظة ' }, { t: 'مهمة', b: true, c: [0.85, 0.1, 0.1] }, { t: ' للمقاول' }];
    await d.update([{ page: 0, id: a.id, patch: { contents: runs.map((r) => r.t).join(''), runs } }]);
  });
  await sleep(800);
  fr = await frees();
  const ar = fr.find((a) => a.contents.startsWith('ملاحظة'));
  ok(ar && runOf(ar, 'مهمة')?.b === true, 'Arabic box with a bold red word');

  // ---------------------------------------------------------------- saved and opened again
  const OUT = join(TMP, 'saved.pdf');
  await E((p) => window.__gcc.active().save(p), OUT);
  await sleep(500);
  const doc = mupdf.Document.openDocument(readFileSync(OUT), 'application/pdf');
  const page = doc.loadPage(0);
  const objs = page.getAnnotations().map((a) => ({ a, o: a.getObject() }));
  const rich = objs.find((x) => (x.o.get('Contents').isString() ? x.o.get('Contents').asString() : '').startsWith('Please'));
  const rc = rich && rich.o.get('RC').isString() ? rich.o.get('RC').asString() : '';
  ok(/font-weight:bold[^>]*>beam depth</.test(rc), 'the file\'s rich text (/RC) has "beam depth" bold for other programs');
  ok(/text-decoration:underline[^>]*>here</.test(rc) && /font-size:16pt[^>]*>here</.test(rc), '... and "here" underlined at 16 pt');
  ok(rich && !rich.o.get('DS').isNull(), 'and a default style (/DS)');
  ok(rich && rich.o.get('Contents').asString() === 'Please check the beam depth here please\nSecond line', '/Contents stays the plain text');
  const words = rich ? rich.a.toDisplayList().toStructuredText('').asText().replace(/\s+/g, ' ').trim() : '';
  ok(/Please check the beam depth here/.test(words) && /Second line/.test(words), 'the drawn text reads right (copy / search): ' + words);
  const fontsUsed = rich ? new Set([...rich.o.get('AP', 'N').readStream().asString().matchAll(/\/(\S+) [\d.]+ Tf/g)].map((m) => m[1])).size : 0;
  ok(fontsUsed >= 3, 'drawn in several fonts (regular, bold, Times...): ' + fontsUsed);
  const pl = objs.find((x) => x.o.get('Contents').isString() && x.o.get('Contents').asString() === 'Plain note');
  ok(pl && pl.o.get('RC').isNull() && pl.o.get('GCCRuns').isNull(), 'the plain box has no rich text in the file (saved as before)');
  writeFileSync(join(TMP, 'page.png'), page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true).asPNG());

  // opened again in the app: the styles come back
  await app.close();
  app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=richtext', OUT] });
  win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
  await sleep(800);
  fr = await frees();
  const back = fr.find((a) => a.contents.startsWith('Please'));
  ok(back && runOf(back, 'beam depth')?.b === true && runOf(back, 'here')?.s === 16, 'opened again: the styles are there: ' + JSON.stringify(back && back.runs));

  // edited after opening again: a selection of two sizes shows none - picking 11 pt sets all of it
  await win.evaluate(() => window.__gcc.viewer().fit('page'));
  await sleep(500);
  { const [cx, cy] = await at(back.rect[0] + 20, back.rect[1] + 8); await win.mouse.dblclick(cx, cy); }
  await until(() => win.locator('.ed.rich').count());
  await selectChars(22, 32); // "depth here"
  await sleep(150);
  ok(await E(() => document.querySelector('.edbar .barpick[title="Size"]').textContent.trim() === '—'), 'mixed sizes selected: the size shows "—"');
  await win.locator('.edbar .barpick[title="Size"]').click();
  await win.locator('.edpop button', { hasText: /^11 pt$/ }).click();
  await sleep(150);
  await win.keyboard.press('Control+Enter');
  await sleep(900);
  fr = await frees();
  const b2 = fr.find((a) => a.id === back.id);
  ok(b2 && !runOf(b2, 'here')?.s && runOf(b2, 'here')?.i === true, '11 pt picked: "here" back to the box\'s size, still italic: ' + JSON.stringify(b2 && b2.runs));
} catch (e) {
  console.log('FAIL exception', e);
  fails++;
}
console.log(`\n${passes} passed, ${fails} failed`);
// (the file has unsaved changes at the end: closing would ask - not waited for)
await Promise.race([app.close(), sleep(4000)]);
try { app.process().kill(); } catch { /* gone */ }
process.exit(fails ? 1 : 0);
