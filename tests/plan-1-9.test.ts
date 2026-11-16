// PLAN 1.9 (AUDIT B11: main.cjs, reports.cjs, Viewer.tsx)
// main.cjs and reports.cjs can't be loaded without Electron: the real functions are cut out of the
// files' own text (as in plan-1-8.test.ts) and run against a temp folder, their surroundings stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Module from 'node:module';
import { eachPage } from '../src/ui/eachpage';

const mainText = readFileSync('electron/main.cjs', 'utf8');
const grab = (re: RegExp) => { const m = re.exec(mainText); assert.ok(m, 'found in main.cjs: ' + re); return m![0]; };

test('1.9 (a): original left as a hidden .old file is reported with where it is, and not put on the delete list', async () => {
  const code = [
    grab(/^const stagingName = .*$/m), grab(/^const workDir = .*$/m), grab(/^const inWork = .*$/m), grab(/^const isPart = .*$/m),
    grab(/^async function commitFile\([\s\S]*?\n}\n/m),
    'return commitFile;',
  ].join('\n');
  const root = mkdtempSync(path.join(os.tmpdir(), 'plan19a-'));
  try {
    const dest = path.join(root, 'target');
    mkdirSync(dest);
    const file = path.join(dest, 'doc.pdf');
    writeFileSync(file, 'ORIGINAL');
    // Windows: the original is open somewhere (the new file can't take its place), and after the
    // original was moved aside it can't be put back either
    let old = '';
    const eperm = () => Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
    const fsp2 = {
      ...fs.promises,
      rename: async (a: string, b: string) => {
        if (b === file && a.endsWith('.tmp')) throw eperm();           // the new file into its place
        if (a === file) { old = b; return fs.promises.rename(a, b); }   // the original aside: works
        if (b === file && a === old) throw eperm();                      // the original back: refused
        return fs.promises.rename(a, b);
      },
    };
    const oldFiles: string[] = [];
    const logs: string[] = [];
    const commitFile = new Function('path', 'os', 'fs', 'fsp', 'APP', 'backup', 'log', 'retrying', 'overwriteInPlace', 'oldFiles', 'cleanOld', 'sweepStaging', code)(
      path, { tmpdir: () => root }, fs, fsp2, 'PDF Editor', async () => '', (l: string) => logs.push(l), (f: () => unknown) => f(), async () => {}, oldFiles, () => {}, () => {}) as (src: string, file: string, keepBackup: boolean) => Promise<unknown>;
    const work = path.join(root, 'PDF Editor', 'work', 'job'); mkdirSync(work, { recursive: true });
    const src = path.join(work, 'out.pdf'); writeFileSync(src, 'NEW');
    await assert.rejects(() => commitFile(src, file, false), (e: Error & { code?: string }) => {
      assert.ok(old && existsSync(old), 'the original is on disk under the hidden name');
      assert.equal(readFileSync(old, 'utf8'), 'ORIGINAL');
      assert.ok(e.message.includes(old), 'the message says where the original is: ' + e.message);
      assert.equal(e.code, 'EIO');
      return true;
    });
    assert.deepEqual(oldFiles, [], 'not on the delete list: it is the only copy of the file');
    assert.ok(existsSync(src), 'the new version is still in the engine folder for a retry');
    assert.ok(logs.some((l) => l.includes(old)), 'logged with the hidden name');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** the recovery handlers of main.cjs, run on a temp folder */
function recovery(root: string, fsp: typeof fs.promises = fs.promises) {
  const a = mainText.indexOf('const recKey = ');
  const b = mainText.indexOf("ipcMain.handle('recovery:list'");
  assert.ok(a > 0 && b > a);
  const handlers: Record<string, (...x: unknown[]) => Promise<unknown>> = {};
  const code = [
    grab(/^const stagingName = .*$/m),
    mainText.slice(a, b),
    'return cleanRecovery;',
  ].join('\n');
  const recDir = () => root;
  const cleanRecovery = new Function('path', 'fs', 'fsp', 'recDir', 'ipcMain', 'writeSafe', 'retrying', 'log', 'recOwner', code)(
    path, fs, fsp, recDir, { handle: (n: string, f: (...x: unknown[]) => Promise<unknown>) => { handlers[n] = f; } },
    async (f: string, d: Buffer) => fsp.writeFile(f, d), (f: () => unknown) => f(), (l: string) => logs.push(l), new Map()) as () => Promise<void>;
  const logs: string[] = [];
  return { handlers, cleanRecovery, logs, ev: { sender: { id: 1 } } };
}

test('1.9 (b): recovery JSON is written atomically (a write cut short leaves the old JSON, no half file)', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plan19b-'));
  try {
    // a write that stops halfway, as a crash or a full disk would
    const cut = { ...fs.promises, writeFile: async (f: string, d: string | Buffer) => { const s = String(d); await fs.promises.writeFile(f, s.slice(0, s.length >> 1)); throw new Error('disk full'); } };
    const good = recovery(root);
    await good.handlers['recovery:meta'](good.ev, 'k1', { name: 'a.pdf' });
    const before = readFileSync(path.join(root, 'k1.json'), 'utf8');
    assert.equal(JSON.parse(before).name, 'a.pdf');
    const bad = recovery(root, cut as typeof fs.promises);
    await assert.rejects(() => bad.handlers['recovery:meta'](bad.ev, 'k1', { name: 'b.pdf', longer: 'x'.repeat(200) }), /disk full/);
    assert.equal(readFileSync(path.join(root, 'k1.json'), 'utf8'), before, 'the old JSON is untouched');
    assert.deepEqual(readdirSync(root).filter((n) => !/^k1\.json$/.test(n)), [], 'no half-written file is left');
    // and a normal write replaces it whole
    await good.handlers['recovery:meta'](good.ev, 'k1', { name: 'c.pdf' });
    assert.equal(JSON.parse(readFileSync(path.join(root, 'k1.json'), 'utf8')).name, 'c.pdf');
    assert.deepEqual(readdirSync(root), ['k1.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('1.9 (b): a recovery PDF without its JSON is kept (and logged) at the next start; discarded and partial files still go', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plan19c-'));
  try {
    const w = (n: string, t = 'x') => writeFileSync(path.join(root, n), t);
    w('orphan.pdf');                      // the app stopped between the copy and its .json
    w('live.pdf'); w('live.json', '{"name":"live.pdf"}');
    w('gone.pdf'); w('gone.discard', ''); // discarded while a tab still read it
    w('half.pdf.tmp');                    // a copy the engine was still writing
    w('lost.base.pdf');                   // a base copy nobody names
    const r = recovery(root);
    await r.cleanRecovery();
    assert.deepEqual(readdirSync(root).sort(), ['live.json', 'live.pdf', 'orphan.pdf']);
    assert.ok(r.logs.some((l) => l.includes('orphan.pdf')), 'the kept copy is logged');
    // "Discard" on a copy that can't be deleted (still open) leaves the mark
    const locked = { ...fs.promises, unlink: async (f: string) => { if (f.endsWith('open.pdf')) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.promises.unlink(f); } };
    w('open.pdf'); w('open.json');
    const r2 = recovery(root, locked as typeof fs.promises);
    await r2.handlers['recovery:clear'](r2.ev, 'open');
    await new Promise((res) => setTimeout(res, 30));
    assert.ok(existsSync(path.join(root, 'open.discard')), 'the discard is remembered');
    await recovery(root).cleanRecovery();
    assert.ok(!existsSync(path.join(root, 'open.pdf')) && !existsSync(path.join(root, 'open.discard')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('1.9 (c): reports.cjs deletes report-words.tmp after the job', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plan19d-'));
  const M = Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown };
  const realLoad = M._load;
  const seen: { words: string; existed: boolean; content: string }[] = [];
  const fakeElectron = {
    app: { getPath: () => root },
    utilityProcess: {
      fork: (_f: string, args: string[]) => {
        const words = args[args.length - 1];
        seen.push({ words, existed: existsSync(words), content: existsSync(words) ? readFileSync(words, 'utf8') : '' });
        const h: Record<string, (m?: unknown) => void> = {};
        setTimeout(() => h.exit && h.exit(), 5);
        return { on: (n: string, f: (m?: unknown) => void) => { h[n] = f; }, kill() {} };
      },
    },
  };
  M._load = (req: string, ...a: unknown[]) => (req === 'electron' ? fakeElectron : realLoad.call(Module, req, ...a));
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { create } = req(path.resolve('electron/reports.cjs')) as { create: (o: Record<string, unknown>) => { flush: () => Promise<unknown> } };
    mkdirSync(path.join(root, 'reports-outbox'), { recursive: true });
    writeFileSync(path.join(root, 'reports-outbox', 'r1.json'), JSON.stringify({ kind: 'problem', time: new Date().toISOString() }));
    const rep = create({
      version: '0', readSettings: () => ({ recent: ['C:\\Tenders\\Secret Tower\\boq.pdf'] }), writeSettings() {}, log() {}, logFile: () => path.join(root, 'x.log'),
      source: () => '', appName: 'T', send() {}, endpoint: 'https://example.invalid/r',
    });
    await rep.flush();
    assert.equal(seen.length, 1, 'the job was started');
    assert.ok(seen[0].existed, 'the names file existed while the job ran');
    assert.ok(seen[0].content.includes('boq.pdf'));
    assert.ok(!existsSync(seen[0].words), 'and is gone after it');
    assert.deepEqual(readdirSync(root).filter((n) => n.includes('report-words')), []);
  } finally { M._load = realLoad; rmSync(root, { recursive: true, force: true }); }
});

test('1.9 (d): eachPage hands each page over as it arrives and stops at once when the view changes', async () => {
  const got: number[] = [];
  let live = true;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // pages 1..4, each slow; the view changes while page 3 is being read
  const p = eachPage([1, 2, 3, 4], async (i) => { await wait(15); if (i === 3) live = false; return 'm' + i; }, (i) => { got.push(i); }, () => live);
  await wait(25);
  assert.deepEqual(got, [1], 'page 1 is shown before the others are done');
  await p;
  assert.deepEqual(got, [1, 2], 'page 3 finished after the view changed: dropped; page 4 never fetched');
  // nothing changes: all pages, in order
  const all: number[] = [];
  await eachPage([5, 6], async (i) => i, (i) => { all.push(i); }, () => true);
  assert.deepEqual(all, [5, 6]);
  // the Viewer really uses it (the effect has no hand-over after the loop any more)
  const v = readFileSync('src/ui/Viewer.tsx', 'utf8');
  assert.match(v, /eachPage\(visible,/);
  assert.doesNotMatch(v, /for \(const i of visible\) add\[i\] = await doc\.annots\(i\)/);
});
