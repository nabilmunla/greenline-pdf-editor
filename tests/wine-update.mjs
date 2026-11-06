// The real Windows setup under wine: install from a share (remembers it), the helper applies an
// update package of the real app, goes back, uninstalls (files, registry, shortcuts).
//   node tests/wine-update.mjs <publish-vX folder>      (needs: apt install wine64; xvfb)
import { spawn, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
// (only a signed latest.json is trusted from 0.8.2: electron/updsig.cjs)
const signedJson = (p) => JSON.stringify(createRequire(import.meta.url)('../electron/updsig.cjs').signLatest(p, createRequire(import.meta.url)('node:fs').readFileSync('keys/update-signing-key.pem', 'utf8')), null, 2);

const PUB = resolve(process.argv[2]);
const latestPub = JSON.parse(readFileSync(join(PUB, 'latest.json'), 'utf8'));
const V = latestPub.version;
const NEXT = V.replace(/(\d+)$/, (n) => String(Number(n) + 1));
const PREFIX = '/tmp/claude-0/wineprefix-e2e';
const SHARE = '/tmp/claude-0/wine-share';
const env = { ...process.env, WINEPREFIX: PREFIX, WINEDEBUG: '-all', WINEARCH: 'win64' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const wine = (args, opts = {}) => spawn('wine', args, { env: { ...env, ...(opts.env || {}) }, stdio: 'ignore', detached: true });
const run = (args, ms = 180000, extra = {}) => new Promise((res) => { const p = wine(args, { env: extra }); const t = setTimeout(() => { try { process.kill(-p.pid); } catch (_) { /* */ } res(-1); }, ms); p.on('exit', (c) => { clearTimeout(t); res(c); }); });
const USER = join(PREFIX, 'drive_c/users', process.env.USER || 'root');
const INST = join(USER, 'AppData/Local/Programs/PDF Editor');
const ver = (sub) => { try { return JSON.parse(readFileSync(join(INST, 'resources', sub, 'package.json'), 'utf8')).version; } catch (_) { return ''; } };
const procs = () => { try { return execFileSync('pgrep', ['-f', 'Programs.PDF Editor.PDF Editor.exe']).toString().trim().split('\n').filter(Boolean); } catch (_) { return []; } };
const setupLog = () => { try { return execFileSync('bash', ['-c', `cat "${PREFIX}"/drive_c/users/*/AppData/Local/Temp/"PDF Editor Setup.log" 2>/dev/null || cat "${PREFIX}"/drive_c/users/*/Temp/"PDF Editor Setup.log" 2>/dev/null`]).toString(); } catch (_) { return ''; } };

rmSync(PREFIX, { recursive: true, force: true });
rmSync(SHARE, { recursive: true, force: true });
mkdirSync(SHARE, { recursive: true });
console.log('preparing wine…');
await run(['wineboot', '--init'], 240000);

// the share: the setup + a newer app package (same files, next version number)
copyFileSync(join(PUB, `PDF Editor Setup ${V}.exe`), join(SHARE, `PDF Editor Setup ${V}.exe`));
writeFileSync(join(SHARE, 'latest.json'), JSON.stringify(latestPub));
// 1. install from the share (no WebView2 under wine -> the plain prompts, answered yes)
let code = await run(['Z:' + join(SHARE, `PDF Editor Setup ${V}.exe`).replace(/\//g, '\\'), '--silent'], 240000);
ok(code === 0 && ver('app') === V, `installed ${V} from the share (exit ${code})`);
const uj = JSON.parse(readFileSync(join(INST, 'update.json'), 'utf8'));
ok(/^Z:\\tmp\\claude-0\\wine-share$/i.test(uj.source), 'the setup remembered the share it ran from: ' + uj.source);

// 2. publish NEXT on the share: the app zip with the version number changed
const py = `
import zipfile, json, sys
src, dst, v = sys.argv[1:4]
with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zo:
    for m in zi.infolist():
        b = zi.read(m)
        if m.filename == 'package.json':
            j = json.loads(b); j['version'] = v; b = json.dumps(j).encode()
        zo.writestr(m.filename, b)
`;
const nextZip = join(SHARE, `app-v${NEXT}.zip`);
execFileSync('python3', ['-c', py, join(PUB, `app-v${V}.zip`), nextZip, NEXT]);
const zb = readFileSync(nextZip);
writeFileSync(join(SHARE, 'latest.json'), signedJson({ ...(latestPub.signed ? JSON.parse(latestPub.signed) : latestPub), version: NEXT, notes: ['Test update'], app: { file: `app-v${NEXT}.zip`, sha256: crypto.createHash('sha256').update(zb).digest('hex'), size: zb.length } }));

// 3. the update as the app hands it over: a copy of the helper, started with the package
//    (Electron itself doesn't run reliably under wine; the app's side is covered by e2e-update)
const winPath = (p) => p.replace(PREFIX + '/drive_c', 'C:').replace(/\//g, '\\');
const upDir = join(USER, 'AppData/Local/PDF Editor/updates');
mkdirSync(upDir, { recursive: true });
copyFileSync(nextZip, join(upDir, `app-v${NEXT}.zip`));
copyFileSync(join(INST, 'PDF Editor Setup.exe'), join(upDir, 'helper-1234.exe'));
code = await run([winPath(join(upDir, 'helper-1234.exe')), '--apply', winPath(join(upDir, `app-v${NEXT}.zip`)), '--sha256', crypto.createHash('sha256').update(zb).digest('hex'), '--version', NEXT, '--dir', winPath(INST), '--wait', '99999'], 180000, { PDFED_SETUP_NO_DIALOGS: '1' });
ok(code === 0 && ver('app') === NEXT && ver('app.old') === V, `the helper swapped the real app: now ${ver('app')}, previous ${ver('app.old')} kept (exit ${code})`);
ok(JSON.parse(readFileSync(join(INST, 'install.json'), 'utf8')).version === NEXT, 'install.json updated');
ok(!existsSync(join(upDir, `app-v${NEXT}.zip`)), 'the used package is removed');
try { execFileSync('wineserver', ['-k'], { env }); } catch (_) { /* */ }
await sleep(1500);
ok(readFileSync(join(PREFIX, 'user.reg'), 'utf8').includes(`"DisplayVersion"="${NEXT}"`), 'and the version in Windows\' app list');

// 4. back to the previous version, then uninstall
code = await run([winPath(join(INST, 'PDF Editor Setup.exe')), '--rollback', '--dir', winPath(INST)], 120000, { PDFED_SETUP_NO_DIALOGS: '1' });
ok(code === 0 && ver('app') === V, `going back: ${ver('app')} (exit ${code})`);
code = await run([winPath(join(INST, 'PDF Editor Setup.exe')), '--uninstall', '--silent'], 120000, { PDFED_SETUP_NO_DIALOGS: '1' });
for (let i = 0; i < 30 && existsSync(INST); i++) await sleep(1000);
ok(!existsSync(INST), 'uninstalled: the folder is gone');
try { execFileSync('wineserver', ['-k'], { env }); } catch (_) { /* */ }
await sleep(1500);
const reg = readFileSync(join(PREFIX, 'user.reg'), 'utf8');
ok(!/Uninstall\\\\PDFEditor\]/.test(reg) && !/PDFEditor\.Document\\\\shell/.test(reg), 'and its registry entries');
ok(!existsSync(join(USER, 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/PDF Editor.lnk')), 'and its shortcut');
try { execFileSync('wineserver', ['-k'], { env }); } catch (_) { /* */ }
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
