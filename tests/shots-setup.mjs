// Screenshots of the setup window's page in Chromium (the real window uses Edge WebView2 - same
// engine) with the Windows side mocked: every screen, light and dark, at 100% and 150%.
// node tests/shots-setup.mjs   (installer/ui.html is made by installer/build.py)
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
const OUT = resolve('tests/out/setup');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let fails = 0;
const states = {
  fresh: { mode: 'install', version: '0.4.0', existing: null, dirs: { user: 'C:\\Users\\nabil\\AppData\\Local\\Programs\\PDF Editor', machine: 'C:\\Program Files\\PDF Editor' }, source: '\\\\gcc-fs01\\Software\\PDF Editor', opts: { scope: 'user', dir: 'C:\\Users\\nabil\\AppData\\Local\\Programs\\PDF Editor', desktop: true, openWith: true, source: '\\\\gcc-fs01\\Software\\PDF Editor' } },
  update: { mode: 'install', version: '0.4.1', existing: { version: '0.4.0', dir: 'C:\\Users\\nabil\\AppData\\Local\\Programs\\PDF Editor', scope: 'user', source: '' }, dirs: { user: 'C:\\Users\\nabil\\AppData\\Local\\Programs\\PDF Editor', machine: 'C:\\Program Files\\PDF Editor' }, source: '', opts: { scope: 'user', dir: 'C:\\Users\\nabil\\AppData\\Local\\Programs\\PDF Editor', desktop: false, openWith: true, source: '' } },
  remove: { mode: 'uninstall', version: '0.4.0', existing: { version: '0.4.0', dir: 'C:\\Users\\nabil\\AppData\\Local\\Programs\\PDF Editor', scope: 'user' } },
};
for (const scheme of ['light', 'dark']) {
  for (const scale of [1, 1.5]) {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 440 }, deviceScaleFactor: scale, colorScheme: scheme });
    const shot = async (page, name) => { await page.waitForTimeout(260); await page.screenshot({ path: join(OUT, `${scheme}-${scale}x-${name}.png`) }); };
    for (const [key, st] of Object.entries(states)) {
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
      await page.exposeFunction('__host', (o) => o);
      await page.addInitScript((st) => {
        window.__calls = [];
        window.__mock = (o) => {
          window.__calls.push(o);
          const reply = (v) => setTimeout(() => window.__r(o.id, v), 10);
          if (o.m === 'init') reply(st);
          else if (o.m === 'check') reply(o.a[1] && o.a[1].includes('Windows') ? 'That folder needs admin rights. Choose another, or install for everyone.' : '');
          else if (o.m === 'browse') reply('');
          else if (o.m === 'install' || o.m === 'uninstall') reply(true);
        };
      }, st);
      await page.goto('file://' + resolve('installer/ui.html'));
      await page.waitForTimeout(300);
      if (key === 'fresh') {
        await shot(page, 'a-welcome');
        await page.click('#w-opts'); await shot(page, 'b-options');
        await page.click('#o-scope button[data-v="machine"]'); await shot(page, 'c-options-everyone');
        await page.fill('#o-dir', 'C:\\Windows\\PDF Editor'); await page.click('#o-scope button[data-v="user"]');
        await page.fill('#o-dir', 'C:\\Windows\\PDF Editor');
        await page.click('#o-go'); await shot(page, 'd-options-error');
        await page.fill('#o-dir', 'D:\\Apps\\PDF Editor');
        await page.click('#o-go'); await page.waitForTimeout(120);
        await page.evaluate(() => window.__ev('progress', { pct: 0.42, stage: 'Copying files' })); await shot(page, 'e-progress');
        const esc = await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return window.__calls.filter((c) => c.m === 'close').length; });
        if (esc) { console.log('FAIL Esc closed the window while installing'); fails++; }
        await page.evaluate(() => window.__ev('done', { ok: true })); await shot(page, 'f-done');
        await page.evaluate(() => window.__ev('done', { ok: false, err: 'Access is denied.' })); await shot(page, 'g-failed');
        await page.evaluate(() => window.__ev('done', { ok: false, running: true })); await shot(page, 'h-running');
        const inst = await page.evaluate(() => window.__calls.find((c) => c.m === 'install'));
        if (!inst || inst.a[0].dir !== 'D:\\Apps\\PDF Editor' || inst.a[0].scope !== 'user') { console.log('FAIL install options', JSON.stringify(inst)); fails++; }
      } else if (key === 'update') {
        await shot(page, 'i-update');
        await page.click('#w-opts'); await shot(page, 'j-update-options');
      } else {
        await shot(page, 'k-remove');
        await page.click('#r-data'); await page.click('#r-go');
        await page.evaluate(() => window.__ev('progress', { pct: 0.3, stage: 'Removing files' })); await shot(page, 'l-removing');
        await page.evaluate(() => window.__ev('done', { ok: true })); await shot(page, 'm-removed');
        const u = await page.evaluate(() => window.__calls.find((c) => c.m === 'uninstall'));
        if (!u || u.a[0] !== true) { console.log('FAIL uninstall call', JSON.stringify(u)); fails++; }
      }
      // nothing may stick out of the 600 x 440 window
      const over = await page.evaluate(() => [...document.querySelectorAll('.view.on *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5); }).map((el) => el.id || el.className || el.tagName).slice(0, 5));
      if (over.length) { console.log(`FAIL ${scheme} ${scale}x ${key}: outside the window:`, over); fails++; }
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
console.log(fails ? fails + ' FAILED' : 'setup screens OK', OUT);
process.exit(fails ? 1 : 0);
