// The Linux packages (0.10.0), end to end: the .deb as installed (/opt/<name>) and the AppImage
// (its image unpacked here and started through its AppRun, with $APPIMAGE as the runtime sets it).
// Each: draws a PDF, knows which package it is, makes itself the default PDF app (xdg-mime), has
// no Windows-only printer button, and updates itself from a signed latest.json - the .deb by
// handing the new package to the system installer (xdg-open), the AppImage by replacing its own
// file and starting it again once this copy has ended.
//   apt install ./<name>_<ver>_amd64.deb      (the .deb part is skipped when it isn't installed)
//   xvfb-run -a -s "-screen 0 1600x1000x24" node tests/e2e-linux.mjs <release folder (publish-v<ver>)>
import { _electron as electron } from 'playwright';
import crypto from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { signLatest } = createRequire(import.meta.url)('../electron/updsig.cjs');
const KEY = readFileSync('keys/update-signing-key.pem', 'utf8');

const REL = resolve(process.argv[2] || '');
const files = readdirSync(REL);
const AI = join(REL, files.find((f) => f.endsWith('.AppImage')));
const DEB = files.find((f) => f.endsWith('.deb'));
const SLUG = DEB.split('_')[0];
const TMP = resolve('tests/tmp-linux');
rmSync(TMP, { recursive: true, force: true });
const SHARE = join(TMP, 'share-folder'), STUB = join(TMP, 'bin'), CALLS = join(TMP, 'calls.txt');
for (const d of [SHARE, STUB]) mkdirSync(d, { recursive: true });
copyFileSync('tests/data/long-spec.pdf', join(TMP, 'spec.pdf'));
// xdg-open / xdg-mime write down how they were called (the real ones open the system's installer,
// change the user's default app)
for (const n of ['xdg-open', 'xdg-mime']) { writeFileSync(join(STUB, n), `#!/bin/sh\necho "${n} $*" >> '${CALLS}'\n`); chmodSync(join(STUB, n), 0o755); }
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8') : '');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; };
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };

// the new version: a .deb (just bytes) and an AppImage (a script that says it was started)
const RELAUNCHED = join(TMP, 'relaunched.txt');
const newDeb = crypto.randomBytes(200000);
const newAi = Buffer.from(`#!/bin/sh\necho "started $(date +%s%N)" >> '${RELAUNCHED}'\n# ${crypto.randomBytes(30000).toString('hex')}\n`);
writeFileSync(join(SHARE, `${SLUG}_9.9.9_amd64.deb`), newDeb);
writeFileSync(join(SHARE, `New-9.9.9-x86_64.AppImage`), newAi);
const app0 = crypto.randomBytes(1000);
writeFileSync(join(SHARE, 'app-v9.9.9.zip'), app0);
writeFileSync(join(SHARE, 'latest.json'), JSON.stringify(signLatest({
  version: '9.9.9', runtime: 'another', notes: ['Linux test'], build: 'greenline',
  app: { file: 'app-v9.9.9.zip', sha256: sha(app0), size: app0.length },
  linux: {
    deb: { file: `${SLUG}_9.9.9_amd64.deb`, sha256: sha(newDeb), size: newDeb.length },
    appimage: { file: 'New-9.9.9-x86_64.AppImage', sha256: sha(newAi), size: newAi.length },
  },
}, KEY), null, 2));

/** inked (dark) samples on page 0 */
const ink = (win) => win.evaluate(() => {
  let n = 0;
  for (const c of document.querySelectorAll('.pg[data-page="0"] canvas')) {
    if (!c.width || !c.height || c.width * c.height < 4) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 16) if (d[i + 3] > 200 && d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++;
  }
  return n;
});

/** one package, started as its users start it */
async function run(label, exe, env, profile, kind) {
  rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-' + profile), { recursive: true, force: true });
  rmSync(CALLS, { force: true });
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--profile=' + profile, join(TMP, 'spec.pdf')], env: { ...process.env, PATH: STUB + ':' + process.env.PATH, ...env }, timeout: 60000 });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  const pid = app.process().pid;
  await win.waitForFunction(() => window.__gcc?.active()?.pages.length > 0, null, { timeout: 60000 });
  ok(!!(await until(async () => (await ink(win)) > 800, 30000)), `${label}: the PDF is drawn`);
  const info = await win.evaluate(() => window.gcc.info());
  ok(info.platform === 'linux', `${label}: runs as a Linux app`);
  let u = await win.evaluate(() => window.gcc.updateGet());
  ok(u.installed && u.linux === kind, `${label}: knows it is the ${kind} (installed: ${u.installed}, linux: ${u.linux})`);
  // the window's class: what the menu entry's StartupWMClass names (the taskbar groups by it)
  const tree = execFileSync('xwininfo', ['-root', '-tree']).toString();
  ok(tree.includes(`"${SLUG}"`), `${label}: window class is "${SLUG}"` + (tree.includes(`"${SLUG}"`) ? '' : ' - ' + (tree.match(/\("[^"]*" "[^"]*"\)/g) || []).slice(0, 4).join(' ')));
  // default app for PDFs
  const r = await win.evaluate(() => window.gcc.registerOpenWith());
  ok(r.ok && calls().includes(`xdg-mime default ${SLUG}${kind === 'appimage' ? '-appimage' : ''}.desktop application/pdf`), `${label}: makes itself the default PDF app (${JSON.stringify(r)}; ${calls().trim()})`);
  // printing: the system's printers, no Windows-only preferences button
  await win.keyboard.press('Control+p');
  const dlg = win.locator('.modal', { hasText: 'Print' }).first();
  await dlg.waitFor({ timeout: 10000 });
  await sleep(1500);
  ok(await win.locator('button', { hasText: 'Printer preferences' }).count() === 0, `${label}: print dialog without "Printer preferences…" (Windows only)`);
  await win.keyboard.press('Escape');
  await sleep(500);
  // an update
  await win.evaluate((s) => window.gcc.updateSource(s), SHARE);
  u = await win.evaluate(() => window.gcc.updateCheck());
  const want = kind === 'deb' ? newDeb : newAi;
  ok(u.state === 'available' && u.kind === kind && u.size === want.length && u.available === '9.9.9', `${label}: 9.9.9 offered as its own package (${u.state}, ${u.kind}, ${u.size})`);
  u = await win.evaluate(() => window.gcc.updateDownload());
  ok(u.state === 'ready', `${label}: downloaded and checked (${u.state} ${u.err || ''})`);
  const card = win.locator('.upcard');
  await card.waitFor({ timeout: 10000 });
  const text = await card.innerText();
  const btn = kind === 'deb' ? 'Close and install' : 'Restart now';
  ok(text.includes(btn) && (kind !== 'deb' || text.includes('package installer')), `${label}: the card says what happens ("${btn}")`);
  const closed = new Promise((res) => app.process().once('exit', () => res(Date.now())));
  await card.locator('button', { hasText: btn }).click();
  const at = await Promise.race([closed, sleep(30000).then(() => 0)]);
  ok(at > 0, `${label}: closes for the update`);
  return { pid, at };
}

try {
  // ---------------------------------------------------------------- .deb
  const OPT = `/opt/${SLUG}/${SLUG}`;
  if (!existsSync(OPT)) console.log('SKIP the .deb: not installed (apt install ./' + DEB + ')');
  else {
    const inst = JSON.parse(readFileSync(`/opt/${SLUG}/install.json`, 'utf8'));
    ok(inst.linux === 'deb', '.deb: install.json says deb');
    ok((statSync(`/opt/${SLUG}/chrome-sandbox`).mode & 0o4000) !== 0, '.deb: the sandbox helper is setuid (postinst)');
    ok(readFileSync(`/usr/share/applications/${SLUG}.desktop`, 'utf8').includes('MimeType=application/pdf;'), '.deb: menu entry for PDFs');
    await run('.deb', OPT, {}, 'linux-deb', 'deb');
    const c = await until(async () => (calls().match(/xdg-open (.+\.deb)$/m) || [])[1], 10000);
    ok(!!c && sha(readFileSync(c)) === sha(newDeb), `.deb: the new package handed to the system installer (${c})`);
  }

  // ---------------------------------------------------------------- AppImage
  // (unpacked from the file itself: the squashfs image starts where the runtime's ELF ends)
  const b = readFileSync(AI);
  ok(b.readUInt32BE(0) === 0x7f454c46 && b.slice(8, 11).toString('latin1') === 'AI\x02', 'AppImage: an ELF with the AppImage type-2 mark');
  const off = Number(b.readBigUInt64LE(0x28)) + b.readUInt16LE(0x3a) * b.readUInt16LE(0x3c);
  ok(b.slice(off, off + 4).toString('latin1') === 'hsqs', `AppImage: squashfs image at ${off}`);
  const DIR = join(TMP, 'AppDir');
  execFileSync('unsquashfs', ['-q', '-n', '-o', String(off), '-d', DIR, AI]);
  ok(statSync(join(DIR, 'AppRun')).mode & 0o111 && existsSync(join(DIR, SLUG + '.desktop')) && existsSync(join(DIR, '.DirIcon')), 'AppImage: AppRun, desktop entry and icon inside');
  ok(JSON.parse(readFileSync(join(DIR, 'install.json'), 'utf8')).linux === 'appimage', 'AppImage: install.json says appimage');
  const HOMEAPPS = join(TMP, 'My Apps'); mkdirSync(HOMEAPPS);
  const MINE = join(HOMEAPPS, 'Greenline PDF Editor.AppImage');
  copyFileSync(AI, MINE); chmodSync(MINE, 0o755);
  const DATA = join(TMP, 'xdg-data');
  // started without $APPIMAGE (unpacked by hand): a copy that doesn't update itself
  {
    const app = await electron.launch({ executablePath: join(DIR, 'AppRun'), args: ['--no-sandbox', '--profile=linux-plain'], env: { ...process.env, APPIMAGE: '', XDG_DATA_HOME: DATA }, timeout: 60000 });
    const win = await app.firstWindow();
    await win.waitForLoadState();
    const u = await win.evaluate(() => window.gcc.updateGet());
    ok(!u.installed && !u.linux, 'AppImage unpacked by hand: not an installed copy (no self-update)');
    app.process().kill();
    await sleep(1000);
  }
  const { at } = await run('AppImage', join(DIR, 'AppRun'), { APPIMAGE: MINE, XDG_DATA_HOME: DATA }, 'linux-ai', 'appimage');
  const entry = join(DATA, 'applications', `${SLUG}-appimage.desktop`);
  const e = existsSync(entry) ? readFileSync(entry, 'utf8') : '';
  ok(e.includes(`Exec="${MINE}" %F`) && e.includes('MimeType=application/pdf;') && existsSync((e.match(/^Icon=(.*)$/m) || [])[1] || '/nonexistent'), `AppImage: its own menu entry, pointing at the file (${(e.match(/^Exec=.*$/m) || [''])[0]})`);
  const swapped = await until(async () => existsSync(MINE) && sha(readFileSync(MINE)) === sha(newAi), 10000);
  ok(!!swapped && (statSync(MINE).mode & 0o111) !== 0, 'AppImage: replaced by the new version, runnable');
  ok(!readdirSync(HOMEAPPS).some((f) => f.endsWith('.new')), 'AppImage: no leftover next to it');
  const rl = await until(async () => existsSync(RELAUNCHED) && readFileSync(RELAUNCHED, 'utf8'), 10000);
  const startedNs = rl ? BigInt(rl.trim().split(' ')[1]) : 0n;
  ok(!!rl && startedNs / 1000000n >= BigInt(at) - 200n, `AppImage: the new version started after the old one ended (${rl ? Number(startedNs / 1000000n) - at + ' ms after' : 'not started'})`);
} catch (e) {
  console.log('FAIL', e.stack || e);
  fails++;
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
