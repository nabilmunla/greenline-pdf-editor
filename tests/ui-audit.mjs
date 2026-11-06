// UI audit: every ribbon tab, the panels and the main dialogs at the window sizes people really
// have (1920x1080 at 100/125/150/175 % Windows scaling, a 1366x768 laptop). Reports text that
// is cut off (by its own box or by a parent that clips), and things that run off the window.
// Screenshots in tests/out/ui-audit.   xvfb-run -a node tests/ui-audit.mjs [WxH ...]
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';

const OUT = resolve('tests/out/ui-audit');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const TMP = resolve('tests/tmp-audit');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'spec.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
const SIZES = process.argv.slice(2).length ? process.argv.slice(2).map((s) => s.split('x').map(Number)) : [[1920, 1040], [1536, 824], [1280, 680], [1097, 595], [1366, 728]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-audit'), { recursive: true, force: true });
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=audit', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
// (no Windows file dialogs in the audit: a dialog that asks for files first gets "cancelled")
await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); dialog.showSaveDialog = async () => ({ canceled: true }); });
await win.waitForFunction(() => window.__gcc?.active()?.pages.length > 0, null, { timeout: 60000 });
await sleep(800);
await win.evaluate(async () => { const d = window.__gcc.active(); await d.create(0, { type: 'Square', rect: [80, 200, 220, 280], color: [0.85, 0.1, 0.1], bw: 1.5 }); });

/** text cut off in the area given by `sel` (its own box too small, or clipped by a parent) */
const findClipped = (sel) => win.evaluate((sel) => {
  const out = [];
  const roots = [...document.querySelectorAll(sel)];
  const clips = (el) => { const s = getComputedStyle(el); return s.overflowX !== 'visible' || s.overflowY !== 'visible'; };
  for (const root of roots) {
    for (const el of root.querySelectorAll('*')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
      const isField = el.tagName === 'SELECT' || (el.tagName === 'INPUT' && /text|number|search/.test(el.type));
      if (!own && !isField) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const label = (own || (isField ? (el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text : el.value) || el.placeholder || el.className : '')).slice(0, 40);
      // its own box too small for its text
      if (clips(el) || st.textOverflow === 'ellipsis') {
        if (el.scrollHeight > el.clientHeight + 2 && el.tagName !== 'TEXTAREA') out.push(`text taller than its box: "${label}" (${el.scrollHeight} > ${el.clientHeight})`);
        if (el.scrollWidth > el.clientWidth + 2 && st.textOverflow !== 'ellipsis' && el.tagName !== 'SELECT' && el.tagName !== 'INPUT') out.push(`text wider than its box: "${label}"`);
      }
      // a SELECT whose chosen text doesn't fit
      if (el.tagName === 'SELECT') {
        const c = document.createElement('canvas').getContext('2d'); c.font = `${st.fontSize} ${st.fontFamily}`;
        const need = c.measureText(el.options[el.selectedIndex]?.text || '').width + 26;
        if (need > r.width + 1) out.push(`drop-down too narrow for "${label}" (${Math.round(r.width)} < ${Math.round(need)})`);
      }
      // cut by a parent that clips (the part of it that shows)
      let vis = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      // (inside something that scrolls, what is scrolled out of view can be reached: not "cut")
      let stopV = false, stopH = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (!clips(p)) continue;
        const q = p.getBoundingClientRect();
        const ps = getComputedStyle(p);
        const sv = /(auto|scroll)/.test(ps.overflowY) && p.scrollHeight > p.clientHeight + 1, sh = /(auto|scroll)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth + 1;
        if (!stopV && !sv) { vis.t = Math.max(vis.t, q.top); vis.b = Math.min(vis.b, q.bottom); }
        if (!stopH && !sh) { vis.l = Math.max(vis.l, q.left); vis.r = Math.min(vis.r, q.right); }
        if (sv) stopV = true;
        if (sh) stopH = true;
      }
      if (!stopV) { vis.t = Math.max(vis.t, 0); vis.b = Math.min(vis.b, innerHeight); }
      if (!stopH) { vis.l = Math.max(vis.l, 0); vis.r = Math.min(vis.r, innerWidth); }
      const area = Math.max(0, vis.r - vis.l) * Math.max(0, vis.b - vis.t), full = r.width * r.height;
      if (area < full * 0.9 && area > 0) out.push(`cut off by its container: "${label}" (${Math.round((area / full) * 100)} % shows)`);
      if (area === 0 && !stopV && !stopH && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) out.push(`hidden (outside its container): "${label}"`);
    }
  }
  return [...new Set(out)];
}, sel);

const report = [];
const note = (size, where, list) => { for (const x of list) report.push(`${size} | ${where} | ${x}`); };
for (const [w, h] of SIZES) {
  const size = `${w}x${h}`;
  await app.evaluate(({ BrowserWindow }, [w, h]) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(w, h); }, [w, h]);
  await sleep(700);
  for (const tab of ['File', 'Home', 'Comment', 'Measure', 'Edit', 'Organize', 'Protect', 'OCR', 'AI', 'Batch']) {
    await win.locator('.rtab', { hasText: new RegExp('^' + tab + '$') }).click();
    await sleep(250);
    const ov = await win.evaluate(() => { const r = document.querySelector('.ribbon'); return r ? r.scrollWidth - r.clientWidth : 0; });
    if (ov > 2) note(size, 'ribbon ' + tab, [`ribbon wider than the window by ${ov}px (scrolls sideways)`]);
    note(size, 'ribbon ' + tab, await findClipped('.ribbon, .rtabs'));
    await win.screenshot({ path: join(OUT, `${size}-ribbon-${tab}.png`), clip: { x: 0, y: 0, width: w, height: 175 } });
  }
  await win.locator('.rtab', { hasText: /^Comment$/ }).click();
  // panels
  for (const [i, name] of [[0, 'pages'], [1, 'bookmarks'], [2, 'comments'], [3, 'search']]) {
    await win.locator('.rail button').nth(i).click().catch(() => {});
    await sleep(400);
    note(size, 'side ' + name, await findClipped('.side'));
  }
  // properties: nothing selected, a tool, a markup
  note(size, 'props (none)', await findClipped('.props'));
  await win.locator('.ribbon .rb', { hasText: /^\s*Callout\s*$/ }).first().click().catch(() => {});
  await sleep(300);
  note(size, 'props (callout tool)', await findClipped('.props'));
  await win.screenshot({ path: join(OUT, `${size}-props-tool.png`) });
  await win.keyboard.press('Escape');
  await win.evaluate(() => { const v = window.__gcc.viewer(); v.goTo(0); });
  await sleep(300);
  const box = await win.locator('.pg[data-page="0"]').boundingBox();
  const k = box.width / (await win.evaluate(() => window.__gcc.active().pages[0].w));
  await win.mouse.click(box.x + 150 * k, box.y + 200.5 * k);
  await sleep(500);
  note(size, 'props (rectangle)', await findClipped('.props'));
  await win.screenshot({ path: join(OUT, `${size}-props-rect.png`) });
  note(size, 'status bar', await findClipped('.statusbar'));
  note(size, 'tabs', await findClipped('.dtabs, .doctabs'));
  // dialogs
  for (const [label, open] of [['print', async () => win.keyboard.press('Control+p')], ['stamps', async () => { await win.locator('.ribbon .rb', { hasText: /^\s*Stamp\s*$/ }).first().click(); }], ['page marks', async () => { await win.locator('.rtab', { hasText: /^Edit$/ }).click(); await win.locator('.ribbon .rb', { hasText: 'Numbers' }).first().click(); }], ['settings', async () => { await win.locator('.tb-btn[title="Settings"]').click(); }],
    // (0.8.2's dialogs)
    ['insert pages', async () => { await win.locator('.rtab', { hasText: /^Organize$/ }).click(); await win.locator('.ribbon .rb', { hasText: /^From file$/ }).first().click(); }],
    ['replace pages', async () => { await win.locator('.rtab', { hasText: /^Organize$/ }).click(); await win.locator('.ribbon .rb', { hasText: /^Replace$/ }).first().click(); }],
    ['extract', async () => { await win.locator('.rtab', { hasText: /^Organize$/ }).click(); await win.locator('.ribbon .rb', { hasText: /^Extract$/ }).first().click(); }],
    ['save as pictures', async () => { await win.locator('.rtab.file').click(); await win.locator('.filepane button', { hasText: 'Save as pictures' }).click(); }],
    ['new from pictures', async () => { await win.locator('.rtab.file').click(); await win.locator('.filepane button', { hasText: 'New from pictures' }).click(); }],
    ['export to excel', async () => { await win.locator('.rtab.file').click(); await win.locator('.filepane button', { hasText: 'Export to Excel' }).click(); }]]) {
    try {
      await open();
      await sleep(900);
      if (await win.locator('.modal').count()) {
        note(size, 'dialog ' + label, await findClipped('.modal'));
        const fits = await win.evaluate(() => { const m = document.querySelector('.modal').getBoundingClientRect(); return m.bottom <= innerHeight + 1 && m.right <= innerWidth + 1 && m.top >= -1; });
        if (!fits) note(size, 'dialog ' + label, ['the dialog is bigger than the window']);
        await win.screenshot({ path: join(OUT, `${size}-dialog-${label.replace(/ /g, '-')}.png`) });
      } else note(size, 'dialog ' + label, ['(did not open)']);
    } catch (e) { note(size, 'dialog ' + label, ['(could not open: ' + e.message.split('\n')[0] + ')']); }
    await win.keyboard.press('Escape');
    await sleep(300);
    if (await win.locator('.modal').count()) { await win.locator('.modal .actions .btn').first().click().catch(() => {}); await sleep(200); }
  }
  await win.locator('.rtab', { hasText: /^Home$/ }).click();
}
console.log(report.length ? report.join('\n') : 'nothing cut off');
console.log(`${report.length} findings`);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
