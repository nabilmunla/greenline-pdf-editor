import { _electron as electron } from 'playwright';
import { resolve } from 'node:path';
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=repro', resolve(process.argv[2])] });
const win = await app.firstWindow();
win.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 200)));
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await win.waitForTimeout(6000);
await win.locator('.rtab', { hasText: 'Comment' }).click();
await win.locator('.ribbon .rb', { hasText: 'Rectangle' }).click();
const box = await win.locator('.pg[data-page="0"]').boundingBox();
await win.mouse.move(box.x + 300, box.y + 200); await win.mouse.down(); await win.mouse.move(box.x + 450, box.y + 330, { steps: 6 }); await win.mouse.up();
await win.waitForTimeout(3000);
console.log(await win.evaluate(async () => {
  const out = [];
  const d = window.__gcc.active();
  out.push('annRev ' + d.annRev[0] + ' annots ' + (await d.annots(0)).length);
  for (const c of document.querySelectorAll('.pg[data-page="0"] .tl.an canvas')) {
    const g = c.getContext('2d', { willReadFrequently: true });
    const px = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
    out.push(c.dataset.k + ' ' + c.width + 'x' + c.height + ' alpha>0: ' + n + ' left ' + c.style.left + ' top ' + c.style.top);
  }
  return out.join('\n');
}));
process.exit(0);
