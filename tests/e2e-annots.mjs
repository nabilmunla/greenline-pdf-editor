// Markup behaviour as a person uses it: text boxes and callouts (move before typing, select
// text while typing, align, move after typing), typewriter, Escape, redaction box colour.
// xvfb-run -a node tests/e2e-annots.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-annots');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
// a plain page with a coloured background band (for "match page" redaction)
const d = new mupdf.PDFDocument();
const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, '0.86 0.92 0.98 rg 0 0 595 300 re f 0 g BT /F1 14 Tf 60 100 Td (CONFIDENTIAL AMOUNT AED 1,234,567) Tj ET BT /F1 12 Tf 60 700 Td (Some text near the top) Tj ET'));
const FILE = join(TMP, 'page.pdf');
writeFileSync(FILE, d.saveToBuffer('').asUint8Array());
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-annots'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let shotN = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { fails++; void win.screenshot({ path: join(TMP, `fail-${++shotN}.png`) }).catch(() => {}); } return c; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=annots', FILE] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
await sleep(800);
// the whole page on screen (every click below lands on it)
await win.evaluate(() => window.__gcc.viewer().fit('page'));
await sleep(600);
const E = (fn, a) => win.evaluate(fn, a);
const annots = () => E(async () => (await window.__gcc.active().annots(0)).map((a) => ({ id: a.id, type: a.type, kind: a.kind, rect: a.rect, callout: a.callout, contents: a.contents, quadding: a.quadding, font: a.font, redactFill: a.redactFill, autoWidth: a.autoWidth })));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(80); } return null; };
async function at(x, y) {
  const box = await win.locator('.pg[data-page="0"]').boundingBox();
  const k = box.width / 595;
  return [box.x + x * k, box.y + y * k];
}
const kz = async () => { const box = await win.locator('.pg[data-page="0"]').boundingBox(); return box.width / 595; };
async function drag(a, b) { const p = await at(...a), q = await at(...b); await win.mouse.move(...p); await win.mouse.down(); await win.mouse.move(...q, { steps: 10 }); await win.mouse.up(); }
async function click(a) { const p = await at(...a); await win.mouse.click(...p); }
const tool = (t) => E((x) => window.__gcc.viewer() && document.dispatchEvent(new CustomEvent('noop')) || x, t);
void tool;
const pickTool = async (label, tab = 'Comment') => { await win.locator('.rtab', { hasText: tab }).click(); await win.locator('.ribbon .rb', { hasText: label }).first().click(); };

// ---------------------------------------------------------------- text box
await pickTool('Text box');
await drag([100, 400], [300, 440]);
await until(() => win.locator('.ed.rich').count());
ok(await win.locator('.ed.rich').count() === 1, 'text box: typing opens straight away');
ok(await win.locator('.edbar').count() === 1, 'text box: text settings bar shown');
let tb = (await annots()).find((a) => a.kind === 'textbox');
// grab its frame (just above the box) and move it - before typing anything
const k = await kz();
const fx = tb.rect[0] + 40, fy = tb.rect[1] - 10 / k;
await drag([fx, fy], [fx + 60, fy + 50]);
await sleep(500);
let after = (await annots()).find((a) => a.id === tb.id);
ok(!!after, 'text box: still there after moving it before typing (it used to vanish)');
ok(after && Math.abs(after.rect[0] - tb.rect[0] - 60) < 3 && Math.abs(after.rect[1] - tb.rect[1] - 50) < 3, `text box: moved by the drag (${tb.rect.map(Math.round)} -> ${after?.rect.map(Math.round)})`);
// now type in it
await (async () => { const p = await at(after.rect[0] + 20, after.rect[1] + 10); await win.mouse.dblclick(...p); })();
await until(() => win.locator('.ed.rich').count());
await win.keyboard.type('First line of the note');
// click inside the text: the caret moves, typing goes on (it used to finish the text box)
const inside = await at(after.rect[0] + 10, after.rect[1] + 8);
await win.mouse.click(...inside); await win.mouse.move(inside[0] + 200, inside[1] + 200); await sleep(600);
await sleep(200);
ok(await win.locator('.ed.rich').count() === 1, 'text box: clicking in the text keeps typing');
// select text with the mouse inside it
{
  const t = await win.locator('.ed.rich').boundingBox();
  await win.mouse.move(t.x + 8, t.y + 10); await win.mouse.down(); await win.mouse.move(t.x + 80, t.y + 10, { steps: 6 }); await win.mouse.up();
  const selLen = await E(() => { const t = document.querySelector('.ed.rich'); return t ? getSelection().toString().length : -1; });
  ok(selLen > 0, `text box: text can be selected with the mouse while typing (${selLen} chars)`);
}
await win.keyboard.press('Control+End');
await win.keyboard.type(' and more text that wraps onto the next lines of the box');
// centre it from the bar
await win.locator('.edbar .al').nth(1).click();
await sleep(300);
ok(await win.locator('.ed.rich').count() === 1, 'text box: still typing after using the bar');
ok(await E(() => getComputedStyle(document.querySelector('.ed.rich')).textAlign === 'center'), 'text box: centred while typing');
// the size from the bar (a <select> there never opened: the bar stops mousedown to keep the typing)
await win.locator('.edbar .barpick[title="Size"]').click();
await sleep(200);
ok(await win.locator('.edpop').count() === 1, 'text box: size list opens from the bar');
await win.locator('.edpop button', { hasText: /^24 pt$/ }).click();
await sleep(500);
ok(await win.locator('.edpop').count() === 0, 'text box: size list closes after the pick');
ok(await win.locator('.ed.rich').count() === 1, 'text box: still typing after picking a size');
ok(await E(() => document.activeElement?.matches('.ed.rich')), 'text box: the keyboard stays in the text');
ok(await until(async () => (await annots()).find((a) => a.id === tb.id)?.font?.size === 24), 'text box: 24 pt in the file');
ok(await E(() => /24/.test(document.querySelector('.edbar .barpick[title="Size"]').textContent)), 'text box: the bar shows 24 pt');
// the font from the bar too; Escape closes the list only
await win.locator('.edbar .barpick[title="Font"]').click();
await sleep(200);
await win.keyboard.press('Escape');
await sleep(200);
ok(await win.locator('.edpop').count() === 0 && await win.locator('.ed.rich').count() === 1, 'text box: Escape closes the font list, typing goes on');
await win.locator('.edbar .barpick[title="Font"]').click();
await win.locator('.edpop button', { hasText: /^Times$/ }).click();
await sleep(500);
ok(await until(async () => (await annots()).find((a) => a.id === tb.id)?.font?.family === 'TiRo'), 'text box: Times picked from the bar');
await win.keyboard.type(' typed on');
ok(await E(() => document.querySelector('.ed.rich')?.textContent.endsWith('typed on')), 'text box: typing goes on after the picks');
// back to 12 pt Helvetica for the rest of the test
await win.locator('.edbar .barpick[title="Size"]').click();
await win.locator('.edpop button', { hasText: /^12 pt$/ }).click();
await win.locator('.edbar .barpick[title="Font"]').click();
await win.locator('.edpop button', { hasText: /^Helvetica$/ }).click();
await sleep(300);
await win.keyboard.press('Control+End');
for (let i = 0; i < ' typed on'.length; i++) await win.keyboard.press('Backspace');
// click on the page elsewhere: done
await click([450, 750]);
await sleep(600);
tb = (await annots()).find((a) => a.id === tb.id);
ok(tb && tb.contents.startsWith('First line of the note and more'), 'text box: text kept: ' + JSON.stringify(tb?.contents));
ok(tb && tb.quadding === 1, 'text box: centred in the file');

// select it and move it by dragging its body
await click([tb.rect[0] + 30, tb.rect[1] + 8]);
await sleep(200);
await drag([tb.rect[0] + 30, tb.rect[1] + 8], [tb.rect[0] + 30, tb.rect[1] - 92]);
await sleep(500);
const tb2 = (await annots()).find((a) => a.id === tb.id);
ok(tb2 && Math.abs(tb2.rect[1] - tb.rect[1] + 100) < 3, `text box: moves when dragged after typing (${tb.rect.map(Math.round)} -> ${tb2?.rect.map(Math.round)})`);
// Enter on the selected box: type again; Escape keeps the text
await win.keyboard.press('Enter');
await until(() => win.locator('.ed.rich').count());
await win.keyboard.press('Control+End');
await win.keyboard.type('!');
await win.keyboard.press('Escape');
await sleep(500);
ok(((await annots()).find((a) => a.id === tb.id)?.contents || '').endsWith('!'), 'text box: Enter to edit, Escape keeps what was typed');

// ---------------------------------------------------------------- a clicked text box fits its text
await win.keyboard.press('Escape');
await pickTool('Text box');
await click([80, 240]);
await until(() => win.locator('.ed.rich').count());
const w0 = (await win.locator('.ed.rich').boundingBox()).width;
await win.keyboard.type('Short');
const w1 = (await win.locator('.ed.rich').boundingBox()).width;
await win.keyboard.type(' and then a lot more words so that the box has to wrap onto a second line at some point');
await sleep(150);
const bb2 = await win.locator('.ed.rich').boundingBox();
ok(w0 < 90 * (await kz()) && w1 < 90 * (await kz()) && bb2.width > w1 * 3 && bb2.height > 30 * (await kz()), `clicked text box: small, grows with the typing, then wraps (${Math.round(w0)} -> ${Math.round(w1)} -> ${Math.round(bb2.width)} x ${Math.round(bb2.height)} px)`);
await click([450, 790]);
await sleep(600);
let fit = (await annots()).find((a) => a.contents?.startsWith('Short and then'));
ok(fit && fit.autoWidth > 0 && fit.rect[2] - fit.rect[0] <= fit.autoWidth + 2 && fit.rect[3] - fit.rect[1] > 25, 'clicked text box: saved fitting its text ' + fit?.rect.map(Math.round));
// given a size by hand: keeps it
const fk = await kz();
await click([(fit.rect[0] + fit.rect[2]) / 2, fit.rect[1] + 6]);
await sleep(300);
await drag([fit.rect[2] + 7 / fk, fit.rect[3] + 7 / fk], [fit.rect[2] - 60 + 7 / fk, fit.rect[3] + 40 + 7 / fk]);
await sleep(600);
const fit2 = (await annots()).find((a) => a.id === fit.id);
ok(fit2 && !fit2.autoWidth && Math.abs(fit2.rect[2] - (fit.rect[2] - 60)) < 3, 'resized by hand: keeps that width ' + fit2?.rect.map(Math.round));
await win.keyboard.press('Escape');

// ---------------------------------------------------------------- callout
await win.keyboard.press('Escape');
await pickTool('Callout');
await click([120, 560]);
await click([300, 600]);
await until(() => win.locator('.ed.rich').count());
let co = (await annots()).find((a) => a.kind === 'callout');
ok(!!co && co.callout && Math.abs(co.callout[0][0] - 120) < 2 && Math.abs(co.callout[0][1] - 560) < 2, 'callout: arrow tip where clicked ' + JSON.stringify(co?.callout) + ' ' + JSON.stringify(co?.rect));
if (!co) { await win.screenshot({ path: join(TMP, 'callout.png') }); console.log('STATE', JSON.stringify(await annots()), await E(() => document.querySelector('.ribbon .rb.on')?.textContent)); await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {}); process.exit(1); }
ok(co.rect[2] - co.rect[0] < 60, 'callout: a clicked callout starts small: ' + Math.round(co.rect[2] - co.rect[0]) + ' pt');
// move it before typing (by its frame)
const cfx = (co.rect[0] + co.rect[2]) / 2, cfy = co.rect[1] - 10 / k;
await drag([cfx, cfy], [cfx + 80, cfy - 60]);
await sleep(500);
let co2 = (await annots()).find((a) => a.id === co.id);
ok(!!co2, 'callout: still there after moving it before typing');
ok(co2 && Math.abs(co2.rect[0] - co.rect[0] - 80) < 3, 'callout: box moved');
ok(co2 && Math.abs(co2.callout[0][0] - 120) < 2 && Math.abs(co2.callout[0][1] - 560) < 2, `callout: arrow tip stays where it points (${co2?.callout?.[0].map(Math.round)})`);
const end = co2?.callout?.[co2.callout.length - 1];
ok(end && end[0] >= co2.rect[0] - 1 && end[0] <= co2.rect[2] + 1 && end[1] >= co2.rect[1] - 1 && end[1] <= co2.rect[3] + 1, 'callout: line ends on the box');
// type, then move again
await (async () => { const p = await at(co2.rect[0] + 20, co2.rect[1] + 10); await win.mouse.dblclick(...p); })();
await until(() => win.locator('.ed.rich').count());
await win.keyboard.type('Check this detail');
await click([450, 780]);
await sleep(500);
co2 = (await annots()).find((a) => a.id === co.id);
await click([co2.rect[0] + 20, co2.rect[1] + 8]);
await drag([co2.rect[0] + 20, co2.rect[1] + 8], [co2.rect[0] + 20, co2.rect[1] + 88]);
await sleep(500);
const co3 = (await annots()).find((a) => a.id === co.id);
ok(co3 && co3.contents === 'Check this detail', 'callout: text kept');
ok(co3 && co3.rect[2] - co3.rect[0] > 60 && co3.rect[2] - co3.rect[0] < 140 && co3.rect[3] - co3.rect[1] < 30, 'callout: the box fits the text (one line): ' + co3?.rect.map(Math.round));
ok(co3 && Math.abs(co3.rect[1] - co2.rect[1] - 80) < 3, 'callout: moved after typing');
ok(co3 && co3.callout.every((p) => p.every(Number.isFinite)) && Math.abs(co3.callout[0][0] - 120) < 2, `callout: arrow stays on the page, tip unchanged (${JSON.stringify(co3?.callout?.map((p) => p.map(Math.round)))})`);
// drag the tip somewhere else
await drag(co3.callout[0], [200, 520]);
await sleep(500);
const co4 = (await annots()).find((a) => a.id === co.id);
ok(co4 && Math.abs(co4.callout[0][0] - 200) < 3 && Math.abs(co4.callout[0][1] - 520) < 3, 'callout: tip can be dragged');

// ---------------------------------------------------------------- an empty new box: clicking elsewhere removes it
await win.keyboard.press('Escape');
await pickTool('Text box');
await drag([350, 200], [500, 230]);
await until(() => win.locator('.ed.rich').count());
const n0 = (await annots()).length;
await click([450, 790]);
await sleep(500);
ok((await annots()).length === n0 - 1, 'an empty new text box goes away when you click elsewhere');

// ---------------------------------------------------------------- typewriter
await pickTool('Typewriter');
await click([60, 820]);
await until(() => win.locator('.ed.rich').count());
await win.keyboard.type('Typed straight on the page');
await click([450, 650]);
await sleep(500);
ok((await annots()).some((a) => a.kind === 'typewriter' && a.contents === 'Typed straight on the page'), 'typewriter: text kept');

// ---------------------------------------------------------------- redaction box that matches the page
await win.keyboard.press('Escape');
await pickTool('Mark area', 'Edit');
await win.locator('.props .seg button', { hasText: 'Match page' }).first().click();
// page space is y-down: the confidential line sits at 842 - 100 = 742
await drag([55, 728], [330, 748]);
await sleep(400);
const red = (await annots()).find((a) => a.type === 'Redact');
ok(!!red && red.redactFill === 'auto', 'redaction mark made with "match page": ' + JSON.stringify(red?.redactFill));
await E(() => window.__gcc.active().applyRedactions({ black: true }));
await sleep(800);
const left = await E(async () => (await window.__gcc.active().chars(0)).text);
ok(!/CONFIDENTIAL/.test(left), 'redacted text is gone');
const col = await E(async (r) => {
  const { renderers } = window.__gcc.engines;
  const bmp = await renderers[0].call('tile', [window.__gcc.active().id, 0, 1, Math.round((r[0] + r[2]) / 2), Math.round((r[1] + r[3]) / 2), 1, 1]);
  const c = new OffscreenCanvas(1, 1); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
}, red.rect);
ok(Math.abs(col[0] - 219) < 6 && Math.abs(col[1] - 235) < 6 && Math.abs(col[2] - 250) < 6, 'the redaction box has the page colour: ' + col);

await win.screenshot({ path: join(TMP, 'final.png') });
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
