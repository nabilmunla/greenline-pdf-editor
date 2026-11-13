// Updates for installed copies (made by PDF Editor Setup: install.json next to the exe).
//
// Where: the updates folder - update.json written by the setup (the company share it was run
// from), or the person's own choice in Settings. Someone publishes a new version by copying
// latest.json + the package there; nothing is ever written to that folder from here. A build can
// also name a web address (package.json "updateFeed", e.g. its GitHub repository - feed.cjs): used
// when neither of those says otherwise.
//
// How: the folder is read by update-worker.cjs in a process of its own with a time limit, so a
// PC away from the company network (home, server off, VPN down) just gets "not reachable" - no
// waiting, no errors, no popups. A new version is announced and only downloaded when the person
// says so; the copy is checked (SHA-256) before anything uses it; the installed files are swapped
// by the setup helper after the app has closed (the old app part is kept for going back).
'use strict';
const { app, utilityProcess, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { verifyLatest } = require('./updsig.cjs');
const feed = require('./feed.cjs');

const CHECK_TIMEOUT = Number(process.env.PDFED_UPDATE_TIMEOUT) || 15000;
const STALL_TIMEOUT = Number(process.env.PDFED_UPDATE_STALL) || 60000;
const EVERY = 4 * 3600 * 1000;
const FIRST = Number(process.env.PDFED_UPDATE_FIRST) || 20000;

function create({ version, readSettings, writeSettings, log, send, appName, defaultSource = '', build = 'company' }) {
  const installDir = () => process.env.PDFED_INSTALL_DIR || path.dirname(process.execPath);
  const workDir = () => path.join(process.env.LOCALAPPDATA || app.getPath('userData'), process.env.LOCALAPPDATA ? appName : '', 'updates');
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } };
  const install = () => readJson(path.join(installDir(), 'install.json'));
  const setupSource = () => { const u = readJson(path.join(installDir(), 'update.json')); return (u && typeof u.source === 'string' && u.source.trim()) || ''; };
  // (the setup's update.json with an empty source: "no updates" was chosen there - the build's own
  // address is used only when the setup said nothing)
  const setupSaid = () => { const u = readJson(path.join(installDir(), 'update.json')); return !!(u && typeof u.source === 'string'); };
  const source = () => { const s = readSettings(); return typeof s.updateSource === 'string' ? s.updateSource.trim() : setupSaid() ? setupSource() : defaultSource; };
  const previous = () => { const p = readJson(path.join(installDir(), 'resources', 'app.old', 'package.json')); return (p && p.version) || ''; };
  const runtime = process.versions.electron;
  // Linux (Greenline): the whole program is one package - an AppImage (one file, swapped for the
  // new one by the app itself: a running AppImage keeps going from the old file) or a .deb (handed
  // to the system's package installer, which asks for the password). install.json inside the
  // package says which; the AppImage also needs $APPIMAGE (set by its runtime) - started any other
  // way it is a copy that doesn't update itself.
  const linuxKind = () => {
    const k = (install() || {}).linux;
    if (k === 'appimage') return process.env.APPIMAGE ? 'appimage' : '';
    return k === 'deb' ? 'deb' : '';
  };
  const linuxInstalled = () => { const k = (install() || {}).linux; return !k || !!linuxKind(); };

  /** what the window shows: idle | checking | none | available | downloading | ready | error | off | unreachable | empty | portable
   *  | blocked (the update program can't run here) | setup (this version installs only with its setup, by hand) */
  let st = { state: 'idle' };
  let latest = null; // the announced version: { version, notes, kind, pkg }
  let worker = null;
  let laterFor = ''; // "Later" hides this version until the next start
  let pending = null; // { relaunch } once the person chose to restart / update at exit
  let timer = null;
  let unfinished = ''; // an update tried at the last close that didn't land (this start found the old version)

  function set(patch) {
    st = { ...st, ...patch };
    send('update:state', snapshot());
  }
  function snapshot() {
    const ii = install();
    const s = readSettings();
    return {
      ...st,
      version,
      installed: !!ii && linuxInstalled(),
      linux: linuxKind(),
      pkgFile: latest && latest.pkg ? latest.pkg.file : '',
      scope: ii ? ii.scope || 'user' : '',
      dir: installDir(),
      source: source(),
      web: feed.isWeb(source()),
      setupSource: setupSource(),
      defaultSource,
      ownSource: typeof s.updateSource === 'string',
      checked: s.updateChecked || 0,
      previous: ii ? previous() : '',
      pendingAtExit: !!pending,
    };
  }

  /** grouped notes from latest.json ({"New features": [...], ...}): plain text only, kept short */
  function noteGroups(g) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
    const out = {};
    for (const [k, v] of Object.entries(g).slice(0, 6)) if (Array.isArray(v) && v.length) out[String(k).slice(0, 40)] = v.slice(0, 10).map((x) => String(x).slice(0, 200));
    return Object.keys(out).length ? out : null;
  }
  /**
   * The notes of every version after this copy up to the announced one - latest.json's "history"
   * (from 0.9.7: the last versions' notes, signed with the rest), merged by group, newest first,
   * "Coming next" from the newest only, a line repeated once. Someone who skipped updates (0.9.4
   * straight to 0.9.6) was shown only the newest version's notes: 0.9.5's fixes never appeared.
   */
  function groupsSince(j) {
    const own = noteGroups(j.groups);
    const h = j.history;
    if (!h || typeof h !== 'object' || Array.isArray(h)) return own;
    const vs = Object.keys(h).filter((v) => /^\d+(\.\d+){1,3}$/.test(v) && newer(v, version) && !newer(v, j.version)).sort((a, b) => (newer(a, b) ? -1 : 1));
    if (vs.length <= 1) return own;
    const out = {};
    vs.forEach((v, i) => {
      for (const [k, xs] of Object.entries(noteGroups(h[v]) || {})) {
        if (i > 0 && /^coming next/i.test(k)) continue;
        const a = out[k] || (out[k] = []);
        for (const x of xs) if (!a.includes(x) && a.length < 30) a.push(x);
      }
    });
    return Object.keys(out).length ? out : own;
  }
  const vparts = (v) => String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
  function newer(a, b) { // a > b
    const x = vparts(a), y = vparts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
    return false;
  }

  /** run update-worker.cjs; resolves with its last message (or a timeout) */
  function runWorker(args, { timeout, onMessage } = {}) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = utilityProcess.fork(path.join(__dirname, 'update-worker.cjs'), args, { serviceName: appName + ' updates', stdio: 'ignore' });
      } catch (e) { resolve({ ok: false, reach: 'unreachable', err: String(e.message || e) }); return; }
      worker = proc;
      let result = null, done = false;
      let t = null;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (worker === proc) worker = null;
        try { proc.kill(); } catch (_) { /* gone */ }
        resolve(r);
      };
      const arm = () => { clearTimeout(t); t = setTimeout(() => finish({ ok: false, reach: 'unreachable', err: 'timeout' }), timeout); };
      arm();
      proc.on('message', (m) => {
        if (onMessage && m && m.progress !== undefined) { arm(); onMessage(m); return; }
        result = m;
        if (m && (m.ok !== undefined || m.done)) finish(m);
      });
      proc.on('exit', () => finish(result || { ok: false, reach: 'unreachable', err: 'stopped' }));
    });
  }

  function validate(j) {
    if (!j || typeof j !== 'object' || typeof j.version !== 'string' || !/^\d+(\.\d+){1,3}$/.test(j.version)) return 'latest.json has no valid version';
    const okPkg = (p) => p && typeof p.file === 'string' && /^[0-9a-f]{64}$/i.test(String(p.sha256 || '')) && Number(p.size) > 0;
    if (!okPkg(j.app) && !okPkg(j.setup)) return 'latest.json lists no complete package';
    return '';
  }

  /** an offer the card shows (to be kept when a check brings nothing usable) */
  const offered = (s) => ['ready', 'blocked', 'available', 'setup'].includes(s.state);
  async function check(manual) {
    const ii = install() && linuxInstalled();
    if (!ii) { set({ state: 'portable', err: '' }); return snapshot(); }
    const src = source();
    if (!src) { set({ state: 'off', err: '' }); return snapshot(); }
    if (['checking', 'downloading'].includes(st.state)) return snapshot();
    // (ready, or ready but its update program blocked: kept until a check asked for by hand)
    if ((st.state === 'ready' || st.state === 'blocked') && !manual) return snapshot();
    const before = st;
    set({ state: 'checking', err: '' });
    // (whatever goes wrong in there, the state never stays on "checking" - every later check
    // would wait for it to end)
    try { return await checkNow(manual, src, before); } catch (e) {
      log('update check failed: ' + (e && e.stack ? e.stack : e));
      if (st.state === 'checking') set(offered(before) ? { ...before } : { state: 'error', err: String((e && e.message) || e) });
      return snapshot();
    }
  }
  async function checkNow(manual, src, before) {
    const r = await runWorker(['check', src], { timeout: CHECK_TIMEOUT });
    // (only the time of the check: a settings file held by an antivirus doesn't stop it)
    try { writeSettings({ ...readSettings(), updateChecked: Date.now() }); } catch (e) { log('update: ' + e); }
    if (!r.ok) {
      log('update check: ' + (r.reach || '') + ' ' + (r.err || ''));
      if (before.state === 'ready' || before.state === 'blocked' || before.state === 'setup') { set({ ...before }); return snapshot(); }
      set({ state: r.reach === 'empty' ? 'empty' : r.reach === 'bad' ? 'error' : 'unreachable', err: r.err || '' });
      return snapshot();
    }
    // an answer that can't be used (latest.json being copied, or the package not there yet): an
    // update already offered or downloaded stays as it was - not "You have the newest version"
    const unusable = (why, patch) => { log('update check: ' + why); set(offered(before) ? { ...before } : patch); return snapshot(); };
    // only what the publisher signed (electron/updsig.cjs): a latest.json changed on the share -
    // its checksums swapped for another program's - is refused, not installed
    const sig = verifyLatest(r.latest);
    if (!sig.latest) return unusable('update refused: ' + sig.err, { state: 'error', err: sig.err + ' - not installed. Tell whoever looks after the updates folder.' });
    const j = sig.latest;
    for (const k of ['app', 'setup']) if (j[k] && r.latest.signedPresent && typeof r.latest.signedPresent[k] === 'boolean') j[k].present = r.latest.signedPresent[k];
    const bad = validate(j);
    if (bad) return unusable(bad, { state: 'error', err: bad });
    // (the other edition's release - the public build's in the company folder, say: same key, not ours)
    if (j.build && j.build !== build) return unusable('update refused: a release of another edition (' + j.build + ')', { state: 'error', err: 'The update in that place is for another edition of the app - not installed.' });
    if (!newer(j.version, version)) { latest = null; set({ state: 'none', err: '', available: '' }); return snapshot(); }
    const lk = linuxKind();
    // (Linux: the package for this kind of copy, whatever the runtime - it carries its own)
    const pkg = lk ? j.linux && j.linux[lk] : j.app;
    if (lk && !(pkg && typeof pkg.file === 'string' && /^[0-9a-f]{64}$/i.test(String(pkg.sha256 || '')) && Number(pkg.size) > 0)) return unusable('no Linux package (' + lk + ') in this release', { state: before.state === 'idle' ? 'idle' : 'none', err: '' });
    // a new runtime (Electron) comes with the whole setup; otherwise just the app part
    const full = !lk && (!!(j.runtime && j.runtime !== runtime) || !j.app);
    // A new runtime needs the whole setup - and that is never started by the app: a program just
    // copied into AppData and started by another program is what malware droppers do, and the
    // company antivirus (Sophos) stopped the 0.8.2 update for "malicious behaviour" right there (the
    // test start of the downloaded setup). The card says to run the setup by hand. (From 0.8.3 on
    // latest.json names no setup at all: copies up to 0.8.2 would fetch and start it - they now find
    // no package for a new runtime and say nothing.)
    if (full) {
      const l = { version: j.version, notes: Array.isArray(j.notes) ? j.notes.map(String).slice(0, 12) : [], groups: groupsSince(j), kind: 'full', setupFile: j.setup && typeof j.setup.file === 'string' ? path.basename(j.setup.file) : '', pkg: { file: '', sha256: '', size: Number((j.setup && j.setup.size) || 0) } };
      latest = l;
      const skippedFull = readSettings().skipUpdate === l.version;
      const showFull = manual || (laterFor !== l.version && !skippedFull);
      const setupPath = await setupFor();
      // (another updates folder chosen meanwhile: that check's answer counts, not this one)
      if (latest !== l) return snapshot();
      set({ state: 'setup', available: l.version, notes: l.notes, groups: l.groups, kind: 'full', size: l.pkg.size, pct: 0, err: '', show: showFull, setupPath });
      return snapshot();
    }
    if (!pkg || !/^[0-9a-f]{64}$/i.test(String(pkg.sha256 || ''))) return unusable('no package for this update', { state: 'error', err: 'latest.json lists no package for this update' });
    if (pkg.present === false) return unusable('package not in the folder yet', { state: before.state === 'idle' ? 'idle' : 'none', err: '' });
    latest = { version: j.version, notes: Array.isArray(j.notes) ? j.notes.map(String).slice(0, 12) : [], groups: groupsSince(j), kind: lk || 'app', setupFile: j.setup && typeof j.setup.file === 'string' ? path.basename(j.setup.file) : '', pkg: { file: path.basename(String(pkg.file)), sha256: String(pkg.sha256).toLowerCase(), size: Number(pkg.size) } };
    // going back from a version means "not that one": it isn't offered by itself again (also when
    // its package is still here from before)
    const skipped = readSettings().skipUpdate === latest.version;
    const show = manual || (laterFor !== latest.version && !skipped);
    // already downloaded earlier (and still intact)?
    const local = localFile(latest);
    if (fs.existsSync(local) && (await sha256(local)) === latest.pkg.sha256) {
      set({ state: 'ready', available: latest.version, notes: latest.notes, groups: latest.groups, kind: latest.kind, size: latest.pkg.size, err: '', show });
      await markUnfinished();
      return snapshot();
    }
    set({ state: 'available', available: latest.version, notes: latest.notes, groups: latest.groups, kind: latest.kind, size: latest.pkg.size, err: '', show });
    return snapshot();
  }

  const localFile = (l) => path.join(workDir(), l.pkg.file);
  function sha256(p) {
    return new Promise((resolve) => {
      const h = require('crypto').createHash('sha256');
      fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', () => resolve(''));
    });
  }
  async function download() {
    if (!latest || st.state === 'downloading') return snapshot();
    // (a whole setup is not fetched to be started from here - see checkNow)
    if (latest.kind === 'full') return snapshot();
    // (the updates folder can be changed while this runs: the copy stays about this version)
    const l = latest;
    const web = feed.isWeb(source());
    const src = web ? feed.fileUrl(source(), l.version, l.pkg.file) : path.join(source(), l.pkg.file);
    const dst = localFile(l);
    const part = dst + '.part';
    cancelled = false;
    set({ state: 'downloading', pct: 0, err: '', show: true });
    // (whatever goes wrong in here, the card never stays on "Getting..." with a Cancel that does nothing)
    try {
      await fsp.mkdir(workDir(), { recursive: true });
      await fsp.rm(part, { force: true });
      const r = await runWorker(['copy', src, part, String(l.pkg.size)], {
        timeout: STALL_TIMEOUT,
        onMessage: (m) => { if (latest === l && st.state === 'downloading') set({ pct: l.pkg.size ? Math.min(1, m.progress / l.pkg.size) : 0 }); },
      });
      if (latest !== l) {
        // another updates folder was chosen meanwhile: this copy isn't wanted any more
        cancelled = false;
        await fsp.rm(part, { force: true }).catch(() => {});
        return snapshot();
      }
      if (!r.done && cancelled) {
        cancelled = false;
        await fsp.rm(part, { force: true }).catch(() => {});
        set({ state: 'available', pct: 0, err: '', show: false });
        return snapshot();
      }
      if (!r.done) {
        await fsp.rm(part, { force: true }).catch(() => {});
        log('update download failed: ' + (r.err || ''));
        const why = web
          ? { timeout: 'The download stopped (no answer from the server).', ENOENT: "The update file isn't on the download page (any more).", ENOSPC: 'This PC\'s disk is full.' }[r.err]
          : { timeout: 'The updates folder stopped responding.', ENOENT: "The update file isn't in the updates folder (any more).", EACCES: 'No permission to read the updates folder.', EPERM: 'No permission to read the updates folder.', ENOSPC: 'This PC\'s disk is full.', EBUSY: 'The update file is in use on the server.' }[r.err];
        set({ state: 'error', err: why || 'Could not ' + (web ? 'download' : 'copy') + ' the update (' + (r.err || 'unknown') + ').', show: true });
        return snapshot();
      }
      if (String(r.sha).toLowerCase() !== l.pkg.sha256) {
        await fsp.rm(part, { force: true }).catch(() => {});
        log('update download: checksum mismatch');
        set({ state: 'error', err: 'The downloaded update is damaged (checksum mismatch). Nothing was changed.', show: true });
        return snapshot();
      }
      await fsp.rm(dst, { force: true }).catch(() => {});
      // (an antivirus looks at a new program file first and holds it for a moment: tried again)
      for (let k = 0; ; k++) {
        try { await fsp.rename(part, dst); break; } catch (e) {
          if (k >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
          await new Promise((res) => setTimeout(res, 200 * 2 ** k));
        }
      }
      try { writeSettings({ ...readSettings(), updateNotes: { version: l.version, notes: l.notes, groups: l.groups } }); } catch (e) { log('update: ' + e); }
      set({ state: 'ready', pct: 1, err: '', show: true });
      return snapshot();
    } catch (e) {
      log('update download: ' + (e && e.stack ? e.stack : e));
      await fsp.rm(part, { force: true }).catch(() => {});
      if (latest === l) set({ state: 'error', err: 'Could not finish the download (' + ((e && (e.code || e.message)) || e) + ').', show: true });
      return snapshot();
    }
  }

  let cancelled = false;
  function cancel() {
    if (worker && st.state === 'downloading') cancelled = true;
    if (worker) { try { worker.kill(); } catch (_) { /* gone */ } }
    return snapshot();
  }

  /** the person chose: restart now (relaunch) or update when the app closes */
  function choose(relaunch) {
    if (!['ready', 'blocked'].includes(st.state) || !latest || latest.kind === 'full') return false;
    pending = { kind: latest.kind, file: localFile(latest), sha: latest.pkg.sha256, version: latest.version, relaunch: !!relaunch };
    set({ show: false });
    return true;
  }
  function chooseRollback(onlyAsk) {
    if (!previous()) return false;
    if (onlyAsk) return true;
    pending = { kind: 'rollback', relaunch: true, skip: version };
    return true;
  }
  /** the close was cancelled (unsaved work): a "Restart now" is dropped (the card comes back);
   *  an earlier "When I close it" stays */
  function closeCancelled() {
    if (pending && pending.relaunch) {
      const wasUpdate = pending.kind !== 'rollback';
      pending = null;
      if (wasUpdate && (st.state === 'ready' || st.state === 'blocked')) { set({ show: true }); return; }
    }
    send('update:state', snapshot());
  }
  function later() {
    if (latest) laterFor = latest.version;
    set({ show: false });
  }

  const helperPath = () => process.env.PDFED_UPDATE_HELPER || path.join(installDir(), 'PDF Editor Setup.exe');
  /**
   * Can the program that does the update run on this PC? Started harmlessly before the app closes,
   * as "--worker <a job file that isn't there>": the first thing every setup version checks - it
   * reads no job, does nothing and exits 2 (the helper and a whole setup alike; no window).
   * Blocked (antivirus, Windows policy) -> the card says so and names the setup to run instead;
   * the app stays open.
   */
  function probe() {
    // (only ever the helper installed with the app - never a downloaded program: see checkNow)
    const exe = helperPath();
    const args = ['--worker', path.join(require('os').tmpdir(), 'pdfed-probe-' + process.pid + '-' + Date.now() + '.json')];
    const limit = Number(process.env.PDFED_UPDATE_PROBE || 0) || 20000;
    return new Promise((resolve) => {
      let done = false, child;
      const fin = (ok, why) => { if (done) return; done = true; clearTimeout(t); try { child && child.kill(); } catch (_) { /* gone */ } resolve({ ok, why }); };
      const t = setTimeout(() => fin(false, 'no answer in ' + Math.round(limit / 1000) + ' s'), limit);
      try { child = spawn(exe, args, { stdio: 'ignore', windowsHide: true }); } catch (e) { fin(false, String(e.message || e)); return; }
      child.on('error', (e) => fin(false, String(e.message || e)));
      child.on('exit', (code, sig) => fin(code === 0 || code === 2, sig ? 'stopped (' + sig + ')' : 'exit ' + code));
    });
  }
  /** before "Restart now" / "When I close it" / "Go back": the update program is allowed to run.
   *  { ok, again }: again = a second click while the first one is being checked - it gets the same
   *  answer, and the caller closes nothing a second time */
  let probing = null;
  async function preflight(kind) {
    if (probing) return { ok: await probing, again: true };
    probing = preflightNow(kind);
    try { return { ok: await probing, again: false }; } finally { probing = null; }
  }
  async function preflightNow(kind) {
    // (never a downloaded setup: see checkNow)
    if (kind === 'full') return false;
    // (Linux: no update program - the AppImage's own folder must take the new file; the .deb goes
    // to the system installer)
    if (kind === 'appimage' || kind === 'deb') {
      if (kind === 'deb') return true;
      try { await fsp.access(path.dirname(process.env.APPIMAGE), fs.constants.W_OK); return true; } catch (e) {
        log('update: the AppImage folder is read-only (' + (e.code || e) + '): ' + process.env.APPIMAGE);
        set({ state: 'blocked', err: 'readonly', setupPath: await setupFor(), show: true });
        return false;
      }
    }
    if (kind === 'rollback' && linuxKind()) return false;
    const r = await probe();
    if (r.ok) {
      // (allowed again - after IT's exception, "Try again"): ready as before
      if (kind !== 'rollback' && st.state === 'blocked') set({ state: 'ready', err: '' });
      return true;
    }
    log('update: the update program could not run (' + r.why + '): ' + helperPath());
    if (kind === 'rollback') return false; // the caller says so; the update card stays as it was
    set({ state: 'blocked', err: r.why, setupPath: await setupFor(), show: true });
    return false;
  }
  /**
   * The setup next to the package (named in latest.json); not there -> its folder. Looked at
   * without holding up the app (the updates folder can be a share that doesn't answer).
   */
  async function setupFor() {
    const src = source();
    if (!latest || !src) return '';
    // (from the web: the page the setup is downloaded from)
    if (feed.isWeb(src)) return feed.releasePage(src, latest.version);
    const f = path.join(src, latest.setupFile || 'PDF Editor Setup ' + latest.version + '.exe');
    const there = await Promise.race([fsp.access(f).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 3000))]);
    return there ? f : src;
  }
  /** an update tried at the last close that didn't land: the card says so (once) */
  async function markUnfinished() {
    if (!unfinished || !latest || unfinished !== latest.version || st.state !== 'ready') return;
    unfinished = '';
    set({ state: 'blocked', err: 'unfinished', setupPath: await setupFor(), show: true });
  }

  /** at quit: hand over to the setup helper (it waits for this process to end) */
  function applyAtQuit() {
    if (!pending) return false;
    const dir = installDir();
    const p = pending;
    pending = null;
    try {
      // (a whole setup is never started from here: see checkNow)
      if (p.kind === 'full') throw new Error('a new runtime installs only with its setup, run by hand');
      if (p.kind === 'appimage' || p.kind === 'deb') return applyLinux(p);
      // the helper in the app folder itself (0.5.0 ran a copy of it from AppData - company
      // antivirus blocks programs started from there; the app folder is where programs live)
      const exe = helperPath();
      const args = p.kind === 'rollback'
        ? ['--rollback', '--dir', dir, '--wait', String(process.pid)]
        : ['--apply', p.file, '--sha256', p.sha, '--version', p.version, '--dir', dir, '--wait', String(process.pid)];
      if (p.relaunch) args.push('--relaunch');
      // (a settings file held by the antivirus must not stop going back either)
      if (p.skip) { try { writeSettings({ ...readSettings(), skipUpdate: p.skip }); } catch (e) { log('update: ' + e); } }
      // checked at the next start: still this version -> the update didn't finish (blocked partway)
      // (a settings file held by the antivirus must not stop the update itself)
      if (p.kind !== 'rollback') { try { writeSettings({ ...readSettings(), updateTry: { from: version, to: p.version, at: Date.now() } }); } catch (e) { log('update: ' + e); } }
      log('update: starting ' + exe + ' ' + args.join(' '));
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (e) => log('update helper: ' + e));
      child.unref();
      return true;
    } catch (e) {
      log('update: could not start the helper: ' + (e.stack || e));
      // ("Restart now" must at least start the app again - the update stays offered)
      if (p.relaunch) { try { app.relaunch(); } catch (_) { /* */ } }
      return false;
    }
  }

  /**
   * Linux, at quit. AppImage: the new file next to the running one, checked again, made runnable
   * and renamed over it (the running copy goes on from the old file until it ends), then started
   * if asked. .deb: handed to the system's package installer (it asks for the password); the app
   * is opened again from the menu after that.
   */
  function applyLinux(p) {
    try { writeSettings({ ...readSettings(), updateTry: { from: version, to: p.version, at: Date.now() } }); } catch (e) { log('update: ' + e); }
    if (p.kind === 'deb') {
      log('update: opening the package installer for ' + p.file);
      const child = spawn('xdg-open', [p.file], { detached: true, stdio: 'ignore' });
      child.on('error', (e) => log('update: xdg-open: ' + e));
      child.unref();
      return true;
    }
    const target = process.env.APPIMAGE;
    const tmp = path.join(path.dirname(target), '.' + path.basename(target) + '.new');
    try {
      fs.copyFileSync(p.file, tmp);
      // (read in pieces: the AppImage is over 100 MB)
      const hh = require('crypto').createHash('sha256'), fd = fs.openSync(tmp, 'r'), buf = Buffer.alloc(1 << 20);
      try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hh.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
      const h = hh.digest('hex');
      if (h !== p.sha) throw new Error('the copy next to the app does not match its checksum');
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, target);
      log('update: ' + target + ' is now ' + p.version);
    } catch (e) {
      log('update: could not replace the AppImage: ' + (e.stack || e));
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* */ }
    }
    // (the AppImage at its usual place - the new one, or the old one if that failed: the card says so)
    if (p.relaunch) {
      // (started once this process has ended - it holds the one-copy lock, and a new copy started
      // before would hand its start over to it and close)
      const env = { ...process.env };
      for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[k];
      const child = spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$0"', target, String(process.pid)], { detached: true, stdio: 'ignore', env });
      child.on('error', (e) => log('update: restart: ' + e));
      child.unref();
    }
    return true;
  }

  /** after an update: the notes once; old downloads cleared - once per run of the app (every new
   *  window asked: a tab dragged out into its own window deleted the download under way) */
  let afterStarted = false;
  function afterStart() {
    if (afterStarted) return null;
    afterStarted = true;
    const s = readSettings();
    let updated = null;
    if (s.lastRunVersion && s.lastRunVersion !== version) {
      const mine = s.updateNotes && s.updateNotes.version === version;
      updated = { from: s.lastRunVersion, to: version, notes: mine ? s.updateNotes.notes || [] : [], groups: mine ? noteGroups(s.updateNotes.groups) : null, back: newer(s.lastRunVersion, version) };
    }
    // (a settings file held for a moment doesn't stop the rest: the notes, the clean-up)
    if (s.lastRunVersion !== version) { try { writeSettings({ ...readSettings(), lastRunVersion: version }); } catch (e) { log('update: ' + e); } }
    const t = s.updateTry;
    if (t && typeof t === 'object') {
      const w = { ...readSettings() };
      delete w.updateTry;
      try { writeSettings(w); } catch (e) { log('update: ' + e); }
      if (t.to && t.to !== version && t.from === version && Date.now() - Number(t.at || 0) < 3 * 86400000) {
        unfinished = String(t.to);
        log('update: the update to ' + unfinished + ' did not finish - still ' + version + ' (see "PDF Editor Setup.log" in TEMP)');
        // the first check already found it ready -> the card says so now; else look soon (not
        // at the usual first check)
        if (st.state === 'ready') void markUnfinished();
        else if (install() && source()) setTimeout(() => void check(false).catch((e) => log('update check: ' + e)), Number(process.env.PDFED_UPDATE_UNFINISHED || 3000));
      }
    }
    // helper copies and partial copies go; a downloaded package stays a week (it may still be
    // installed - "Update" then doesn't copy it again)
    fsp.readdir(workDir()).then((names) => names.forEach(async (n) => {
      const f = path.join(workDir(), n);
      let old = false;
      try { old = Date.now() - (await fsp.stat(f)).mtimeMs > 7 * 86400000; } catch (_) { return; }
      if (unfinished && n.includes(unfinished)) return; // (still to be installed)
      if (n.endsWith('.part') && st.state === 'downloading') return; // (being copied now)
      // (a program in here goes at once: none is downloaded any more - 0.8.2's setup, which the
      // antivirus flagged, sat here)
      const mine = n.includes('v' + version + '.') || n.includes('-' + version + '-') || n.includes('_' + version + '_');
      if (/^helper-\d+/.test(n) || n.endsWith('.part') || /\.exe$/i.test(n) || (/\.(zip|AppImage|deb)$/i.test(n) && (old || mine))) fsp.rm(f, { force: true }).catch(() => {});
    })).catch(() => {});
    return updated;
  }

  function start() {
    if (!install() || !linuxInstalled()) { st = { state: 'portable' }; return; }
    setTimeout(() => void check(false).catch((e) => log('update check: ' + e)), FIRST);
    timer = setInterval(() => void check(false).catch((e) => log('update check: ' + e)), EVERY);
    try { powerMonitor.on('resume', () => setTimeout(() => void check(false).catch(() => {}), 60000)); } catch (_) { /* n/a */ }
  }
  function stop() { clearInterval(timer); cancel(); }

  function setSource(v) {
    // (a copy still coming from the old folder stops: it belongs to that folder)
    if (st.state === 'downloading') cancel();
    const s = readSettings();
    if (v === null) delete s.updateSource; else s.updateSource = String(v).trim();
    writeSettings(s);
    latest = null;
    set({ state: 'idle', err: '', available: '', show: false });
    return snapshot();
  }

  return { snapshot, check, download, cancel, choose, chooseRollback, closeCancelled, later, applyAtQuit, afterStart, start, stop, setSource, preflight, kind: () => (latest ? latest.kind : 'app'), hasPending: () => !!pending, pendingRelaunch: () => !!(pending && pending.relaunch) };
}

module.exports = { create };
