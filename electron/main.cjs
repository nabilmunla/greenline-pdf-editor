// PDF Editor - Electron main process.
// Windows of tabs: every PDF opens as a tab (double-click in Explorer adds one to the window used
// last); a tab dragged out of its window opens in a window of its own and can be dragged back.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, net, clipboard, nativeImage, utilityProcess, MessageChannelMain, safeStorage, screen, webContents } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const winprint = require('./winprint.cjs');

const VERSION = require('../package.json').version;
const APP = 'PDF Editor';
// the name people see (title bar, messages, Explorer): the public build's own - files and folders
// keep APP's name (settings, work folders, the exe) so nothing moves
const DISPLAY = String(require('../package.json').displayName || APP);

function arg(name) {
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3).replace(/^"|"$/g, '') : null;
}
const profile = (arg('profile') || 'default').replace(/[^\w-]/g, '');
app.setPath('userData', path.join(app.getPath('appData'), APP, profile === 'default' ? '' : 'profile-' + profile));
// big things that belong to this PC stay out of the roaming profile (it is copied at every
// sign-in, or lives on a server): backups, page previews, unsaved-work copies, Chromium's caches
const localDir = () => process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, APP, profile === 'default' ? '' : 'profile-' + profile)
  : app.getPath('userData');
try { app.setPath('sessionData', path.join(localDir(), 'session')); } catch (_) { /* older Electron: stays */ }

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

/** PDF paths on a command line (Explorer passes the file as an argument) */
function pdfArgs(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('--') && /\.pdf$/i.test(a) && fs.existsSync(a)).map((a) => path.resolve(a));
}

// Explorer's "Combine with PDF Editor" (several PDFs selected): Windows runs the command once per
// file, all at the same moment. The files of one selection gather in the spool folder (one small
// file per PDF), left there by "PDF Editor Combine.exe" (resources\app\bin - what the Explorer
// entry runs from 0.8.6 on; it then starts the app with --combine-spool) or by a start of the app
// itself given --combine (the entry of 0.8.5 and of the setup). The copy that runs picks them up
// into one Merge dialog. Only one of the starts goes on to the running copy (launch.lock): up to
// 0.8.5 every start knocked on its door, and a copy still starting up (no window yet, busy for
// more than a few seconds - dozens of heavy starts at once) was taken for hung and closed by
// Chromium's single-instance rule: no Merge dialog at all.
const isCombine = (argv) => argv.includes('--combine') || argv.includes('--combine-spool');
const combineDir = () => path.join(localDir(), 'combine');
const combineLock = () => path.join(combineDir(), 'launch.lock');
// (a process this account may not look at is not one of ours: its number was reused)
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
/** launch.lock names the start that goes on (or the app it started): taken over once that has
 *  ended, or after 90 s (as PDF Editor Combine.exe does). Two starts taking over the same old lock
 *  at once both go on - harmless: the files stay in the spool until a window is up (takeSpool), so
 *  a copy closed by the other's knock while starting loses nothing. */
function combineLockStale() {
  let st;
  try { st = fs.statSync(combineLock()); } catch (_) { return true; }
  const age = Date.now() - st.mtimeMs;
  if (age > 90000) return true;
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(combineLock(), 'utf8'), 10) || 0; } catch (_) { /* being written */ }
  return pid > 0 ? !pidAlive(pid) : age > 15000;
}
/** this start's files into the spool. true: this start goes on (it holds launch.lock); false: it is
 *  done (another start of the same selection goes on); null: the spool can't be used - the files
 *  go with this start, as before */
function spoolOwn(files) {
  const dir = combineDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    files.forEach((f, i) => {
      const n = path.join(dir, `${Date.now()}-${process.pid}-${i}`);
      fs.writeFileSync(n + '.tmp', f);
      fs.renameSync(n + '.tmp', n + '.path');
    });
  } catch (_) { return null; }
  for (let t = 0; t < 2; t++) {
    try {
      const fd = fs.openSync(combineLock(), 'wx');
      try { fs.writeSync(fd, `${process.pid} ${Date.now()}`); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true;
      if (!combineLockStale()) return false;
      try { fs.unlinkSync(combineLock()); } catch (_) { /* taken over meanwhile */ }
    }
  }
  return false;
}
let startFiles = pdfArgs(process.argv);
if (process.argv.includes('--combine') && startFiles.length) {
  const r = spoolOwn(startFiles);
  if (r === false) { app.exit(0); return; }
  if (r === true) startFiles = [];
}
if (!app.requestSingleInstanceLock({ files: startFiles, combine: isCombine(process.argv) })) {
  app.quit();
  return;
}

const dataDir = () => app.getPath('userData');
const settingsPath = () => path.join(dataDir(), 'settings.json');
const isLock = (e) => !!e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Settings hold the person's stamps, signatures, tool chest, AI keys, updates folder..., and every
 *  change reads them all, changes one thing and writes them all back. So a file that can't be read
 *  right now (an antivirus or the indexer holds it) or that a power cut left damaged is never taken
 *  for "no settings" (that wiped everything at the next write): the copy last read or written whole
 *  is used - kept here, and on disk as settings.json.bak - and a damaged file is kept aside
 *  (settings.damaged-<time>.json) before anything is written over it. */
let settingsGood = null; // the text last read or written whole
let settingsBad = ''; // the file couldn't be read: 'locked' | 'damaged'
const noBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
/** the settings as last read or written, with the file's size and time then: read again only when
 *  the file changed. (They hold the stamps and drawn signatures as pictures - MBs once there are a
 *  few - and were read and parsed from disk at every call, dozens of times per file opened, in the
 *  main process: everything else waited meanwhile.) */
let settingsMem = null;
/** a copy of plain JSON data (objects and arrays new, strings shared - they can't be changed, and
 *  the pictures in them are most of the bytes): callers may change what they get */
function jsonCopy(v) {
  if (Array.isArray(v)) return v.map((x) => (x === undefined || typeof x === 'function' ? null : jsonCopy(x)));
  if (v && typeof v === 'object') {
    if (typeof v.toJSON === 'function') return JSON.parse(JSON.stringify(v));
    const o = {};
    for (const k of Object.keys(v)) { const x = v[k]; if (x !== undefined && typeof x !== 'function') o[k] = jsonCopy(x); }
    return o;
  }
  return typeof v === 'number' && !Number.isFinite(v) ? null : v;
}
function readSettings() {
  const f = settingsPath();
  if (settingsMem && !settingsBad) {
    try { const st = fs.statSync(f); if (st.size === settingsMem.size && st.mtimeMs === settingsMem.mtime) return jsonCopy(settingsMem.obj); } catch (_) { /* read below */ }
  }
  for (let k = 0; ; k++) {
    try {
      // (a settings file saved by Notepad or a PowerShell script starts with a BOM: read as damaged,
      // every setting was dropped and the backup copy written over with the empty ones)
      const st = fs.statSync(f);
      const txt = noBom(fs.readFileSync(f, 'utf8'));
      const s = JSON.parse(txt);
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('not a settings file');
      settingsGood = txt;
      settingsBad = '';
      settingsMem = { obj: s, size: st.size, mtime: st.mtimeMs };
      return jsonCopy(s);
    } catch (e) {
      // (none yet: the first start)
      if (e.code === 'ENOENT') { settingsBad = ''; settingsMem = null; return settingsGood ? JSON.parse(settingsGood) : {}; }
      if (isLock(e) && k < 4) { pause(60 * (k + 1)); continue; }
      if (!settingsBad) log('settings.json could not be read (' + (e.code || e.message) + '): ' + (settingsGood ? 'the copy read last is used' : 'the backup copy is used if there is one'));
      settingsBad = isLock(e) ? 'locked' : 'damaged';
      if (settingsGood) return JSON.parse(settingsGood);
      try {
        const txt = noBom(fs.readFileSync(f + '.bak', 'utf8'));
        const s = JSON.parse(txt);
        if (s && typeof s === 'object' && !Array.isArray(s)) { settingsGood = txt; return s; }
      } catch (_) { /* no backup copy */ }
      return {};
    }
  }
}
function writeSettings(s) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const f = settingsPath();
  if (settingsBad) {
    const madeOn = settingsGood;
    readSettings(); // (once more: it may be free again)
    // never written over blind: what was built from "no settings" would replace all of them
    if (settingsBad === 'locked' && !settingsGood) throw new Error('The settings file is in use by another program - try again in a moment.');
    // free again, and not what this change was made on (nothing, or the older backup copy stood in
    // for it): written, it put back "no settings" or the older copy - this change is refused once,
    // the next one reads the file as it is
    if (!settingsBad && settingsGood !== madeOn) throw new Error('The settings file was in use by another program - try again.');
    if (settingsBad === 'damaged') {
      try { fs.copyFileSync(f, path.join(dataDir(), 'settings.damaged-' + Date.now() + '.json')); } catch (e) { log('damaged settings not kept: ' + e.message); }
      settingsBad = '';
    }
  }
  const text = JSON.stringify(s, null, 2);
  // (nothing changed - the same recent list, a setting set to what it was: not written again)
  if (text === settingsGood && settingsMem) {
    try { const st = fs.statSync(f); if (st.size === settingsMem.size && st.mtimeMs === settingsMem.mtime) return; } catch (_) { /* written below */ }
  }
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, text);
  // (an antivirus or the indexer can hold settings.json for a moment: tried again)
  for (let k = 0; ; k++) {
    try { fs.renameSync(tmp, f); break; } catch (e) {
      if (k >= 4 || !isLock(e)) throw e;
      pause(60 * (k + 1));
    }
  }
  settingsGood = text;
  settingsMem = null;
  try { const st = fs.statSync(f); settingsMem = { obj: jsonCopy(s), size: st.size, mtime: st.mtimeMs }; } catch (_) { /* read next time */ }
  // the second copy, refreshed every 10 minutes at most - so it is older than the file itself and
  // whole when a power cut catches settings.json being written
  try {
    const bak = f + '.bak';
    let age = Infinity;
    try { age = Date.now() - fs.statSync(bak).mtimeMs; } catch (_) { /* none yet */ }
    if (age > 600000) fs.writeFileSync(bak, text);
  } catch (e) { log('settings backup: ' + e.message); }
}
let logLines = 0;
function log(line) {
  try {
    const dir = path.join(dataDir(), 'logs');
    const f = path.join(dir, 'app.log');
    fs.mkdirSync(dir, { recursive: true });
    // (kept to a few MB: the older part goes to app.old.log)
    if (logLines++ % 400 === 0) { try { if (fs.statSync(f).size > 4e6) fs.renameSync(f, path.join(dir, 'app.old.log')); } catch (_) { /* none yet */ } }
    fs.appendFileSync(f, new Date().toISOString() + ' ' + line + '\n');
  } catch (_) { /* never let logging break the app */ }
}
let reports = null; // crash / problem reports (below)
process.on('uncaughtException', (e) => { log('main uncaught: ' + (e && e.stack ? e.stack : e)); if (reports) reports.crash('main', e); });
process.on('unhandledRejection', (e) => { log('main rejection: ' + (e && e.stack ? e.stack : e)); if (reports) reports.crash('main (promise)', e); });

/** every window: its tabs live in its page; here its close state, engines' port target, and where its
 *  tab strip is (for tabs dragged in from another window) */
const wins = new Map(); // BrowserWindow id -> W
const focusOrder = []; // window ids, the one used last at the end
const W_of = (e) => { try { const w = e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null; return w ? wins.get(w.id) || null : null; } catch (_) { return null; } };
const live = (W) => !!W && !W.win.isDestroyed();
/** the windows, the one used last first */
function byUse() {
  const out = [];
  for (let i = focusOrder.length - 1; i >= 0; i--) { const W = wins.get(focusOrder[i]); if (live(W)) out.push(W); }
  for (const W of wins.values()) if (live(W) && !out.includes(W)) out.push(W);
  return out;
}
/** the window to show things in (files from Explorer, the Merge dialog): the one used last */
const mainW = () => byUse()[0] || null;
const winOf = (e) => { const W = W_of(e) || mainW(); return W ? W.win : null; };
const broadcast = (ch, v) => { for (const W of wins.values()) if (live(W)) W.win.webContents.send(ch, v); };
let restarting = false;
let pendingOpen = isCombine(process.argv) ? [] : pdfArgs(process.argv);
/** files for one Merge dialog, still arriving (one start per file) */
const combine = { files: isCombine(process.argv) ? startFiles.slice() : [], timer: null, first: 0 };

const TITLEBAR = {
  light: { color: '#09302f', symbolColor: '#ffffff', height: 40 },
  dark: { color: '#020d0c', symbolColor: '#e8eeec', height: 40 },
};

function createWindow(opts = {}) {
  const s = readSettings();
  const win = new BrowserWindow({
    width: opts.width || s.width || 1500,
    height: opts.height || s.height || 940,
    ...(opts.x !== undefined ? { x: opts.x, y: opts.y } : {}),
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: DISPLAY,
    backgroundColor: '#09302f',
    icon: path.join(__dirname, '..', 'dist', 'icon256.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLEBAR.light,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // (the preload uses only contextBridge, ipcRenderer and webUtils: it runs sandboxed - a
      // fault in the window can't reach Node or the PC through it)
      sandbox: true,
      spellcheck: true,
      // (tests: --renderers=N runs N drawing engines whatever the PC)
      additionalArguments: (arg('renderers') || process.env.GCC_RENDERERS) ? ['--gcc-renderers=' + (arg('renderers') || process.env.GCC_RENDERERS)] : [],
    },
  });
  const W = { win, id: win.id, wcId: win.webContents.id, allowClose: false, closeAskedAt: 0, hung: false, ready: false, adopt: [], strip: null, paths: new Set() };
  wins.set(win.id, W);
  win.on('focus', () => { const i = focusOrder.indexOf(win.id); if (i >= 0) focusOrder.splice(i, 1); focusOrder.push(win.id); });
  // (a window made for a dragged-out tab opens where it was dropped, not maximized)
  if (s.maximized && opts.x === undefined) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://gcc/index.html');
  win.webContents.on('did-start-loading', () => { W.ready = false; for (const [k, o] of recOwner) if (o === W.wcId) recOwner.delete(k); });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log('renderer gone: ' + JSON.stringify(d));
    if (reports && d.reason !== 'clean-exit') reports.crash('window gone', { message: d.reason + ' (exit ' + d.exitCode + ')' });
    if (W.allowClose || quitting || d.reason === 'clean-exit' || win.isDestroyed()) return;
    // the window is blank now: start it again (unsaved work is offered back from the automatic
    // copies), or close
    const w = win;
    void dialog.showMessageBox(w, { type: 'error', message: 'The ' + DISPLAY + ' window stopped working', detail: 'Reason: ' + d.reason + '. Start it again: unsaved work from the last automatic copy (made every 45 seconds, every 2 minutes for very big files) is offered back.', buttons: ['Start again', 'Close'], defaultId: 0, noLink: true })
      .then((r) => { if (w.isDestroyed()) return; if (r.response === 0) w.webContents.reload(); else { W.allowClose = true; w.close(); } })
      .catch(() => {});
  });
  // the window not answering (hung, or crashed): the close button must still work
  win.on('unresponsive', () => { W.hung = true; log('window not responding'); });
  win.on('responsive', () => { W.hung = false; });
  win.on('close', (e) => {
    try {
      const b = win.getNormalBounds();
      writeSettings({ ...readSettings(), width: b.width, height: b.height, maximized: win.isMaximized() });
    } catch (err) { log('window size not saved: ' + err.message); }
    if (W.allowClose) return;
    if (win.webContents.isCrashed()) return;
    e.preventDefault();
    const waited = W.closeAskedAt ? Date.now() - W.closeAskedAt : 0;
    if (W.hung || waited > 20000) {
      const w = win;
      const r = dialog.showMessageBoxSync(w, { type: 'warning', message: DISPLAY + ' is not responding', detail: 'Close it anyway? Changes since the last automatic copy (made every 45 seconds, every 2 minutes for very big files) may be lost - the rest is offered back next time.', buttons: ['Close anyway', 'Wait'], defaultId: 1, cancelId: 1, noLink: true });
      if (r === 0) { W.allowClose = true; w.destroy(); }
      return;
    }
    if (!W.closeAskedAt) W.closeAskedAt = Date.now();
    win.webContents.send('app:closing');
  });
  win.on('closed', () => {
    wins.delete(W.id);
    const i = focusOrder.indexOf(W.id);
    if (i >= 0) focusOrder.splice(i, 1);
    stopEngines(W.wcId);
    for (const [k, o] of recOwner) if (o === W.wcId) recOwner.delete(k);
  });
  return W;
}
ipcMain.on('app:closeAnswered', (e) => { const W = W_of(e); if (W) W.closeAskedAt = 0; });

// ---------------------------------------------------------------- files

/** a hidden working name next to `file` (".~name.xxxx.tmp"; never the same twice - two windows
 *  saving at once don't share one) */
const stagingName = (file, ext) => path.join(path.dirname(file), '.~' + path.basename(file) + '.' + process.pid + Math.random().toString(36).slice(2, 6) + '.' + ext);

/** write next to the target, then swap in: a crash mid-write never leaves half a PDF */
async function writeSafe(file, data, keepBackup) {
  const tmp = stagingName(file, 'tmp');
  try {
    // (in here: a write cut short - a full disk - leaves no half copy beside the file)
    await fsp.writeFile(tmp, data);
    // (a backup that can't be made - a full C: drive - doesn't stop the save itself)
    let bk = '';
    if (keepBackup && fs.existsSync(file)) bk = await backup(file).catch((e) => { log('backup failed: ' + e.message); return ''; });
    try {
      await fsp.rename(tmp, file);
    } catch (e) {
      // the file is open in another program (Windows locks it): written over in place, safely
      if (!isLock(e)) throw e;
      await overwriteInPlace(tmp, file, bk);
      await fsp.unlink(tmp).catch(() => {});
    }
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
  sweepStaging(file);
  const st = await fsp.stat(file);
  return { size: st.size, mtime: st.mtimeMs };
}

/**
 * The file is held by another program that lets it be written but not replaced or renamed (some
 * PDF readers do): the new content is copied over it. Copying starts by emptying the file, so a
 * copy that stops halfway (a full disk, a share that drops, the PC switched off) would leave half
 * a PDF under its name: the old content is kept first (the backup just made, else a hidden copy
 * beside it), the result is checked, and the old content is put back if it isn't whole.
 */
async function overwriteInPlace(tmp, file, orig) {
  const want = (await fsp.stat(tmp)).size;
  // (no file there yet - Save as or an export to a new name - and the rename was refused because
  // something holds the fresh copy for a moment, an antivirus looking at it: there is nothing to
  // keep, it is copied into place as before; it failed with "no such file" for the new name)
  const before = await fsp.stat(file).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (!before) {
    await retrying(() => fsp.copyFile(tmp, file));
    if ((await fsp.stat(file)).size !== want) { await fsp.unlink(file).catch(() => {}); throw Object.assign(new Error('the copy came out short'), { code: 'EIO' }); }
    return;
  }
  let own = '';
  if (!orig) { own = stagingName(file, 'orig'); await fsp.copyFile(file, own); orig = own; }
  try {
    await retrying(() => fsp.copyFile(tmp, file));
    if ((await fsp.stat(file)).size !== want) throw Object.assign(new Error('the copy came out short'), { code: 'EIO' });
  } catch (e) {
    // (refused before anything was written - the other program doesn't share the file at all: it
    // is as it was)
    const now = await fsp.stat(file).catch(() => null);
    if (now && now.size === before.size && now.mtimeMs === before.mtimeMs) { if (own) await fsp.unlink(own).catch(() => {}); throw e; }
    try { await retrying(() => fsp.copyFile(orig, file)); } catch (e2) {
      log('could not put back ' + file + ' from ' + orig + ': ' + e2.message);
      const err = new Error(`"${path.basename(file)}" couldn't be saved, and its previous version couldn't be put back in its place. A copy of the previous version is "${orig}".`);
      err.code = 'EIO';
      throw err;
    }
    if (own) await fsp.unlink(own).catch(() => {});
    throw e;
  }
  if (own) await fsp.unlink(own).catch(() => {});
}

/** what a save cut short (a crash, the PC switched off) left beside a file: its hidden working
 *  copies (".~name.xxxx.tmp" / ".part", a whole PDF each) - removed at a later save of the same
 *  file once they're an hour old (a save still running keeps writing to its own) */
function sweepStaging(file) {
  const dir = path.dirname(file);
  const pre = '.~' + path.basename(file) + '.';
  fsp.readdir(dir).then(async (names) => {
    for (const n of names) {
      if (!n.startsWith(pre) || !/\.(tmp|part)$/i.test(n)) continue;
      const f = path.join(dir, n);
      try { if (Date.now() - (await fsp.stat(f)).mtimeMs > 3600000) await fsp.unlink(f); } catch (_) { /* in use, or gone */ }
    }
  }).catch(() => {});
}

/** our temp folder for engine output (snapshots, saved files before they're moved in place) */
const workDir = () => path.join(os.tmpdir(), APP, 'work');
const inWork = (f) => path.resolve(f).startsWith(path.resolve(workDir()) + path.sep);
/** a file an engine wrote straight into the target folder while saving (".~name.xxxx.part") */
const isPart = (f) => /^\.~.+\.part$/.test(path.basename(String(f)));

/** old copies of files saved over while still open (Windows): deleted once let go */
const oldListFile = () => path.join(dataDir(), 'pending-delete.json');
let oldFiles = (() => { try { return JSON.parse(fs.readFileSync(oldListFile(), 'utf8')); } catch (_) { return []; } })();
function cleanOld() {
  const keep = [];
  for (const f of oldFiles) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') keep.push(f); } }
  oldFiles = keep;
  try { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(oldListFile(), JSON.stringify(oldFiles)); } catch (_) { /* */ }
}

/**
 * Move a finished file (written by an engine in our temp folder) to `file`, safely: copied
 * next to it first, then swapped in. If the file is open in the engines (they read it on
 * demand), Windows refuses to replace it: the old one is renamed aside (hidden, deleted
 * when no longer used) and the new one takes its name - the engines keep reading the old.
 */
async function commitFile(src, file, keepBackup) {
  const dir = path.dirname(file);
  const tmp = stagingName(file, 'tmp');
  let inPlace = false;
  try {
    try { await fsp.rename(src, tmp); } catch (_) { await fsp.copyFile(src, tmp); }
    // (a backup that can't be made - a full C: drive - doesn't stop the save itself)
    let bk = '';
    if (keepBackup && fs.existsSync(file)) bk = await backup(file).catch((e) => { log('backup failed: ' + e.message); return ''; });
    try {
      await fsp.rename(tmp, file);
    } catch (e) {
      if (!(e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) throw e;
      const old = path.join(dir, '.~' + path.basename(file) + '.' + Date.now().toString(36) + '.old');
      let aside = false;
      try { await retrying(() => fsp.rename(file, old), 2); aside = true; } catch (_) { /* locked by another program */ }
      if (aside) {
        // the new file takes the name (an antivirus may hold the fresh copy for a moment: tried
        // again); if it still can't, the old file goes back - the original is never left missing
        try { await retrying(() => fsp.rename(tmp, file)); } catch (e2) {
          await retrying(() => fsp.rename(old, file)).catch((e3) => log('could not put back ' + file + ': ' + e3.message));
          throw e2;
        }
        oldFiles.push(old);
        cleanOld();
        if (process.platform === 'win32') require('child_process').execFile('attrib', ['+h', old], { windowsHide: true }, () => {});
      } else {
        await overwriteInPlace(tmp, file, bk);
        await fsp.unlink(tmp).catch(() => {});
        inPlace = true;
      }
    }
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  } finally {
    if (inWork(src)) fsp.rm(path.dirname(src), { recursive: true, force: true }).catch(() => {});
    else if (isPart(src)) fsp.unlink(src).catch(() => {});
  }
  sweepStaging(file);
  const st = await fsp.stat(file);
  return { size: st.size, mtime: st.mtimeMs, inPlace };
}
/** a file call that Windows refuses for a moment (an antivirus or the indexer has the file):
 *  tried again a few times, waiting a little longer each time */
async function retrying(fn, tries = 5) {
  for (let k = 0; ; k++) {
    try { return await fn(); } catch (e) {
      if (k >= tries - 1 || !(e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 100 * 2 ** k));
    }
  }
}
/** a copy of the file as it is now in the backups folder; its path */
async function backup(file) {
  const bdir = path.join(localDir(), 'backups');
  await fsp.mkdir(bdir, { recursive: true });
  // (named by the PC's own clock, like Explorer's "Date modified" next to it - UTC was 4 hours
  // early in Dubai; same shape as before, so old and new names sort together)
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  const to = path.join(bdir, stamp + ' ' + path.basename(file));
  await fsp.copyFile(file, to);
  // keep the newest 40 backups, and no more than 6 GB of them (40 copies of a 300 MB book
  // would be 12 GB); the newest one - this one - always stays
  const all = (await fsp.readdir(bdir)).sort().reverse();
  let total = 0;
  for (let i = 0; i < all.length; i++) {
    const f = path.join(bdir, all[i]);
    let size = 0;
    try { size = (await fsp.stat(f)).size; } catch (_) { continue; }
    total += size;
    if (i > 0 && f !== to && (i >= 40 || total > 6e9)) await fsp.unlink(f).catch(() => {});
  }
  return to;
}
/** what file:commit may put in place: the documents and pictures the app makes - or a file of another
 *  name in a place the person chose (a PDF named "x.pdf_old" saved in place), never a program or script.
 *  (The window's own bytes reach the engine folder through a recovery copy: without this, a misbehaving
 *  window could have put "run-me.cmd" in the Startup folder.) */
const COMMIT_OK = /\.(pdf|docx|xlsx|png|jpe?g)$/i;
const RUNNABLE = /\.(exe|com|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|mjs|cjs|wsf|wsh|msi|msp|mst|scr|pif|lnk|url|cpl|hta|jar|reg|dll|sys|drv|ocx|inf|msc|scf|application|appref-ms|settingcontent-ms|library-ms|search-ms|gadget|xll|asar|node)$/i;
ipcMain.handle('file:commit', async (_e, src, file, opts) => {
  if (!inWork(src) && !(isPart(src) && path.dirname(path.resolve(src)) === path.dirname(path.resolve(file)))) throw new Error('not an engine file');
  if (typeof file !== 'string' || !file || (!COMMIT_OK.test(file) && (RUNNABLE.test(file) || !chosenPlace(file)))) { log('commit refused: ' + file); throw new Error('That kind of file can\'t be saved here.'); }
  try { return await commitFile(src, file, !(opts && opts.noBackup)); } catch (e) { log('commit ' + file + ': ' + e.message); throw lockedError(e, file); }
});
ipcMain.handle('file:dropTemp', async (_e, paths) => {
  for (const p of paths || []) {
    if (p && inWork(p)) await fsp.rm(path.dirname(p), { recursive: true, force: true }).catch(() => {});
    else if (p && isPart(p)) await fsp.unlink(p).catch(() => {});
    // pages made ready for a drag out of the Pages panel that ended as a reorder (each in a folder
    // of its own in the drag folder): they stayed for a day
    else if (p && path.dirname(path.dirname(path.resolve(String(p)))) === path.resolve(dragDir())) await fsp.rm(path.dirname(path.resolve(String(p))), { recursive: true, force: true }).catch(() => {});
  }
  return true;
});
/** `f` is inside the folder `dir` (not the folder itself, not beside it) */
function inside(dir, f) {
  const r = path.relative(path.resolve(dir), path.resolve(String(f)));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}
/** a copy in our temp folder of a recovery file (which must stay free to be deleted) - only of
 *  those: the window has no other files to copy around */
ipcMain.handle('file:toTemp', async (_e, src) => {
  if (!inside(recDir(), src)) throw new Error('not a recovery copy');
  const d = path.join(workDir(), 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  await fsp.mkdir(d, { recursive: true });
  const f = path.join(d, path.basename(src));
  await fsp.copyFile(src, f);
  return f;
});
ipcMain.on('docs:closed', () => { if (oldFiles.length) setTimeout(cleanOld, 500); });

ipcMain.handle('file:read', async (_e, p) => {
  // (only a file the person picked, or one the engines made: the window can't read the PC at will)
  if (typeof p !== 'string' || !(inWork(p) || chosenFiles.has(fullKey(p)))) { log('read refused (not chosen): ' + p); throw new Error('That file was not chosen here.'); }
  const b = await fsp.readFile(p);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
});
ipcMain.handle('file:stat', async (_e, p) => {
  try {
    const st = await fsp.stat(p);
    let writable = true;
    try { await fsp.access(p, fs.constants.W_OK); } catch (_) { writable = false; }
    // (on Windows that only sees the read-only mark: a share or folder that is read-only by its
    // permissions passes - opening the file for writing tells; nothing is written. Held by another
    // program: left to the save, which works round that)
    if (writable && process.platform === 'win32' && st.isFile()) {
      try { const h = await fsp.open(p, 'r+'); await h.close(); } catch (e) { if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') writable = false; }
    }
    // which file it is, whatever the spelling: a mapped drive (Y:\...) and its network path
    // (\\server\share\...) are the same file; the volume + file number say so too where the
    // system gives one (0 on some shares)
    let real = await new Promise((res) => fs.realpath.native(p, (err, r) => res(err ? '' : String(r))));
    if (process.platform === 'win32') real = real.toLowerCase();
    // (the file number as a big integer: as an ordinary number, NTFS file numbers lose their last
    // digits and neighbouring files came out "the same")
    let fid = '';
    try { const b = await fsp.stat(p, { bigint: true }); if (b.ino) fid = b.dev + ':' + b.ino; } catch (_) { /* none */ }
    return { size: st.size, mtime: st.mtimeMs, writable, real, fid };
  } catch (_) { return null; }
});
/** Windows refused to replace a file another program has open (Excel, a PDF reader...): said so */
function lockedError(e, file) {
  if (e && e.code === 'ENOENT' && !fs.existsSync(path.dirname(file))) {
    const err = new Error(`The folder "${path.dirname(file)}" doesn't exist any more (moved, renamed, or a drive not connected). Pick another place.`);
    err.code = e.code;
    return err;
  }
  if (e && e.code === 'ENOSPC') {
    const err = new Error(`There is no room left on the drive of "${path.dirname(file)}". Make some room there, or save somewhere else.`);
    err.code = e.code;
    return err;
  }
  if (e && e.code === 'ENAMETOOLONG') {
    const err = new Error(`The name or folder path is too long for Windows ("${path.basename(file).slice(0, 40)}…"). Choose a shorter name or a folder nearer the top of the drive.`);
    err.code = e.code;
    return err;
  }
  if (!e || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return e;
  // a new file that can't be made: the folder doesn't let us write, nothing is "open" anywhere
  if ((e.code === 'EACCES' || e.code === 'EPERM') && !fs.existsSync(file)) {
    const err = new Error(`Can't save into "${path.dirname(file)}": that folder is read-only for you. Pick another folder.`);
    err.code = e.code;
    return err;
  }
  const err = new Error(`"${path.basename(file)}" is open in another program (Excel, a PDF reader...) or read-only. Close it there, then try again.`);
  err.code = e.code;
  return err;
}
/** files the person picked in a Save dialog this session (folder + name, any extension): the only
 *  places the window may write bytes of its own to (Excel lists, pictures). PDFs are saved by the
 *  engines and moved in place through file:commit. */
const chosenSaves = new Set();
const pathKey = (p) => { const r = path.resolve(String(p)).replace(/\.[^.\\/]*$/, ''); return process.platform === 'win32' ? r.toLowerCase() : r; };
/** files and folders the person picked this session (Open / Save / folder dialogs, files Windows
 *  handed over): the window may read those files, list those folders, and open / show places on a
 *  network share only inside them (a share path the window made up - "\\\\attacker\\x" - would
 *  make Windows send the person's sign-in to that server) */
const fullKey = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
const chosenFiles = new Set();
const chosenDirs = new Set();
function noteChosen(files, dirs) {
  for (const f of files || []) { if (typeof f === 'string' && f) { chosenFiles.add(fullKey(f)); chosenDirs.add(fullKey(path.dirname(f))); } }
  for (const d of dirs || []) if (typeof d === 'string' && d) chosenDirs.add(fullKey(d));
}
const isShare = (s) => /^[\\/]{2}/.test(String(s));
/** a place the person chose (or inside one), the updates folder, or the app's own folders */
function chosenPlace(s) {
  const k = fullKey(s);
  if (chosenFiles.has(k) || chosenSaves.has(pathKey(s))) return true;
  for (const d of chosenDirs) if (k === d || k.startsWith(d.endsWith(path.sep) ? d : d + path.sep)) return true;
  try { const u = readSettings().updateSource || (fs.existsSync(path.join(path.dirname(process.execPath), 'update.json')) ? JSON.parse(fs.readFileSync(path.join(path.dirname(process.execPath), 'update.json'), 'utf8')).source : ''); if (u && (k === fullKey(u) || k.startsWith(fullKey(u) + path.sep))) return true; } catch (_) { /* none */ }
  for (const d of [localDir(), app.getPath('userData'), os.tmpdir()]) { const dk = fullKey(d); if (k === dk || k.startsWith(dk + path.sep)) return true; }
  // (files opened before - Recent files, session restore, dragged in: the list keeps them - and
  // their folders: "Show in folder" for a tender file on a share opened from Recent did nothing)
  try { for (const r of readSettings().recent || []) if (typeof r === 'string' && r && (k === fullKey(r) || k === fullKey(path.dirname(r)))) return true; } catch (_) { /* none */ }
  return false;
}
// (files Windows handed over when the app started: chosen by the person in Explorer)
noteChosen(pdfArgs(process.argv));
ipcMain.handle('file:write', async (_e, p, data, opts) => {
  if (!chosenSaves.has(pathKey(p))) { log('write refused (not chosen in a Save dialog): ' + p); throw new Error('Choose where to save it first (Save as).'); }
  try { return await writeSafe(p, Buffer.from(data), !(opts && opts.noBackup)); } catch (e) { log('write ' + p + ': ' + e.message); throw lockedError(e, p); }
});
ipcMain.handle('file:exists', (_e, p) => fs.existsSync(p));
/** PDFs (or pictures: kind 'pictures') in a folder, its sub-folders too when asked */
ipcMain.handle('file:list', async (_e, dir, recursive, kind) => {
  if (typeof dir !== 'string' || !chosenDirs.has(fullKey(dir))) { log('list refused (not chosen): ' + dir); return []; }
  const want = kind === 'pictures' ? /\.(jpe?g|jfif|png|tiff?|bmp|gif)$/i : /\.pdf$/i;
  const out = [];
  async function walk(d, depth) {
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive && depth < 6) await walk(f, depth + 1); }
      else if (want.test(e.name)) out.push(f);
    }
  }
  await walk(dir, 0);
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
});
/** a font from Windows' font folder (for text edits in fonts the PDF doesn't embed fully) - a
 *  font file's name only ("arial.ttf"), nothing outside those folders */
ipcMain.handle('file:systemFont', async (_e, name) => {
  if (typeof name !== 'string' || /[\\/:]/.test(name) || !/^[^.].*\.(ttf|otf|ttc)$/i.test(name)) return null;
  const dirs = [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts')];
  for (const d of dirs) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) { const b = await fsp.readFile(f); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  }
  return null;
});

// page previews of files opened before (fast reopen of heavy drawings)
const cacheDir = () => path.join(localDir(), 'cache', 'previews');
const cacheFile = (k) => path.join(cacheDir(), cacheName(k));
const cacheName = (k) => String(k).replace(/[^\w.-]/g, '_') + '.webp';
/** The cache's files (name -> last use, size), kept up to date by its own reads and writes. Listed
 *  from disk once, in the background a while after the start, a few files at a time. (The whole
 *  folder - tens of thousands of files once it has filled up over a few months - was looked
 *  through at every start and then after every 60 pictures, all at once: the disk threads were
 *  taken for seconds on Windows, and the page previews being read from the cache waited behind.) */
const cacheIdx = { map: new Map(), total: 0, listed: false, listing: false };
const CACHE_MAX = Number(process.env.PDFED_CACHE_MAX) || 800e6;
function cacheNote(name, size) {
  const o = cacheIdx.map.get(name);
  if (o) cacheIdx.total -= o.s;
  cacheIdx.map.set(name, { t: Date.now(), s: size });
  cacheIdx.total += size;
}
async function listCache() {
  if (cacheIdx.listed || cacheIdx.listing) return;
  cacheIdx.listing = true;
  try {
    let names = [];
    try { names = await fsp.readdir(cacheDir()); } catch (_) { /* no cache yet */ }
    for (let i = 0; i < names.length; i += 16) {
      await Promise.all(names.slice(i, i + 16).map(async (f) => {
        if (cacheIdx.map.has(f)) return; // (written or read meanwhile: known better)
        try { const st = await fsp.stat(path.join(cacheDir(), f)); if (!cacheIdx.map.has(f)) { cacheIdx.map.set(f, { t: Math.max(st.atimeMs, st.mtimeMs), s: st.size }); cacheIdx.total += st.size; } } catch (_) { /* gone */ }
      }));
    }
    cacheIdx.listed = true;
  } finally { cacheIdx.listing = false; }
  void trimCache();
}
/** keep the cache under ~800 MB: the files used longest ago go first, down to 90% (so it isn't done
 *  again after every picture) */
let trimming = false;
async function trimCache() {
  if (!cacheIdx.listed || trimming || cacheIdx.total <= CACHE_MAX) return;
  trimming = true;
  try {
    const old = [...cacheIdx.map.entries()].sort((a, b) => a[1].t - b[1].t);
    const out = [];
    let total = cacheIdx.total;
    for (const [f, o] of old) { if (total <= CACHE_MAX * 0.9) break; out.push(f); total -= o.s; }
    for (let i = 0; i < out.length; i += 8) {
      await Promise.all(out.slice(i, i + 8).map(async (f) => {
        const o = cacheIdx.map.get(f);
        await fsp.unlink(path.join(cacheDir(), f)).catch(() => {});
        if (o && cacheIdx.map.get(f) === o) { cacheIdx.map.delete(f); cacheIdx.total -= o.s; }
      }));
    }
  } finally { trimming = false; }
}
ipcMain.handle('cache:get', async (_e, k) => {
  try {
    const b = await fsp.readFile(cacheFile(k));
    const o = cacheIdx.map.get(cacheName(k));
    if (o) o.t = Date.now(); else cacheNote(cacheName(k), b.byteLength);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } catch (_) { return null; }
});
ipcMain.handle('cache:put', async (_e, k, data) => {
  try {
    await fsp.mkdir(cacheDir(), { recursive: true });
    const b = Buffer.from(data);
    await fsp.writeFile(cacheFile(k), b);
    cacheNote(cacheName(k), b.byteLength);
    void trimCache();
  } catch (_) { /* a cache is optional */ }
  return true;
});

// recovery copies of unsaved work (written every 45 s while there are changes; 2 min above 150 MB)
const recDir = () => path.join(localDir(), 'recovery');
/** whose copy each one is (window's webContents id): one window doesn't offer another's live work back */
const recOwner = new Map();
const recKey = (key) => String(key).replace(/[^\w-]/g, '_');
ipcMain.handle('recovery:write', async (_e, key, data, meta) => {
  // (the key made safe as a file name, as everywhere here: never a path out of the folder)
  const k = recKey(key);
  recOwner.set(k, _e.sender.id);
  await fsp.mkdir(recDir(), { recursive: true });
  await writeSafe(path.join(recDir(), k + '.pdf'), Buffer.from(data), false);
  await fsp.writeFile(path.join(recDir(), k + '.json'), JSON.stringify({ ...meta, time: Date.now() }));
  return true;
});
/** where the engine writes a recovery copy */
ipcMain.handle('recovery:path', async (_e, key) => {
  recOwner.set(recKey(key), _e.sender.id);
  await fsp.mkdir(recDir(), { recursive: true });
  return path.join(recDir(), String(key).replace(/[^\w-]/g, '_') + '.pdf');
});
ipcMain.handle('recovery:meta', async (_e, key, meta) => {
  recOwner.set(recKey(key), _e.sender.id);
  await fsp.writeFile(path.join(recDir(), String(key).replace(/[^\w-]/g, '_') + '.json'), JSON.stringify({ ...meta, time: Date.now() }));
  return true;
});
ipcMain.handle('recovery:clear', async (_e, key) => {
  const k = recKey(key);
  recOwner.delete(k);
  await fsp.unlink(path.join(recDir(), k + '.json')).catch(() => {});
  await fsp.unlink(path.join(recDir(), k + '.pdf')).catch(() => {});
  // (a copy the engine was still writing when it stopped: unsaved work too, gone with "Discard")
  await fsp.unlink(path.join(recDir(), k + '.pdf.tmp')).catch(() => {});
  // (the copy of a saved-over file the changes were written against; still open by a restored
  // tab it stays - removed at the next start, see cleanRecovery)
  await fsp.unlink(path.join(recDir(), k + '.base.pdf')).catch(() => {});
  return true;
});
/** recovery files left without their .json (cleared while a tab still read them) */
async function cleanRecovery() {
  try {
    const all = await fsp.readdir(recDir());
    const keys = new Set(all.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
    // a .json may name another key's base copy (a restored file saved again): those stay too
    const used = new Set();
    for (const k of keys) { try { const m = JSON.parse(await fsp.readFile(path.join(recDir(), k + '.json'), 'utf8')); if (m.base && m.base.path) used.add(path.basename(m.base.path)); } catch (_) { /* skip */ } }
    for (const f of all) {
      const k = f.replace(/(\.base)?\.pdf(\.tmp)?$/i, '');
      if (f.endsWith('.json') || keys.has(k) || used.has(f)) continue;
      await fsp.unlink(path.join(recDir(), f)).catch(() => {});
    }
  } catch (_) { /* no folder yet */ }
}
ipcMain.handle('recovery:list', async (_e) => {
  try {
    const out = [];
    for (const f of await fsp.readdir(recDir())) {
      if (!f.endsWith('.json')) continue;
      // (another open window's unsaved work: not left behind, it's in use)
      const o = recOwner.get(f.replace(/\.json$/, ''));
      if (o !== undefined && o !== _e.sender.id) { const wc = webContents.fromId(o); if (wc && !wc.isDestroyed()) continue; }
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(recDir(), f), 'utf8'));
        const pdf = path.join(recDir(), f.replace(/\.json$/, '.pdf'));
        if (fs.existsSync(pdf)) out.push({ key: f.replace(/\.json$/, ''), file: pdf, ...meta });
      } catch (_) { /* skip */ }
    }
    return out;
  } catch (_) { return []; }
});

// ---------------------------------------------------------------- dialogs

ipcMain.handle('dialog:open', async (_e, opts) => {
  const s = readSettings();
  const r = await dialog.showOpenDialog(winOf(_e), {
    title: (opts && opts.title) || 'Open PDF',
    defaultPath: (opts && opts.dir) || s.lastOpenDir || undefined,
    properties: ['openFile', ...(opts && opts.single ? [] : ['multiSelections'])],
    filters: (opts && opts.filters) || [{ name: 'PDF files', extensions: ['pdf'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return [];
  noteChosen(r.filePaths);
  // (only where to start next time: a settings file that can't be written now doesn't stop the open)
  if (!opts || !opts.filters) { try { writeSettings({ ...readSettings(), lastOpenDir: path.dirname(r.filePaths[0]) }); } catch (e) { log('settings: ' + e.message); } }
  return r.filePaths;
});
ipcMain.handle('dialog:save', async (_e, opts) => {
  const s = readSettings();
  const r = await dialog.showSaveDialog(winOf(_e), {
    title: (opts && opts.title) || 'Save as',
    defaultPath: (opts && opts.path) || path.join(s.lastSaveDir || app.getPath('documents'), (opts && opts.name) || 'document.pdf'),
    filters: (opts && opts.filters) || [{ name: 'PDF files', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  chosenSaves.add(pathKey(r.filePath));
  noteChosen([], [path.dirname(r.filePath)]);
  try { writeSettings({ ...readSettings(), lastSaveDir: path.dirname(r.filePath) }); } catch (e) { log('settings: ' + e.message); }
  return r.filePath;
});
ipcMain.handle('dialog:dir', async (_e, opts) => {
  const r = await dialog.showOpenDialog(winOf(_e), { title: (opts && opts.title) || 'Choose a folder', defaultPath: (opts && opts.dir) || undefined, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  noteChosen([], [r.filePaths[0]]);
  return r.filePaths[0];
});
ipcMain.handle('dialog:confirm', async (_e, o) => {
  const r = await dialog.showMessageBox(winOf(_e), { type: o.type || 'question', title: DISPLAY, message: o.message, detail: o.detail || '', buttons: o.buttons, defaultId: 0, cancelId: o.buttons.length - 1, noLink: true });
  return r.response;
});

// ---------------------------------------------------------------- app services

// (the name markups are signed with: the author set in Settings, else the Windows user)
ipcMain.handle('app:user', () => readSettings().author || os.userInfo().username);
ipcMain.handle('app:info', () => {
  const s = readSettings();
  return {
    version: VERSION,
    user: s.author || os.userInfo().username,
    winUser: os.userInfo().username,
    platform: process.platform,
    dataDir: dataDir(),
    localDir: localDir(),
    theme: s.theme || 'system',
    open: pendingOpen.splice(0),
  };
});
// (stale: the file couldn't be read just now and a stand-in copy came back - the window reads again
// before it builds on lists from it: stamps, signatures)
ipcMain.handle('settings:get', () => { const s = readSettings(); return settingsBad ? { ...s, $stale: true } : s; });
// where each file was left (page, spot, zoom): reopened at the same view. Last 500 files.
const viewsFile = () => path.join(dataDir(), 'views.json');
const viewKey = (p) => path.resolve(String(p)).toLowerCase();
/** the remembered views; null = the file is there but can't be read now (an antivirus holds it) -
 *  then nothing is written over it, that would forget all 500 */
function readViews() {
  for (let k = 0; ; k++) {
    let txt;
    try { txt = fs.readFileSync(viewsFile(), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return {};
      if (isLock(e) && k < 2) { pause(50); continue; }
      return null;
    }
    // (one a power cut left damaged is lost already: started again)
    try { const all = JSON.parse(txt); return all && typeof all === 'object' && !Array.isArray(all) ? all : {}; } catch (_) { return {}; }
  }
}
ipcMain.handle('view:get', (_e, p) => (readViews() || {})[viewKey(p)] || null);
ipcMain.handle('view:set', (_e, p, v) => {
  const all = readViews();
  if (!all) { log('views: views.json is in use - this view is not remembered'); return true; }
  all[viewKey(p)] = { ...v, t: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > 500) keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0)).slice(0, keys.length - 500).forEach((k) => delete all[k]);
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(viewsFile() + '.tmp', JSON.stringify(all));
    fs.renameSync(viewsFile() + '.tmp', viewsFile());
  } catch (e) { log('views: ' + e); }
  return true;
});
ipcMain.handle('settings:set', (_e, patch) => {
  const cur = readSettings();
  // closing every window for an update: each adds its files to reopen (none is dropped)
  if (restarting && patch && 'reopenAfterRestart' in patch) {
    const add = Array.isArray(patch.reopenAfterRestart) ? patch.reopenAfterRestart : [];
    patch = { ...patch, reopenAfterRestart: [...new Set([...(Array.isArray(cur.reopenAfterRestart) ? cur.reopenAfterRestart : []), ...add])] };
  } else if (patch && Array.isArray(patch.reopenAfterRestart)) {
    // a window that went on closing for a restart another window has since cancelled: its files
    // open again in a window that stays (left in the list, they popped up at some later start)
    const T = byUse().find((x) => x.win.webContents !== _e.sender);
    if (T) { reopenIn(T, patch.reopenAfterRestart); patch = { ...patch }; delete patch.reopenAfterRestart; }
  }
  writeSettings({ ...cur, ...patch });
  // the other windows take the change in: each writes its lists whole (recent files, stamps,
  // signatures, Tool chest...) from its own copy - what one window added, the next write of another
  // window dropped
  const shared = { ...patch };
  delete shared.reopenAfterRestart;
  if (Object.keys(shared).length) for (const W of wins.values()) if (live(W) && W.win.webContents !== _e.sender) W.win.webContents.send('settings:changed', shared);
  return true;
});
/** files of windows closed for a restart that didn't happen: opened again in the window `W` */
function reopenIn(W, files) {
  const list = (Array.isArray(files) ? files : []).filter((x) => typeof x === 'string' && x);
  if (!list.length || !live(W)) return;
  log('restart cancelled: ' + list.length + ' file(s) opened again');
  noteChosen(list);
  W.win.webContents.send('app:open', list);
}
ipcMain.handle('win:theme', (_e, mode) => {
  const win = winOf(_e);
  try { if (win && process.platform === 'win32') win.setTitleBarOverlay(mode === 'dark' ? TITLEBAR.dark : TITLEBAR.light); } catch (_) { /* not supported */ }
  return true;
});
ipcMain.handle('win:title', (_e, t) => { const win = winOf(_e); if (win) win.setTitle(t); return true; });
// Clipboard: Electron 44 replaced writeImage / readImage / write({ text, html }) with the async
// W3C-style API (write([ClipboardItem]), read()). The old calls threw, so copying text, tables
// and snapshots and pasting pictures all did nothing. (Old API kept as a fallback.)
const { ClipboardItem } = require('electron');
ipcMain.handle('clip:image', async (_e, png) => {
  if (!(png instanceof Uint8Array) && !Buffer.isBuffer(png)) throw new Error('not a picture');
  const img = nativeImage.createFromBuffer(Buffer.from(png));
  if (img.isEmpty()) throw new Error('not a picture');
  if (typeof clipboard.writeImage === 'function') { clipboard.writeImage(img); return true; }
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })]);
  return true;
});
ipcMain.handle('clip:text', async (_e, t, html) => {
  const text = String(t ?? '');
  if (typeof ClipboardItem !== 'function') { clipboard.write(html ? { text, html: String(html) } : { text }); return true; }
  await clipboard.write([new ClipboardItem(html ? { 'text/plain': text, 'text/html': String(html) } : { 'text/plain': text })]);
  return true;
});
ipcMain.handle('clip:readImage', async () => {
  if (typeof clipboard.readImage === 'function') { const im = clipboard.readImage(); return im.isEmpty() ? null : new Uint8Array(im.toPNG()); }
  for (const item of await clipboard.read()) {
    const type = item.types.find((x) => /^image\/(png|jpeg|bmp|gif|webp)$/i.test(x));
    if (!type) continue;
    const bytes = Buffer.from(await (await item.getType(type)).arrayBuffer());
    const im = nativeImage.createFromBuffer(bytes);
    return im.isEmpty() ? null : new Uint8Array(im.toPNG());
  }
  return null;
});
/** a path on a disk or a share - not a web address or a Windows protocol handler ("ms-x:...") */
const diskPath = (s) => typeof s === 'string' && path.isAbsolute(s) && !/^[a-z][a-z0-9+.-]+:(?![\\/])/i.test(s);
ipcMain.handle('shell:show', (_e, p) => { if (diskPath(p) && (!isShare(p) || chosenPlace(p))) { shell.showItemInFolder(p); return true; } log('show refused: ' + p); return false; });
// folders, and files of the kinds the app saves (lists, pictures, documents) - never a program or a
// script; links go through shell:link. (A list of kinds to refuse always missed some: ".chm",
// "x.exe." - Windows drops the dot at the end -, "x.pdf:stream".)
const OPENABLE = /\.(pdf|xlsx|xls|csv|docx|png|jpe?g|txt)$/i;
ipcMain.handle('shell:open', async (_e, p) => {
  const s = String(p || '');
  if (!diskPath(s) || /[.\s]$/.test(s) || s.slice(2).includes(':')) return 'refused';
  if (isShare(s) && !chosenPlace(s)) { log('open refused (share not chosen): ' + s); return 'refused'; }
  let folder = false;
  try { folder = (await fsp.stat(s)).isDirectory(); } catch (_) { /* not there */ }
  if (!folder && !OPENABLE.test(s)) return 'refused';
  return shell.openPath(s);
});
ipcMain.handle('shell:link', async (_e, u) => {
  const s = String(u || '').trim();
  if (!/^(https?:\/\/|mailto:)/i.test(s)) return false;
  await shell.openExternal(s);
  return true;
});

/** print: Chromium's own PDF viewer (PDFium) in a window, with its print dialog */
// ---------------------------------------------------------------- dragging pages out as a file
const dragDir = () => path.join(os.tmpdir(), 'PDF Editor drag');
ipcMain.handle('drag:prepare', async (_e, data, name) => {
  const d = path.join(dragDir(), Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  await fsp.mkdir(d, { recursive: true });
  const f = path.join(d, String(name || 'pages.pdf').replace(/[\\/:*?"<>|]/g, '_'));
  // data: bytes, or the path of a file an engine wrote in our temp folder
  if (typeof data === 'string') {
    if (!inWork(data)) throw new Error('not an engine file');
    try { await fsp.rename(data, f); } catch (_) { await fsp.copyFile(data, f); }
    fsp.rm(path.dirname(data), { recursive: true, force: true }).catch(() => {});
  } else await fsp.writeFile(f, Buffer.from(data));
  return f;
});
ipcMain.on('drag:start', (e, file, png) => {
  try {
    let icon = png ? nativeImage.createFromBuffer(Buffer.from(png)) : null;
    if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', 'dist', 'icon256.png')).resize({ width: 48 });
    e.sender.startDrag({ file, icon });
  } catch (err) { log('drag: ' + (err && err.stack ? err.stack : err)); }
});
/** temp files from earlier drags, and print files a crash or a printer that never answered left
 *  behind (older than a day) */
async function cleanDragDir() {
  for (const dir of [dragDir(), printDir()]) {
    try {
      for (const d of await fsp.readdir(dir)) {
        const f = path.join(dir, d);
        const st = await fsp.stat(f);
        if (Date.now() - st.mtimeMs > 86400000) await fsp.rm(f, { recursive: true, force: true });
      }
    } catch (_) { /* nothing there */ }
  }
}
const printDir = () => path.join(os.tmpdir(), 'gcc-pdf-print');

ipcMain.handle('app:print', async (_e, data, name) => {
  const dir = path.join(os.tmpdir(), 'gcc-pdf-print');
  await fsp.mkdir(dir, { recursive: true });
  const f = path.join(dir, Date.now() + ' ' + (name || 'print.pdf').replace(/[\\/:*?"<>|]/g, '_'));
  if (typeof data === 'string') {
    if (!inWork(data)) throw new Error('not an engine file');
    try { await fsp.rename(data, f); } catch (_) { await fsp.copyFile(data, f); }
  } else await fsp.writeFile(f, Buffer.from(data));
  const pw = new BrowserWindow({ width: 1100, height: 850, title: 'Print – ' + (name || ''), parent: winOf(_e), autoHideMenuBar: true, webPreferences: { plugins: true, sandbox: true } });
  pw.loadURL(pathToFileURL(f).href);
  pw.on('closed', () => fsp.unlink(f).catch(() => {}));
  return true;
});

/** the printer chosen last - for this run only: the next start offers Windows' default printer
 *  again (it was kept in the settings, and every start offered the printer used last) */
let sessionPrinter = '';
ipcMain.handle('print:sessionPrinter', (_e, name) => {
  if (typeof name === 'string') sessionPrinter = name.slice(0, 300);
  return sessionPrinter;
});
/** printers on this PC (name, displayName, isDefault, status...) */
ipcMain.handle('print:printers', async (_e) => {
  try {
    // (Windows' default printer from the registry: Electron's list doesn't say which it is)
    const [l, def] = await Promise.all([winOf(_e).webContents.getPrintersAsync(), winprint.defaultPrinter()]);
    const out = winprint.markDefault(l.map((p) => ({ name: p.name, displayName: p.displayName || p.name, description: p.description || '', status: p.status ?? 0 })), def);
    if (def && !out.some((p) => p.isDefault)) log('printers: the default printer "' + def + '" is not in the list');
    return out;
  } catch (e) { log('printers: ' + e); return []; }
});
/** the picked printer's own preferences window (tray, quality, finishing) - see winprint.openPrefs */
ipcMain.handle('print:prefs', async (_e, name) => {
  const r = await winprint.openPrefs(name);
  log('print: preferences of "' + name + '" ' + (r.ok ? 'opened' : 'not opened: ' + r.reason));
  return r;
});
/**
 * Print a file made for printing (each page already on its sheet): straight to the printer
 * (silent), or through Windows' own print dialog (printer preferences: trays, quality...).
 * Drawn by Chromium's PDF engine (PDFium) - vector, nothing turned into pictures.
 */
ipcMain.handle('print:run', async (_e, file, o) => {
  if (!inWork(file)) throw new Error('not an engine file');
  const dir = path.join(os.tmpdir(), 'gcc-pdf-print');
  await fsp.mkdir(dir, { recursive: true });
  const f = path.join(dir, Date.now().toString(36) + '.pdf');
  try { await fsp.rename(file, f); } catch (_) { await fsp.copyFile(file, f); }
  fsp.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
  const pw = new BrowserWindow({ show: false, width: 900, height: 1200, parent: winOf(_e), webPreferences: { plugins: true, sandbox: true } });
  let late = null; // (the printer's answer, when it didn't come in time)
  const t0 = Date.now();
  try {
    await pw.loadURL(pathToFileURL(f).href);
    // the PDF viewer reads the file after the page itself has loaded
    await new Promise((r) => setTimeout(r, Math.min(10000, 2000 + (o.sheets || 1) * 20)));
    const W = o.sheet ? o.sheet.w : 0, H = o.sheet ? o.sheet.h : 0;
    const opts = {
      silent: !o.dialog,
      printBackground: true,
      deviceName: o.deviceName || undefined,
      copies: Math.max(1, Math.min(999, o.copies || 1)),
      collate: o.collate !== false,
      color: o.color !== false,
      duplexMode: o.duplex || 'simplex',
      margins: { marginType: 'none' },
      // (the paper in full - with Windows' paper code for A3, A4...: given as pageSize, only its
      // width and height reached the driver, and many printed A4 whatever was asked; no pageSize
      // here, or print() would put its own media size over this one)
      ...(W && H ? { landscape: W > H, mediaSize: winprint.mediaSizeFor(W, H) } : {}),
    };
    const answer = new Promise((resolve) => pw.webContents.print(opts, (ok, reason) => resolve({ ok, reason: reason || '' })));
    // the answer comes once the job is in the printer's queue - or never (a stopped print queue, a
    // driver that hangs), and the print panel waited on "Sending to the printer..." for good. Told
    // after a while instead - generous, a long job of big sheets takes minutes to hand over - and
    // the job itself is left alone: its window waits for a late answer in the background
    const limit = o.dialog ? 1800000 : Math.min(1800000, 120000 + (o.sheets || 1) * 6000);
    let t = null;
    const res = await Promise.race([answer, new Promise((r) => { t = setTimeout(() => r(null), limit); })]);
    clearTimeout(t);
    if (!res) {
      late = answer;
      log('print: no answer from the printer in ' + Math.round(limit / 1000) + ' s');
      return { ok: false, reason: "the printer hasn't confirmed the job - look at its print queue in Windows before printing again" };
    }
    if (!res.ok) log('print: ' + res.reason);
    // (how long Windows and the printer took to take the job: "some files take ages" can be
    // told apart from the app's own part in a problem report)
    let size = 0;
    try { size = (await fsp.stat(f)).size; } catch { /* gone */ }
    log(`print: ${o.sheets || 1} sheets, ${Math.round(size / 1024)} KB, taken by the printer in ${Math.round((Date.now() - t0) / 100) / 10} s`);
    return res;
  } finally {
    // the spooler has the job once print() answers; a moment more for slow drivers
    const end = () => setTimeout(() => { if (!pw.isDestroyed()) pw.destroy(); fsp.unlink(f).catch(() => {}); }, 4000);
    if (late) void Promise.race([late, new Promise((r) => setTimeout(r, 1800000))]).then(end);
    else end();
  }
});

/** register in Windows "Open with" (per user, no admin). PDFs get their own icon: a page with a
 *  red PDF label and the app's G as a badge (the app's own icon alone didn't say "PDF"). */
const fileIcon = () => path.join(__dirname, '..', 'dist', 'pdf-file.ico');
async function registerOpenWith() {
  if (process.platform !== 'win32') return { ok: false, msg: 'Windows only' };
  const exe = process.execPath;
  const { execFile } = require('child_process');
  const reg = (...a) => new Promise((res) => execFile('reg', a, { windowsHide: true }, (err) => res(!err)));
  const base = 'HKCU\\Software\\Classes';
  const icon = fs.existsSync(fileIcon()) ? '"' + fileIcon() + '",0' : '"' + exe + '",0';
  const ok = [
    await reg('add', base + '\\PDFEditor.Document', '/ve', '/d', 'PDF document', '/f'),
    await reg('add', base + '\\PDFEditor.Document\\DefaultIcon', '/ve', '/d', icon, '/f'),
    await reg('add', base + '\\PDFEditor.Document\\shell\\open\\command', '/ve', '/d', '"' + exe + '" "%1"', '/f'),
    await reg('add', base + '\\.pdf\\OpenWithProgids', '/v', 'PDFEditor.Document', '/t', 'REG_NONE', '/f'),
    await reg('add', base + '\\Applications\\PDF Editor.exe', '/v', 'FriendlyAppName', '/t', 'REG_SZ', '/d', DISPLAY, '/f'),
    await reg('add', base + '\\Applications\\PDF Editor.exe\\DefaultIcon', '/ve', '/d', icon, '/f'),
    await reg('add', base + '\\Applications\\PDF Editor.exe\\SupportedTypes', '/v', '.pdf', '/t', 'REG_SZ', '/d', '', '/f'),
    await reg('add', base + '\\Applications\\PDF Editor.exe\\shell\\open\\command', '/ve', '/d', '"' + exe + '" "%1"', '/f'),
    ...(await registerCombine(reg, base, exe)),
  ].every(Boolean);
  // Explorer caches icons: ask it to look again
  execFile('ie4uinit.exe', ['-show'], { windowsHide: true }, () => {});
  return { ok };
}
/** Explorer: select PDFs > right-click > "Combine with PDF Editor" (Windows 11: Show more options).
 *  Player: offered for up to 100 files (without it Windows hides it above 15; above 100 it is
 *  hidden whatever - a Windows limit for this kind of entry). */
const COMBINE_KEY = '\\SystemFileAssociations\\.pdf\\shell\\PDFEditor.Combine';
/** the small program Explorer runs per file (see the top of this file); only when it runs here (an
 *  antivirus could block a program it doesn't know) - else the app itself, as up to 0.8.5 */
const combineExe = () => path.join(__dirname, '..', 'bin', 'PDF Editor Combine.exe');
let combineExeOk = null;
function combineCommand(exe) {
  if (combineExeOk === null) {
    combineExeOk = process.platform !== 'win32' || !fs.existsSync(combineExe()) ? Promise.resolve(false)
      : new Promise((res) => require('child_process').execFile(combineExe(), ['--selftest'], { windowsHide: true, timeout: 15000 }, (err) => {
        if (err) log('combine: "PDF Editor Combine.exe" does not run here (' + (err.code || err.message) + ') - the Explorer entry starts the app itself');
        res(!err);
      }));
  }
  return combineExeOk.then((ok) => (ok ? '"' + combineExe() + '" "%1"' : '"' + exe + '" --combine "%1"'));
}
async function registerCombine(reg, base, exe) {
  const cmd = await combineCommand(exe);
  return [
    await reg('add', base + COMBINE_KEY, '/ve', '/d', 'Combine with ' + DISPLAY, '/f'),
    await reg('add', base + COMBINE_KEY, '/v', 'Icon', '/d', '"' + exe + '",0', '/f'),
    await reg('add', base + COMBINE_KEY, '/v', 'MultiSelectModel', '/d', 'Player', '/f'),
    await reg('add', base + COMBINE_KEY + '\\command', '/ve', '/d', cmd, '/f'),
  ];
}
ipcMain.handle('app:registerOpenWith', () => registerOpenWith());
/** already registered (an earlier version): keep it pointing at this copy, with the PDF icon */
async function refreshRegistration() {
  if (process.platform !== 'win32') return;
  const { execFile } = require('child_process');
  const query = (key) => new Promise((res) => execFile('reg', ['query', key, '/ve'], { windowsHide: true }, (err, so) => res(err ? '' : String(so))));
  const comb = (await query('HKCU\\Software\\Classes' + COMBINE_KEY + '\\command')) || (await query('HKLM\\Software\\Classes' + COMBINE_KEY + '\\command'));
  // (0.8.6: from the app itself to PDF Editor Combine.exe - the entry of 0.8.5 and of the setup
  // is changed at the first start)
  const combineHere = comb.toLowerCase().includes((await combineCommand(process.execPath)).toLowerCase());
  // an installed copy gets Explorer's "Combine with PDF Editor" (per user, no admin) - updated
  // from 0.5.0 by the app update alone, the setup that adds it never ran
  if (updater.snapshot().installed && !combineHere) {
    const reg = (...a) => new Promise((res) => execFile('reg', a, { windowsHide: true }, (err) => res(!err)));
    const ok = (await registerCombine(reg, 'HKCU\\Software\\Classes', process.execPath)).every(Boolean);
    log('Explorer combine entry added: ' + ok);
  }
  const out = await query('HKCU\\Software\\Classes\\PDFEditor.Document\\DefaultIcon');
  if (!out) return; // never registered: that stays the person's choice
  if (out.includes(fileIcon()) && out.toLowerCase().includes('pdf-file.ico') && (combineHere || updater.snapshot().installed)) return;
  const r = await registerOpenWith();
  log('file association refreshed: ' + JSON.stringify(r));
}

// ---------------------------------------------------------------- AI assistant (Claude / ChatGPT)
// Keys are stored encrypted with Windows' own protection (DPAPI via safeStorage), never in
// the page. Requests go out from here (system proxy settings apply) and the answer streams
// back to the window as it is written.
const AI = {
  anthropic: { base: process.env.PDFED_AI_ANTHROPIC || 'https://api.anthropic.com', name: 'Claude' },
  openai: { base: process.env.PDFED_AI_OPENAI || 'https://api.openai.com', name: 'ChatGPT' },
};
/** Linux (test machines only) without a keyring: Chromium's basic store */
function linuxKeyFallback() {
  try { if (process.platform === 'linux' && !safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() === 'basic_text') safeStorage.setUsePlainTextEncryption(true); } catch (_) { /* n/a */ }
}
function aiKey(provider) {
  const enc = (readSettings().aiKeys || {})[provider];
  if (!enc) return '';
  try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : ''; } catch (_) { return ''; }
}
ipcMain.handle('ai:keys', () => {
  linuxKeyFallback();
  const k = readSettings().aiKeys || {};
  return { anthropic: !!k.anthropic, openai: !!k.openai, secure: safeStorage.isEncryptionAvailable() };
});
ipcMain.handle('ai:setKey', async (_e, provider, key, check) => {
  if (!AI[provider]) throw new Error('unknown provider');
  // a new key is tried first: a typo or a network problem leaves the saved key as it was
  if (key && check) {
    let res;
    try { res = await net.fetch(AI[provider].base + '/v1/models' + (provider === 'anthropic' ? '?limit=1' : ''), { headers: aiHeaders(provider, String(key).trim()), signal: AbortSignal.timeout(20000) }); }
    catch (err) { throw new Error('Could not reach ' + AI[provider].name + ' to check the key (' + (err && err.message ? err.message : err) + '). The saved key was not changed.'); }
    if (!res.ok) throw new Error(await aiError(res, provider));
  }
  const s = readSettings();
  const keys = { ...(s.aiKeys || {}) };
  if (!key) delete keys[provider];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows key protection is not available on this PC, so the key can\'t be stored safely.');
    keys[provider] = safeStorage.encryptString(String(key).trim()).toString('base64');
  }
  writeSettings({ ...s, aiKeys: keys });
  return true;
});
function aiHeaders(provider, key) {
  return provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
}
/** a readable message for an HTTP error from either service */
async function aiError(res, provider) {
  let msg = '';
  try { const j = await res.json(); msg = (j.error && (j.error.message || j.error.type)) || j.message || ''; } catch (_) { /* not JSON */ }
  const name = AI[provider].name;
  if (res.status === 401 || res.status === 403) return `${name} refused the API key (${res.status}). Check it under AI settings.` + (msg ? ' – ' + msg : '');
  if (res.status === 429) return `${name} is busy or your account's limit was reached (429). Try again in a minute.` + (msg ? ' – ' + msg : '');
  if (res.status === 413) return `That is too much to send at once (413). Choose fewer pages.`;
  return `${name} answered with an error (${res.status})` + (msg ? ': ' + msg : '');
}
ipcMain.handle('ai:models', async (_e, provider) => {
  const key = aiKey(provider);
  if (!key) return [];
  const res = await net.fetch(AI[provider].base + '/v1/models' + (provider === 'anthropic' ? '?limit=100' : ''), { headers: aiHeaders(provider, key) });
  if (!res.ok) throw new Error(await aiError(res, provider));
  const j = await res.json();
  return (j.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id, created: m.created_at || m.created || 0 }));
});

/** provider-neutral message -> each service's format. parts: {t:'text'|'image'|'pdf', ...} */
function aiBody(provider, r) {
  if (provider === 'anthropic') {
    const messages = r.messages.map((m) => ({
      role: m.role,
      content: m.parts.map((p, i) => {
        let b;
        if (p.t === 'image') b = { type: 'image', source: { type: 'base64', media_type: p.mime || 'image/jpeg', data: p.b64 } };
        else if (p.t === 'pdf') b = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.b64 }, title: p.name || undefined };
        else b = { type: 'text', text: p.text };
        // the document context (all but the question) is cached: follow-ups cost much less
        if (m.cache && i === Math.max(0, m.parts.length - 2)) b.cache_control = { type: 'ephemeral' };
        return b;
      }),
    }));
    return { model: r.model, max_tokens: r.maxTokens || 4096, system: r.system, messages, stream: true };
  }
  const input = r.messages.map((m) => ({
    role: m.role,
    content: m.parts.map((p) => {
      if (m.role === 'assistant') return { type: 'output_text', text: p.text || '' };
      if (p.t === 'image') return { type: 'input_image', image_url: `data:${p.mime || 'image/jpeg'};base64,${p.b64}` };
      if (p.t === 'pdf') return { type: 'input_file', filename: p.name || 'pages.pdf', file_data: 'data:application/pdf;base64,' + p.b64 };
      return { type: 'input_text', text: p.text };
    }),
  }));
  return { model: r.model, instructions: r.system, input, max_output_tokens: r.maxTokens || 4096, stream: true };
}

const aiRuns = new Map(); // id -> AbortController
ipcMain.handle('ai:send', async (e, id, provider, r) => {
  const key = aiKey(provider);
  if (!key) throw new Error('No API key for ' + AI[provider].name + ' yet.');
  const ac = new AbortController();
  aiRuns.set(id, ac);
  const send = (ev) => { if (!e.sender.isDestroyed()) e.sender.send('ai:event', id, ev); };
  (async () => {
    try {
      const url = AI[provider].base + (provider === 'anthropic' ? '/v1/messages' : '/v1/responses');
      const res = await net.fetch(url, { method: 'POST', headers: aiHeaders(provider, key), body: JSON.stringify(aiBody(provider, r)), signal: ac.signal });
      if (!res.ok) { send({ type: 'error', message: await aiError(res, provider) }); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let usage = null;
      let stop = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, k);
          buf = buf.slice(k).replace(/^\r?\n\r?\n/, '');
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data || data === '[DONE]') continue;
          let j;
          try { j = JSON.parse(data); } catch (_) { continue; }
          if (provider === 'anthropic') {
            if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') send({ type: 'delta', text: j.delta.text });
            else if (j.type === 'message_start' && j.message && j.message.usage) usage = { ...j.message.usage };
            else if (j.type === 'message_delta') { if (j.usage) usage = { ...(usage || {}), ...j.usage }; if (j.delta && j.delta.stop_reason) stop = j.delta.stop_reason; }
            else if (j.type === 'error') { send({ type: 'error', message: 'Claude: ' + ((j.error && j.error.message) || 'error') }); return; }
          } else {
            if (j.type === 'response.output_text.delta') send({ type: 'delta', text: j.delta || '' });
            else if (j.type === 'response.completed') { usage = j.response && j.response.usage; stop = (j.response && j.response.status) || ''; }
            else if (j.type === 'response.incomplete') stop = 'max_tokens';
            else if (j.type === 'error' || j.type === 'response.failed') { send({ type: 'error', message: 'ChatGPT: ' + (j.message || (j.response && j.response.error && j.response.error.message) || 'error') }); return; }
          }
        }
      }
      send({ type: 'done', usage, stop });
    } catch (err) {
      if (ac.signal.aborted) send({ type: 'done', usage: null, stop: 'stopped' });
      else send({ type: 'error', message: 'Could not reach ' + AI[provider].name + ': ' + (err && err.message ? err.message : err) });
    } finally { aiRuns.delete(id); }
  })();
  return true;
});
ipcMain.handle('ai:cancel', (_e, id) => { const ac = aiRuns.get(id); if (ac) ac.abort(); return true; });

// ---------------------------------------------------------------- offline translator
const mt = require('./translator.cjs')({ dataDir, engineDir: path.join(__dirname, 'engines'), log });
ipcMain.handle('mt:languages', () => mt.languages());
ipcMain.handle('mt:status', (_e, from, to) => mt.status(from, to));
ipcMain.handle('mt:install', (e, from, to) => mt.install(from, to, (done, total) => { if (!e.sender.isDestroyed()) e.sender.send('mt:progress', from + '-' + to, done, total); }));
ipcMain.handle('mt:translate', (_e, from, to, texts) => mt.translate(from, to, texts));
app.on('before-quit', () => mt.stop());

/** a page of HTML (e.g. a translation, Arabic shaped properly by Chromium) as a PDF in our temp folder */
ipcMain.handle('html:toPdf', async (_e, html, name, opts) => {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  const d = path.join(workDir(), 'h-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  await fsp.mkdir(d, { recursive: true });
  // from a file, not a data: URL (those stop at 2 MB - a whole translated spec is more)
  const page = path.join(d, 'page.html');
  try {
    await fsp.writeFile(page, html, 'utf8');
    await w.loadFile(page);
    const pdf = await w.webContents.printToPDF({ pageSize: 'A4', landscape: !!(opts && opts.landscape), printBackground: true, margins: { marginType: 'default' } });
    const f = path.join(d, String(name || 'translation.pdf').replace(/[\\/:*?"<>|]/g, '_'));
    await fsp.writeFile(f, pdf);
    return f;
  } finally { w.destroy(); fsp.unlink(page).catch(() => {}); }
});

// ---------------------------------------------------------------- engines (background processes)
// Each engine is a Node process of its own with a direct message port to the window.
// If one dies (out of memory on a monster file), it is started again and the window gets
// a new port; the window reopens its files there.
const engines = new Map(); // window's webContents id + ':' + name -> { role, proc, gen, born, wc, name }
let quitting = false;
const engineDir = () => path.join(__dirname, 'engines');
const resDir = () => path.join(__dirname, '..', 'dist');

/** when each engine last died young (crash loop guard) */
const deaths = new Map();
function spawnEngine(wc, name, role, restarted, code) {
  const key = wc.id + ':' + name;
  const proc = utilityProcess.fork(path.join(engineDir(), role + '.mjs'), [resDir()], { serviceName: APP + ' ' + name, stdio: 'pipe' });
  const e = { role, proc, gen: (engines.get(key)?.gen ?? 0) + 1, born: Date.now(), wc, name };
  engines.set(key, e);
  const out = (b) => String(b).split('\n').filter(Boolean).forEach((l) => log('[' + name + '] ' + l));
  proc.stdout?.on('data', out);
  proc.stderr?.on('data', out);
  proc.on('message', (m) => { if (m && m.type === 'failed') log('engine ' + name + ' failed to start: ' + m.error); });
  proc.on('exit', (c) => {
    if (engines.get(key) !== e) return; // replaced on purpose
    log('engine ' + name + ' exited ' + c);
    if (quitting || wc.isDestroyed()) { engines.delete(key); return; }
    // crash loop guard: an engine that dies straight after starting is retried more slowly, and
    // one that keeps dying young (5 times within 2 minutes, each within 20 s of starting: a
    // damaged install, antivirus, no memory left) is not started for ever - the window is told,
    // so calls fail with a message instead of waiting on an engine that never comes
    const now = Date.now();
    const young = (deaths.get(key) || []).filter((t) => now - t < 120000);
    // (75: a planned restart. 70 from a drawing engine: a page too big for it took it down, after
    // answering that call with its error - the window blames that page and stops asking for it
    // after a second time, so a few such sheets in a row are not a loop; counted, they gave the
    // engine up for good while dense drawings were being scrolled through)
    if (now - e.born < 20000 && c !== 75 && !(role === 'render' && c === 70)) young.push(now);
    deaths.set(key, young);
    if (young.length >= 5) {
      engines.delete(key);
      deaths.delete(key);
      log('engine ' + name + ' keeps stopping (' + young.length + ' times in 2 minutes, exit ' + c + '): not started again');
      if (!wc.isDestroyed()) wc.send('engine:gaveUp', { name, code: c });
      return;
    }
    const wait = now - e.born < 3000 ? 1500 : 0;
    setTimeout(() => { if (!quitting && !wc.isDestroyed() && engines.get(key) === e) spawnEngine(wc, name, role, true, c); }, wait);
  });
  connectEngine(key, restarted, code);
  return e;
}
function connectEngine(key, restarted, code) {
  const e = engines.get(key);
  if (!e || e.wc.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  e.proc.postMessage({ type: 'port' }, [port1]);
  e.wc.postMessage('engine:port', { name: e.name, restarted: !!restarted, code: code ?? 0 }, [port2]);
}
/** a window's engines go with it */
function stopEngines(wcId) {
  for (const [k, e] of engines) if (k.startsWith(wcId + ':')) { engines.delete(k); try { e.proc.kill(); } catch (_) { /* gone */ } }
}
/** the window (re)starts: fresh engines of its own (anything a reloaded window had open is gone) */
ipcMain.handle('engines:start', (ev, list) => {
  stopEngines(ev.sender.id);
  for (const k of deaths.keys()) if (k.startsWith(ev.sender.id + ':')) deaths.delete(k);
  for (const { name, role } of list) spawnEngine(ev.sender, name, role === 'edit' ? 'edit' : 'render', false, 0);
  return true;
});
app.on('before-quit', () => { quitting = true; });

// ---------------------------------------------------------------- tabs between windows
// A tab dragged out of its window opens in a window of its own; dragged onto another window's
// top part (title bar, ribbon, tab strip) it joins that window's tabs. The file moves: the
// window it came from closes its tab once the other window has it open.
ipcMain.on('tabs:strip', (e, r) => { const W = W_of(e); if (W && r && typeof r.x === 'number') W.strip = r; });
/** the files each window has open (a file opened from Explorer that is open already goes to its window) */
ipcMain.on('tabs:paths', (e, list) => { const W = W_of(e); if (W && Array.isArray(list)) W.paths = new Set(list.map((p) => String(p).toLowerCase())); });
/** files open in the other windows (a batch job must not write over a file open there either) */
ipcMain.handle('tabs:elsewhere', (e) => { const me = W_of(e); const out = []; for (const W of wins.values()) if (W !== me && W.paths) out.push(...W.paths); return out; });
/** the window whose top part (down to just under its tab strip) is at this screen point */
function windowAt(x, y, exceptId) {
  for (const W of byUse()) {
    if (W.id === exceptId || !W.strip || W.win.isMinimized() || !W.win.isVisible()) continue;
    const cb = W.win.getContentBounds();
    const z = W.win.webContents.getZoomFactor() || 1;
    const bottom = cb.y + (W.strip.y + W.strip.h) * z + 24;
    if (x >= cb.x && x <= cb.x + cb.width && y >= cb.y - 40 && y <= bottom) return W;
    // (a window lying over the point hides the ones under it)
    const b = W.win.getBounds();
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) return null;
  }
  return null;
}
ipcMain.handle('tabs:target', (e, x, y) => { const W = windowAt(Number(x), Number(y), W_of(e)?.id); return W ? W.id : null; });
let hoverW = null;
ipcMain.on('tabs:hover', (e, x, y) => {
  const W = x === null ? null : windowAt(Number(x), Number(y), W_of(e)?.id);
  if (hoverW && hoverW !== W && live(hoverW)) hoverW.win.webContents.send('tabs:hover', false);
  if (W && W !== hoverW) W.win.webContents.send('tabs:hover', true);
  hoverW = W;
});
ipcMain.handle('win:count', () => byUse().length);
let transferSeq = 0;
const transfers = new Map(); // id -> resolve(ok)
ipcMain.handle('tabs:move', (e, payload, targetId, x, y) => {
  if (hoverW && live(hoverW)) hoverW.win.webContents.send('tabs:hover', false);
  hoverW = null;
  const src = W_of(e);
  const id = ++transferSeq;
  const done = new Promise((res) => {
    transfers.set(id, res);
    // (a window that never answers: the tab stays where it was)
    setTimeout(() => { if (transfers.delete(id)) res(false); }, 120000);
  });
  const p = { ...payload, transfer: id };
  let T = targetId ? wins.get(targetId) : null;
  if (live(T)) {
    if (T.win.isMinimized()) T.win.restore();
    T.win.focus();
  } else {
    // a window of its own where the tab was dropped (on screen, the size of the one it came from)
    const sb = live(src) ? src.win.getNormalBounds() : { width: 1500, height: 940 };
    const wa = screen.getDisplayNearestPoint({ x: Math.round(x) || 0, y: Math.round(y) || 0 }).workArea;
    const width = Math.min(sb.width, wa.width), height = Math.min(sb.height, wa.height);
    const nx = Math.max(wa.x, Math.min(wa.x + wa.width - width, Math.round(x) - 160));
    const ny = Math.max(wa.y, Math.min(wa.y + wa.height - height, Math.round(y) - 20));
    T = createWindow({ x: nx, y: ny, width, height });
  }
  if (T.ready) T.win.webContents.send('app:adopt', p);
  else T.adopt.push(p);
  return done;
});
ipcMain.on('tabs:adopted', (_e, id, ok) => { const res = transfers.get(id); if (res) { transfers.delete(id); res(!!ok); } });

// ---------------------------------------------------------------- updates (installed copies)
const updater = require('./updater.cjs').create({
  version: VERSION, readSettings, writeSettings, log, appName: APP,
  send: broadcast,
  // (a build's own web address for updates - the public build's GitHub repository; none in others)
  defaultSource: String(process.env.PDFED_UPDATE_FEED || require('../package.json').updateFeed || ''),
  build: String(require('../package.json').brand || 'company'),
});
/** close like the windows' close buttons (save prompts), then quit: the update runs after */
function closeForRestart() {
  const all = byUse();
  if (!all.length) { app.quit(); return; }
  restarting = true;
  for (const W of all) W.win.webContents.send('app:closing', { restart: true });
}
ipcMain.handle('update:get', () => updater.snapshot());
ipcMain.handle('update:check', () => updater.check(true));
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:cancel', () => updater.cancel());
ipcMain.handle('update:later', () => { updater.later(); return true; });
ipcMain.handle('update:source', (_e, v) => updater.setSource(v === null ? null : String(v)));
ipcMain.handle('update:restart', async (_e, now) => {
  // (the update program must be allowed to run here before anything closes; a second click while
  // that is checked gets the same answer and closes nothing twice)
  const pf = await updater.preflight(updater.kind());
  if (!pf.ok || pf.again) return pf.ok;
  if (!updater.choose(!!now)) return false;
  if (now) closeForRestart();
  return true;
});
ipcMain.handle('update:rollback', async () => {
  if (!updater.chooseRollback(true)) return false; // (nothing to go back to)
  const pf = await updater.preflight('rollback');
  if (!pf.ok) return 'blocked';
  if (pf.again) return true; // (the first click goes on)
  if (!updater.chooseRollback()) return false;
  closeForRestart();
  return true;
});
ipcMain.handle('update:afterStart', () => updater.afterStart());

// ---------------------------------------------------------------- crash + problem reports
reports = require('./reports.cjs').create({
  version: VERSION, readSettings, writeSettings, log, appName: APP,
  logFile: () => path.join(dataDir(), 'logs', 'app.log'),
  source: () => updater.snapshot().source,
  send: broadcast,
  // (the public build's anonymous report receiver - none in the company build)
  endpoint: String(process.env.PDFED_REPORT_ENDPOINT || require('../package.json').reportEndpoint || ''),
});
let reportShot = null; // the window as it was when "Report a problem" was opened
ipcMain.handle('report:capture', async (_e) => {
  const win = winOf(_e);
  if (!win || win.isDestroyed()) return null;
  const img = await win.webContents.capturePage();
  reportShot = img.toPNG();
  return img.resize({ width: 520 }).toDataURL();
});
ipcMain.handle('report:problem', async (_e, text, withShot, extra) => {
  const r = await reports.problem(text, withShot ? reportShot : null, extra && typeof extra === 'object' ? extra : {});
  reportShot = null;
  return r;
});
ipcMain.handle('report:status', () => reports.status());
ipcMain.handle('report:crashSharing', (_e, on) => reports.crashSharing(!!on));
ipcMain.handle('report:preview', () => reports.preview());
ipcMain.handle('report:openQueue', async () => {
  const st = await reports.status();
  await fsp.mkdir(st.queue, { recursive: true });
  return shell.openPath(st.queue);
});
ipcMain.on('report:crash', (_e, where, message, stack) => reports.crash(String(where || 'window'), { message: String(message || ''), stack: String(stack || '') }));
app.on('child-process-gone', (_e, d) => {
  if (quitting || ['clean-exit', 'killed'].includes(d.reason)) return;
  // (an engine that ends itself on purpose to start again fresh - code 75, after its memory grew
  // past its limit - is no crash: each was filed as one, using up the day's reports)
  if (d.exitCode === 75 || d.exitCode === 75 * 256) return;
  reports.crash('process ' + d.type + (d.name ? ' ' + d.name : ''), { message: d.reason + ' (exit ' + d.exitCode + ')' });
});
ipcMain.on('app:closeCancelled', (e) => {
  const W = W_of(e);
  if (W) W.closeAskedAt = 0;
  const wasRestart = restarting;
  restarting = false;
  updater.closeCancelled();
  // a restart cancelled at a "Save changes?" question: the windows that had already closed for it
  // come back here, and nothing is left to reopen at some later start
  if (wasRestart) {
    const cur = readSettings();
    const list = Array.isArray(cur.reopenAfterRestart) ? cur.reopenAfterRestart : [];
    if (list.length) { try { writeSettings({ ...cur, reopenAfterRestart: null }); } catch (err) { log('restart cancelled: ' + err); } reopenIn(live(W) ? W : mainW(), list); }
  }
});
app.on('will-quit', () => { updater.stop(); updater.applyAtQuit(); });

ipcMain.on('app:closed', (e) => {
  const W = W_of(e);
  if (!live(W)) return;
  W.allowClose = true;
  W.win.close();
});
ipcMain.on('log', (_e, line) => log('renderer: ' + line));

// files from a second start (Explorer: several PDFs opened at once) arriving while the page is
// still loading wait until it listens (app:ready), or they were dropped
ipcMain.on('app:ready', (e) => {
  const W = W_of(e);
  if (!live(W)) return;
  W.ready = true;
  if (pendingOpen.length) W.win.webContents.send('app:open', pendingOpen.splice(0));
  for (const a of W.adopt.splice(0)) W.win.webContents.send('app:adopt', a);
  if (combine.files.length) combineSoon();
});
/** the Merge dialog opens once no more files came for a moment (Explorer starts them all at once;
 *  a slow PC: up to 15 s after the first) - in name order, as Explorer lists them. Files that come
 *  after that join the open Merge dialog. */
function combineSoon() {
  if (combine.timer) clearTimeout(combine.timer);
  if (!combine.first) combine.first = Date.now();
  // (at least 200 ms - a window still loading after 15 s is asked again 5 times a second, not
  // in a tight loop)
  const wait = Math.max(200, Math.min(1500, 15000 - (Date.now() - combine.first)));
  combine.timer = setTimeout(() => {
    combine.timer = null;
    const W = mainW();
    if (!W || !W.ready) { combineSoon(); return; }
    // (one file alone opens as a tab: a moment longer first - the rest of a selection on a slow PC)
    if (new Set(combine.files).size === 1 && Date.now() - combine.first < 4000) { combineSoon(); return; }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const files = [...new Set(combine.files.splice(0))].sort((a, b) => coll.compare(path.basename(a), path.basename(b)) || coll.compare(a, b));
    combine.first = 0;
    if (!files.length) return;
    log(`combine: ${files.length} file${files.length === 1 ? '' : 's'} to the window`);
    if (W.win.isMinimized()) W.win.restore();
    W.win.focus();
    W.win.webContents.send('app:combine', files);
    // (the next selection starts the app - or knocks - again)
    fsp.rm(combineLock(), { force: true }).catch(() => {});
  }, wait);
}
/** the spool: looked at every 1.5 s, 6 times a second while a selection is arriving */
const spool = { busy: false, fastUntil: 0, timer: null };
async function takeSpool() {
  // (taken only by a copy with its window up and shown, not closing: a copy still starting can be
  // closed by another start's knock - Chromium takes it for hung while it has no window - and one
  // closing has no window to show them in; the files wait in the spool for the copy that stays)
  const W = mainW();
  if (spool.busy || quitting || !W || !W.ready || !W.win.isVisible()) return;
  spool.busy = true;
  let got = [];
  try {
    let names;
    try { names = await fsp.readdir(combineDir()); } catch (_) { return; }
    const now = Date.now();
    for (const n of names) {
      const f = path.join(combineDir(), n);
      if (n.endsWith('.path')) {
        let txt;
        let st;
        try { st = await fsp.stat(f); txt = await fsp.readFile(f, 'utf8'); await fsp.unlink(f); } catch (_) { continue; }
        // (left from a start that never came up: not mixed into a later selection)
        if (now - st.mtimeMs > 60000) { log('combine: old entry dropped: ' + txt); continue; }
        const p = path.resolve(txt.trim());
        if (/\.pdf$/i.test(p)) got.push({ p, t: st.mtimeMs });
      } else if (n.endsWith('.tmp')) {
        try { if (now - (await fsp.stat(f)).mtimeMs > 60000) await fsp.unlink(f); } catch (_) { /* gone */ }
      } else if (n === 'launch.lock' && !combine.files.length && !combine.timer) {
        // (a start that came to nothing: the next selection starts the app - or knocks - again)
        try { if (now - (await fsp.stat(f)).mtimeMs > 30000) await fsp.rm(f, { force: true }); } catch (_) { /* gone */ }
      }
    }
  } finally { spool.busy = false; }
  // one selection arrives within seconds: entries from before a pause of 10 s or more are an
  // earlier selection whose start never came up - not mixed in
  got.sort((a, b) => a.t - b.t);
  for (let i = got.length - 1; i > 0; i--) {
    if (got[i].t - got[i - 1].t >= 10000) { for (const g of got.slice(0, i)) log('combine: earlier selection dropped: ' + g.p); got = got.slice(i); break; }
  }
  got = got.map((g) => g.p);
  if (!got.length) return;
  // (checked without holding up the window: the files are often on a share)
  const ok = (await Promise.all(got.map((f) => fsp.access(f).then(() => f, () => { log('combine: not found: ' + f); return ''; })))).filter(Boolean);
  if (!ok.length) return;
  log(`combine: ${ok.length} from the spool`);
  noteChosen(ok);
  combine.files.push(...ok);
  spool.fastUntil = Date.now() + 4000;
  combineSoon();
}
function watchSpool(fast) {
  if (fast) spool.fastUntil = Math.max(spool.fastUntil, Date.now() + fast);
  if (spool.timer) clearTimeout(spool.timer);
  if (quitting) return;
  spool.timer = setTimeout(async () => {
    spool.timer = null;
    try { await takeSpool(); } catch (e) { log('combine: ' + e); }
    watchSpool(0);
  }, Date.now() < spool.fastUntil ? 150 : 1500);
}
app.on('second-instance', (_e, argv, _cwd, extra) => {
  const files = (extra && extra.files) || pdfArgs(argv);
  noteChosen(files);
  let W = mainW();
  if ((extra && extra.combine) || isCombine(argv)) {
    if (W) { if (W.win.isMinimized()) W.win.restore(); W.win.focus(); }
    if (files.length) { combine.files.push(...files); combineSoon(); }
    watchSpool(6000);
    return;
  }
  // a file open in some window already: that window comes forward and shows it
  const owner = (f) => byUse().find((x) => x.ready && x.paths.has(f.toLowerCase()));
  for (const f of files) { const o = owner(f); if (o) { o.win.webContents.send('app:open', [f]); W = o; } }
  const rest = files.filter((f) => !owner(f));
  if (W) {
    if (W.win.isMinimized()) W.win.restore();
    W.win.focus();
  }
  if (!rest.length) return;
  W = mainW();
  if (W && W.ready) W.win.webContents.send('app:open', rest);
  else pendingOpen.push(...rest);
});

if (process.platform === 'win32') app.setAppUserModelId('pdfeditor.app');

/** 0.5.0 and earlier kept these in the roaming folder: moved over. A roaming folder kept on a server
 *  (or another drive) can't be renamed across - there each entry is copied, then removed (in the
 *  background; whatever didn't move is tried again at the next start - also once the new folder
 *  exists, which it does as soon as anything was saved) */
async function moveFromRoaming() {
  if (localDir() === dataDir()) return;
  for (const d of ['recovery', 'backups', path.join('cache', 'previews')]) {
    const from = path.join(dataDir(), d), to = path.join(localDir(), d);
    try {
      if (!fs.existsSync(from)) continue;
      await fsp.mkdir(path.dirname(to), { recursive: true });
      if (!fs.existsSync(to)) { try { await fsp.rename(from, to); continue; } catch (e) { if (e.code !== 'EXDEV') throw e; } }
      await fsp.mkdir(to, { recursive: true });
      for (const n of await fsp.readdir(from)) {
        const a = path.join(from, n), b = path.join(to, n);
        // (under a working name first: a copy cut short is never taken for the whole thing)
        if (!fs.existsSync(b)) { await fsp.cp(a, b + '.moving', { recursive: true, force: true, preserveTimestamps: true }); await fsp.rename(b + '.moving', b); }
        await fsp.rm(a, { recursive: true, force: true });
      }
      await fsp.rmdir(from).catch(() => {});
    } catch (e) { log('move ' + d + ': ' + e.message); }
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  void cleanDragDir();
  // engine temp files of earlier sessions (one app instance at a time)
  fsp.rm(workDir(), { recursive: true, force: true }).catch(() => {});
  void moveFromRoaming().then(cleanRecovery);
  // (the preview cache is listed once the start and the first files opened have settled)
  setTimeout(() => void listCache(), Number(process.env.PDFED_CACHE_LIST_MS || 20000));
  cleanOld();
  const root = path.join(__dirname, '..', 'dist');
  protocol.handle('app', (req) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html'; } catch (_) { return new Response('bad address', { status: 400 }); }
    const f = path.normalize(path.join(root, rel));
    // (inside dist only - a folder beside it whose name starts with "dist" is not)
    if (!f.startsWith(root + path.sep)) return new Response('no', { status: 403 });
    return net.fetch(pathToFileURL(f).href);
  });
  createWindow();
  // Explorer's Combine: the files of a selection, in the spool (also any a start that never came up
  // left there - those older than 3 minutes are dropped)
  if (isCombine(process.argv)) log('combine: started for a selection');
  watchSpool(isCombine(process.argv) ? 10000 : 0);
  updater.start();
  reports.scheduleFlush(Number(process.env.PDFED_REPORT_FIRST) || 30000);
  setInterval(() => reports.scheduleFlush(1000), 30 * 60 * 1000);
  setTimeout(() => { void refreshRegistration().catch((e) => log('registration: ' + e)); }, 4000);
});
app.on('window-all-closed', () => app.quit());
