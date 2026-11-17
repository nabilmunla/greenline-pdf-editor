// 7.10 The anonymous user counter (Greenline build only), against a fake receiver on 127.0.0.1:
//  - the pop-up at first start, once only; its words are the shared text
//  - "Turn it off" sends nothing, and no id is kept
//  - "Keep it on" sends exactly id, version, OS - once
//  - the Settings switch works (on: a ping with a new id; off: the id is deleted)
//  - the company build (this folder as it is, no brand): no pop-up, no switch, no request
// The Greenline build is this app with "brand": "greenline" in its package.json (what export-public.py
// does): a copy of electron/ and package.json in tests/tmp-count/greenline, the rest linked.
// xvfb-run -a node tests/e2e-count.mjs
import { _electron as electron } from 'playwright';
import http from 'node:http';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync, readdirSync } from 'node:fs';

const TMP = resolve('tests/tmp-count');
rmSync(TMP, { recursive: true, force: true });
const GL = join(TMP, 'greenline');
mkdirSync(GL, { recursive: true });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(join(GL, 'package.json'), JSON.stringify({ ...pkg, brand: 'greenline', displayName: 'Greenline PDF Editor' }, null, 2));
cpSync('electron', join(GL, 'electron'), { recursive: true });
for (const n of readdirSync('.')) if (!['package.json', 'electron', 'tests', '.git'].includes(n) && !existsSync(join(GL, n))) symlinkSync(resolve(n), join(GL, n));
const profileDir = (n) => join(process.env.HOME, '.config', 'PDF Editor', 'profile-' + n);
const settingsOf = (n) => { try { return JSON.parse(readFileSync(join(profileDir(n), 'settings.json'), 'utf8')); } catch (_) { return {}; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// the fake receiver
const posts = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { posts.push({ method: req.method, url: req.url, client: req.headers['x-report-client'], body: Buffer.concat(chunks).toString('utf8') }); res.writeHead(200); res.end('Thanks'); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const COUNT_URL = `http://127.0.0.1:${server.address().port}/count`;

const ELECTRON = resolve('node_modules/electron/dist/electron');
async function launch(profile, { company = false } = {}) {
  const app = await electron.launch({
    executablePath: ELECTRON, args: [company ? resolve('.') : GL, '--no-sandbox', '--profile=' + profile],
    env: { ...process.env, PDFED_COUNT_URL: COUNT_URL, PDFED_COUNT_FIRST: '1500', PDFED_UPDATE_FIRST: '600000', PDFED_REPORT_FIRST: '600000' },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
  return { app, win };
}
const popup = (win) => win.locator('.modal[aria-label="This app counts its users"]');
const waitPost = async (n, ms = 7000) => { for (let t = 0; t < ms && posts.length < n; t += 100) await sleep(100); return posts.length >= n; };
const openSettings = async (win) => { await win.locator('.tb-btn[title="Settings"]').click(); await win.locator('.modal', { hasText: 'Settings' }).first().waitFor(); };
const SWITCH = 'Count me as a user of this app';

// 1. first start: the pop-up, the shared words, nothing sent while it is open
rmSync(profileDir('count'), { recursive: true, force: true });
let { app, win } = await launch('count');
await popup(win).waitFor({ timeout: 8000 }).catch(() => {});
ok(await popup(win).count() === 1, 'first start: the pop-up appears');
const paras = await popup(win).locator('p').allTextContents();
ok(paras.length === 3 && paras[0].startsWith('This app counts how many people use it, to see how popular it is. Nothing more. It helps a lot.') && paras[1].includes('Once a day it sends only a random number (not linked to you), the app version, and Windows or Linux.') && paras[2] === 'You can turn it off now, or later in Settings › Privacy.', 'the three paragraphs are the shared text');
const btns = await popup(win).locator('.actions button').allTextContents();
ok(btns.length === 2 && btns.includes('Keep it on') && btns.includes('Turn it off'), 'two buttons: ' + btns.join(' / '));
ok(await win.evaluate(() => document.activeElement && document.activeElement.textContent) === 'Keep it on', '"Keep it on" has the focus (the default)');
await win.keyboard.press('Escape');
await sleep(300);
ok(await popup(win).count() === 1, 'Escape is no answer: the pop-up stays');
await sleep(3500); // (the first try is at 1.5 s here)
ok(posts.length === 0, 'nothing is sent before the answer');
ok(settingsOf('count').installId === undefined && settingsOf('count').countAsked !== true, 'no id and no answer in the settings yet');
await popup(win).locator('button', { hasText: 'Keep it on' }).click();
ok(await waitPost(1), '"Keep it on": one ping arrives');
await sleep(500);
const p1 = posts[0] || {};
let b = {}; try { b = JSON.parse(p1.body); } catch (_) { /* below */ }
ok(p1.method === 'POST' && p1.url === '/count' && p1.client === 'pdf-editor', 'POST /count with the app header');
ok(JSON.stringify(Object.keys(b).sort()) === '["id","os","v"]' && /^[0-9a-f]{32}$/.test(b.id) && b.v === pkg.version && b.os === 'linux', 'body is exactly id, v, os: ' + p1.body);
let s = settingsOf('count');
ok(s.countAsked === true && s.userCount === true && s.installId === b.id && /^\d{4}-\d\d-\d\d$/.test(s.countDay || ''), 'settings: asked, on, the id, the day');
ok(await popup(win).count() === 0, 'the pop-up is gone');
await app.close().catch(() => {});

// 2. the next start (an update does the same): no pop-up, no second ping the same day
({ app, win } = await launch('count'));
await sleep(4000);
ok(await popup(win).count() === 0, 'second start: no pop-up (once only)');
ok(posts.length === 1, 'and no second ping the same day');
ok(settingsOf('count').installId === b.id, 'the id is kept');
// a new day: the same id again
const old = settingsOf('count');
await app.close().catch(() => {});
writeFileSync(join(profileDir('count'), 'settings.json'), JSON.stringify({ ...old, countDay: '2000-01-01' }, null, 2));
({ app, win } = await launch('count'));
ok(await waitPost(2), 'a later day: one more ping');
ok(posts[1] && JSON.parse(posts[1].body).id === b.id, 'with the same id');
await app.close().catch(() => {});

// 3. "Turn it off" sends nothing and keeps no id
const before = posts.length;
rmSync(profileDir('count-off'), { recursive: true, force: true });
({ app, win } = await launch('count-off'));
await popup(win).waitFor({ timeout: 8000 }).catch(() => {});
await popup(win).locator('button', { hasText: 'Turn it off' }).click();
await sleep(4500);
s = settingsOf('count-off');
ok(posts.length === before, '"Turn it off": nothing is sent');
ok(s.countAsked === true && s.userCount === false && !('installId' in s), 'settings: asked, off, no id');
ok(await popup(win).count() === 0, 'the pop-up is gone');

// 4. the Settings switch (this profile is off)
await openSettings(win);
const row = win.locator('.modal .row', { hasText: 'Privacy' });
ok(await row.count() === 1, 'Settings has a Privacy section');
const box = win.locator('.modal label.check', { hasText: SWITCH }).locator('input');
ok(await box.count() === 1 && !(await box.isChecked()), 'the switch is there, and off');
ok((await row.locator('.hint').innerText()) === 'Once a day, this app sends a random number, its version, and Windows or Linux, only to count users; nothing about you, your computer or your files is sent.', 'with the shared hint under it');
await box.check();
ok(await waitPost(before + 1), 'switched on: a ping arrives');
const bs = JSON.parse(posts[before].body);
ok(/^[0-9a-f]{32}$/.test(bs.id) && bs.id !== b.id, 'with a new id (not the other profile\'s)');
s = settingsOf('count-off');
ok(s.userCount === true && s.installId === bs.id, 'settings: on, the new id');
await box.uncheck();
await sleep(300);
s = settingsOf('count-off');
ok(s.userCount === false && !('installId' in s), 'switched off: the id is deleted');
await app.close().catch(() => {});
// back on in a new start, the same day: no second ping today (the day is kept), a new id when it is used again
const mid = posts.length;
({ app, win } = await launch('count-off'));
await sleep(4000);
ok(posts.length === mid && await popup(win).count() === 0, 'still off after a restart: nothing sent, no pop-up');
await app.close().catch(() => {});

// 5. the company build: nothing
const cb = posts.length;
rmSync(profileDir('count-co'), { recursive: true, force: true });
({ app, win } = await launch('count-co', { company: true }));
await sleep(4500);
ok(await popup(win).count() === 0, 'company build: no pop-up');
await openSettings(win);
ok(await win.locator('.modal label.check', { hasText: SWITCH }).count() === 0, 'company build: no switch in Settings');
ok(posts.length === cb, 'company build: no request');
ok(settingsOf('count-co').installId === undefined && settingsOf('count-co').countAsked === undefined, 'company build: no id, nothing asked');
await app.close().catch(() => {});

server.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
rmSync(TMP, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
