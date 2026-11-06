import { _electron as electron } from 'playwright';
import { resolve } from 'node:path';
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=repro', resolve(process.argv[2])] });
const win = await app.firstWindow();
win.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 200)));
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await win.waitForTimeout(5000);
const probe = (tag) => win.evaluate((tag) => {
  const out = [tag];
  for (const c of document.querySelectorAll('.pg[data-page="0"] canvas')) {
    const g = c.getContext('2d', { willReadFrequently: true });
    let s = '';
    try { const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data; s = [...d].join(','); } catch (e) { s = 'x'; }
    out.push(`${c.className || c.parentElement.className} k=${(c.dataset.k || '').split('|').slice(1).join('|')} ${c.width}x${c.height} style=${c.style.left},${c.style.top},${c.style.width} px=${s}`);
  }
  return out.join('\n');
}, tag);

await win.locator('.rtab', { hasText: 'Comment' }).click();
await win.locator('.ribbon .rb', { hasText: 'Rectangle' }).click();
const box = await win.locator('.pg[data-page="0"]').boundingBox();
await win.mouse.move(box.x + 300, box.y + 200); await win.mouse.down(); await win.mouse.move(box.x + 450, box.y + 330, { steps: 6 }); await win.mouse.up();
await win.waitForTimeout(4000);

await win.screenshot({ path: 'tests/out/repro.png' });
await app.close();
