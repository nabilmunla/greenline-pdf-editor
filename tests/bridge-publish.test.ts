// PLAN 11.3: scripts/publish.py --bridge - the last release on the company's share. Runs the real publish.py and
// sign-latest.mjs in a temp tree built like a Greenline export (package.json with a brand, a stand-in Electron
// version, a finished publish-v<ver> folder made here), writes only into temp folders (the "share" is one too), and
// reads the result with 0.12.1's OWN updater.cjs (from git, build "company") - the proof that the label is what lets
// the release in. Needs the dev signing key (skipped without it) and git history back to 0.12.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { haveKey, KEY_FILE, ROOT, rig } from './bridge-rig';

const req = createRequire(import.meta.url);
const { verifyLatest } = req(join(ROOT, 'electron', 'updsig.cjs'));
const REL_0_12_1 = 'eb3ea44';
let oldFiles = false;
try { execFileSync('git', ['cat-file', '-e', `${REL_0_12_1}:electron/updater.cjs`], { cwd: ROOT, stdio: 'ignore' }); oldFiles = true; } catch { /* no history */ }
const skip = (!haveKey && 'no signing key in this checkout') || (!oldFiles && "no 0.12.1 in this checkout's history") || false;
const t = (name: string, fn: () => void | Promise<void>) => test(name, { skip }, fn);

const VER = '0.13.0', RT = '44.10.2';
const sha = (f: string) => crypto.createHash('sha256').update(readFileSync(f)).digest('hex');
const FEED = 'https://github.com/example/greenline-pdf-editor';

// a Greenline export in miniature + its finished normal publish (made by the real signer)
const tree = mkdtempSync(join(tmpdir(), 'bridge-pub-'));
const out = join(tree, 'out');
const pub = join(out, `publish-v${VER}`);
const SETUP = `Greenline PDF Editor Setup ${VER}.exe`;
function build() {
  for (const d of ['scripts', 'electron', 'src/ui', 'node_modules/electron']) mkdirSync(join(tree, d), { recursive: true });
  mkdirSync(pub, { recursive: true });
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'pdf-editor', productName: 'PDF Editor', version: VER, brand: 'greenline', displayName: 'Greenline PDF Editor', updateFeed: FEED }));
  writeFileSync(join(tree, 'node_modules/electron/package.json'), JSON.stringify({ version: RT }));
  for (const f of ['scripts/publish.py', 'scripts/sign-latest.mjs', 'electron/updsig.cjs', 'src/ui/movedtext.ts']) copyFileSync(join(ROOT, f), join(tree, f));
  writeFileSync(join(pub, `app-v${VER}.zip`), crypto.randomBytes(60000));
  writeFileSync(join(pub, SETUP), crypto.randomBytes(9000));
  const z = join(pub, `app-v${VER}.zip`);
  const latest = {
    version: VER, runtime: RT, published: '2026-11-20', notes: ['Faster drawing', 'Fixed a crash'],
    groups: { 'New features': ['Faster drawing'], Fixes: ['Fixed a crash'] },
    history: { [VER]: { 'New features': ['Faster drawing'], Fixes: ['Fixed a crash'] }, '0.12.1': { Fixes: ['Older fix'] } },
    app: { file: `app-v${VER}.zip`, sha256: sha(z), size: readFileSync(z).length },
    linux: { appimage: { file: 'x.AppImage', sha256: 'a'.repeat(64), size: 5 }, deb: { file: 'x.deb', sha256: 'b'.repeat(64), size: 5 } },
    build: 'greenline',
  };
  writeFileSync(join(pub, 'latest.json.unsigned'), JSON.stringify(latest, null, 2));
  sign(join(pub, 'latest.json.unsigned'));
  writeFileSync(join(pub, 'latest.json'), readFileSync(join(pub, 'latest.json.unsigned')));
  rmSync(join(pub, 'latest.json.unsigned'));
}
const sign = (f: string) => execFileSync('node', [join(tree, 'scripts/sign-latest.mjs'), f], { cwd: tree, env: { ...process.env, PDFED_SIGNING_KEY: KEY_FILE }, stdio: 'pipe' });
const publish = (...args: string[]) => spawnSync('python3', ['-I', join(tree, 'scripts/publish.py'), out, ...args], { cwd: tree, env: { ...process.env, PDFED_SIGNING_KEY: KEY_FILE }, encoding: 'utf8' });
const readLatest = (dir: string) => { const j = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')); return { j, p: JSON.parse(j.signed) }; };

t('the gate: another Electron, no --from-runtime, not a Greenline build, a used folder - refused with a sentence, nothing written', () => {
  build();
  const bad = join(tree, 'b-bad');
  let r = publish('--bridge-only', '--bridge', bad, '--from-runtime', '44.9.0');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Electron 44\.10\.2.*44\.9\.0/);
  assert.ok(!existsSync(bad));
  r = publish('--bridge-only', '--bridge', bad);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /--from-runtime/);
  r = publish('--bridge', bad);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /--from-runtime/, 'the gate comes before the build');
  // a company-branded tree (no brand): refused
  const company = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'));
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ ...company, brand: undefined }));
  r = publish('--bridge-only', '--bridge', bad, '--from-runtime', RT);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /only for the Greenline build/);
  writeFileSync(join(tree, 'package.json'), JSON.stringify(company));
  // a folder that already holds something is never written into
  const used = join(tree, 'b-used'); mkdirSync(used); writeFileSync(join(used, 'latest.json'), 'x');
  r = publish('--bridge-only', '--bridge', used, '--from-runtime', RT);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /not empty/);
  assert.equal(readFileSync(join(used, 'latest.json'), 'utf8'), 'x');
});

let bridge = '';
t('the bridge folder: the same app package byte for byte, the Greenline setup, a signed latest.json as "company"', () => {
  bridge = join(tree, 'b-ok');
  const before = sha(join(pub, 'latest.json'));
  const r = publish('--bridge-only', '--bridge', bridge, '--from-runtime', RT);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(bridge).sort(), ['README.txt', SETUP, 'latest.json', `app-v${VER}.zip`].sort());
  assert.equal(sha(join(bridge, `app-v${VER}.zip`)), sha(join(pub, `app-v${VER}.zip`)), 'the two zips are equal');
  assert.equal(sha(join(bridge, SETUP)), sha(join(pub, SETUP)));
  assert.equal(sha(join(pub, 'latest.json')), before, 'the GitHub latest.json is unchanged');
  const gh = readLatest(pub), br = readLatest(bridge);
  // both verify with updsig
  assert.ok(verifyLatest(gh.j).latest, 'GitHub latest.json verifies');
  assert.ok(verifyLatest(br.j).latest, 'the bridge latest.json verifies');
  assert.equal(gh.p.build, 'greenline');
  assert.equal(br.p.build, 'company');
  assert.equal(br.p.linux, undefined, 'no Linux entries');
  // equal to the GitHub one in everything else
  const strip = (o: any) => { const { build, linux, notes, groups, history, ...rest } = o; return rest; };
  assert.deepEqual(strip(br.p), strip(gh.p));
  // the notice's sentence first, from the one place that holds it
  const body = /export const MOVED_BODY = '((?:[^'\\]|\\.)*)'/.exec(readFileSync(join(ROOT, 'src/ui/movedtext.ts'), 'utf8'))![1].replace(/\\'/g, "'");
  assert.equal(br.p.notes[0], body);
  assert.equal(Object.values(br.p.groups)[0] && (Object.values(br.p.groups)[0] as string[])[0], body);
  assert.equal(Object.keys(br.p.groups)[0], 'About this update');
  assert.deepEqual(br.p.groups['New features'], ['Faster drawing'], 'the release notes follow');
  assert.equal((br.p.history[VER] as any)['About this update'][0], body);
  assert.deepEqual(br.p.history['0.12.1'], gh.p.history['0.12.1']);
  assert.ok(br.p.notes.length <= 6);
  assert.match(readFileSync(join(bridge, 'README.txt'), 'utf8'), /LAST:\s+latest\.json/);
});

// 0.12.1's own updater.cjs, run in node against a folder
async function oldCheck(folder: string) {
  const oldDir = mkdtempSync(join(tmpdir(), 'bridge-0121-'));
  for (const f of ['updater', 'updsig', 'feed', 'update-worker']) writeFileSync(join(oldDir, f + '.cjs'), execFileSync('git', ['show', `${REL_0_12_1}:electron/${f}.cjs`], { cwd: ROOT, maxBuffer: 1 << 24 }));
  const had = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: RT, configurable: true });
  const work = mkdtempSync(join(tmpdir(), 'bridge-work-'));
  const lad = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = work;
  const r = rig({ electronDir: oldDir, version: '0.12.1', build: 'company', appOld: { version: '0.12.0' }, updateJson: { source: folder }, settings: {} });
  try {
    const u = r.make();
    const snap = await u.check(true);
    let after = snap;
    if (snap.state === 'available') after = await u.download();
    return { snap, after, work };
  } finally {
    if (had) Object.defineProperty(process.versions, 'electron', had); else delete (process.versions as any).electron;
    if (lad === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = lad;
    r.done(); rmSync(oldDir, { recursive: true, force: true });
  }
}

t('0.12.1\'s own updater: the bridge folder is offered and its package passes the checksum; the GitHub latest.json is refused as "another edition"', async () => {
  const a = await oldCheck(bridge);
  assert.equal(a.snap.state, 'available', 'offered: ' + a.snap.state + ' ' + (a.snap.err || ''));
  assert.equal(a.snap.available, VER);
  assert.equal(a.after.state, 'ready', 'downloaded and the SHA matched: ' + a.after.state + ' ' + (a.after.err || ''));
  const dl = join(a.work, 'PDF Editor', 'updates', `app-v${VER}.zip`);
  assert.ok(existsSync(dl) && sha(dl) === sha(join(pub, `app-v${VER}.zip`)));
  // the same release as GitHub has it (build "greenline") in a folder: the label is what lets the other in
  const gh = join(tree, 'as-github'); mkdirSync(gh);
  for (const f of ['latest.json', `app-v${VER}.zip`]) copyFileSync(join(pub, f), join(gh, f));
  const b = await oldCheck(gh);
  assert.equal(b.snap.state, 'error');
  assert.match(b.snap.err, /another edition/);
  rmSync(a.work, { recursive: true, force: true });
});

test('clean up', () => { rmSync(tree, { recursive: true, force: true }); });
