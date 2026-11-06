// Screenshots of the 0.8.5 screens (look at them): the "Draw as" strip while drawing a circle,
// Count by tag, the print panel. xvfb-run -a -s "-screen 0 1800x1100x24" node tests/shots-085.mjs [WxH]
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
const TMP = resolve('tests/tmp-shots085');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
copyFileSync('tests/data/long-spec.pdf', join(TMP, 'spec.pdf'));
const [W, H] = (process.argv[2] || '1366x728').split('x').map(Number);
for (const theme of ['light', 'dark']) {
  rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-shots085'), { recursive: true, force: true });
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=shots085', join(TMP, 'spec.pdf')] });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, s) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(s[0], s[1]); }, [W, H]);
  await win.waitForFunction(() => window.__gcc?.active()?.pages.length > 0, null, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  if (theme === 'dark') await win.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await win.locator('.rtab', { hasText: /^Measure$/ }).click();
  await win.locator('.ribbon [data-tool="m-area"]').first().click();
  await win.keyboard.press('o');
  const box = await win.locator('.pg[data-page="0"]').boundingBox();
  await win.mouse.click(box.x + 200, box.y + 200);
  await win.mouse.move(box.x + 280, box.y + 230, { steps: 5 });
  await new Promise((r) => setTimeout(r, 300));
  await win.screenshot({ path: join(TMP, `${theme}-circle-${W}x${H}.png`) });
  await win.keyboard.press('Escape');
  await win.locator('.ribbon .rb', { hasText: 'By tag' }).click();
  await win.locator('.counttag input.input').first().fill('0.1');
  await win.locator('.counttag button', { hasText: /^Find$/ }).click();
  await new Promise((r) => setTimeout(r, 1500));
  await win.screenshot({ path: join(TMP, `${theme}-counttag-${W}x${H}.png`) });
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+p');
  await new Promise((r) => setTimeout(r, 1500));
  await win.screenshot({ path: join(TMP, `${theme}-print-${W}x${H}.png`) });
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
}
console.log('shots in ' + TMP);
