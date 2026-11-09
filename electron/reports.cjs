// Crash and problem reports. Each report is one file with a unique name (plus a screenshot when
// the person attached one), written first to a queue on this PC and then copied into
// <updates folder>\reports by update-worker.cjs (own process, time limit - a share that is away
// or hangs never holds the app up). Reports wait in the queue until the folder is reachable.
// Never contains the PDFs themselves; the log tail can contain file names.
// Public build (updates from the web, a report receiver named in package.json "reportEndpoint"):
// reports go to that receiver instead, anonymised first (anon.cjs) - problem reports when the person
// presses Send, crash reports only once they've turned that on in Settings > Help (and only those
// made from then on). Without a receiver, nothing leaves the PC.
'use strict';
const feed = require('./feed.cjs');
const { app, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const PUT_TIMEOUT = Number(process.env.PDFED_REPORT_TIMEOUT) || 20000;
const MAX_AUTO_PER_DAY = 10;
const MAX_QUEUE = 60;

function create({ version, readSettings, writeSettings, log, logFile, source, appName, send, endpoint = '' }) {
  const queueDir = () => path.join(app.getPath('userData'), 'reports-outbox');
  let flushing = null;
  let last = { state: 'idle', err: '', at: 0, sent: 0 };

  function logTail(lines = 160) {
    try {
      const t = fs.readFileSync(logFile(), 'utf8');
      return t.split('\n').slice(-lines).join('\n');
    } catch (_) { return ''; }
  }
  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  const safe = (s) => String(s || '').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'user';

  function base() {
    return {
      app: appName,
      version,
      runtime: process.versions.electron,
      windows: os.platform() === 'win32' ? os.release() : os.platform() + ' ' + os.release(),
      arch: os.arch(),
      user: os.userInfo().username,
      pc: os.hostname(),
      memoryMB: { total: Math.round(os.totalmem() / 2 ** 20), free: Math.round(os.freemem() / 2 ** 20) },
      uptimeMin: Math.round(process.uptime() / 60),
      time: new Date().toISOString(),
    };
  }

  async function queue(kind, body, png) {
    const dir = queueDir();
    await fsp.mkdir(dir, { recursive: true });
    const name = `${stamp()}_${safe(os.userInfo().username)}_${kind}_${version}_${Math.random().toString(36).slice(2, 7)}`;
    // (the public build sends a JPEG - see smaller())
    const ext = png && png.length > 2 && png[0] === 0xff && png[1] === 0xd8 ? '.jpg' : '.png';
    if (png && png.length) await fsp.writeFile(path.join(dir, name + ext), png);
    const rep = { kind, ...base(), ...body, screenshot: png && png.length ? name + ext : null, log: logTail() };
    await fsp.writeFile(path.join(dir, name + '.json.part'), JSON.stringify(rep, null, 2));
    await fsp.rename(path.join(dir, name + '.json.part'), path.join(dir, name + '.json'));
    // keep the queue bounded (a PC that never reaches the share)
    const all = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    for (const n of all.slice(0, Math.max(0, all.length - MAX_QUEUE))) {
      await fsp.rm(path.join(dir, n), { force: true });
      await fsp.rm(path.join(dir, n.replace(/\.json$/, '.png')), { force: true });
      await fsp.rm(path.join(dir, n.replace(/\.json$/, '.jpg')), { force: true });
    }
    return name;
  }

  /** an automatic report: once per kind of failure per day, at most 10 a day */
  function crash(where, err) {
    try {
      const msg = String((err && err.message) || err || 'unknown');
      const stack = String((err && err.stack) || '');
      if (/ResizeObserver loop/.test(msg)) return;
      // (the public build, crash reports not agreed to: not kept - they would never be sent)
      if (endpoint && !readSettings().anonCrashReports) return;
      // (drawing engines 1-4 going down together are one kind of failure, not four)
      const key = where.replace(/\d+$/, '#') + '|' + msg.slice(0, 120) + '|' + (stack.split('\n')[1] || '').trim().slice(0, 120);
      const s = readSettings();
      const day = new Date().toISOString().slice(0, 10);
      const lim = s.reportLimits && s.reportLimits.day === day ? s.reportLimits : { day, count: 0, keys: [] };
      if (lim.keys.includes(key) || lim.count >= MAX_AUTO_PER_DAY) return;
      lim.count++;
      lim.keys = [...lim.keys, key].slice(-50);
      writeSettings({ ...readSettings(), reportLimits: lim });
      void queue('crash', { where, message: msg, stack }).then(() => scheduleFlush(3000)).catch((e) => log('report: ' + e));
    } catch (e) { log('report failed: ' + e); }
  }

  /** "Report a problem": the person's words (+ a screenshot of the window if they kept it) */
  async function problem(text, png, extra) {
    // (the public build: a picture of a big screen as a PNG is megabytes - sent as a smaller JPEG)
    if (endpoint && png && png.length) png = smaller(png);
    const name = await queue('problem', { text: String(text || '').slice(0, 20000), ...(extra || {}) }, png);
    let r = await flush();
    // (a send already under way listed the queue before this report was in it: once more)
    if (endpoint && fs.existsSync(path.join(queueDir(), name + '.json'))) r = await flush();
    if (endpoint) r = { ...r, state: fs.existsSync(path.join(queueDir(), name + '.json')) ? (r.state === 'idle' ? 'failed' : r.state === 'sent' ? 'failed' : r.state) : 'sent' };
    // updates from the web (GitHub): nothing is sent from here - the person's browser opens a new
    // issue with their words and the version filled in (no user or PC name, no log: those stay in
    // the report kept on this PC)
    const src = source();
    // (a receiver: sent anonymously already, by the flush above)
    if (endpoint) return r;
    if (feed.isWeb(src)) {
      const t = String(text || '').trim();
      const title = (t.split(/\r?\n/)[0] || 'Problem report').slice(0, 80);
      const b = base();
      const body = `${t || '(no text)'}\n\n---\nVersion ${b.version} (runtime ${b.runtime}), ${b.windows} ${b.arch}, ${b.memoryMB.total} MB memory` +
        (extra && extra.openFiles != null ? `, ${extra.openFiles} file(s) open` : '') + (png && png.length ? '\n(A screenshot was saved with the report on my PC.)' : '');
      return { ...r, state: 'web', issue: feed.issueUrl(src, title, body) };
    }
    return r;
  }

  function runJob(args) {
    return new Promise((resolve) => {
      let proc;
      try { proc = utilityProcess.fork(path.join(__dirname, 'update-worker.cjs'), args, { serviceName: appName + ' reports', stdio: 'ignore' }); }
      catch (e) { resolve({ ok: false, err: String(e.message || e), done: [] }); return; }
      let result = null, fin = false, t = null;
      // (reports sent one by one: each that got there counts, even if a later one runs out of time;
      // the time limit is per report, not for the whole queue)
      const sent = [];
      const arm = () => { clearTimeout(t); t = setTimeout(() => finish({ ok: false, err: 'timeout', done: [] }), PUT_TIMEOUT); };
      arm();
      function finish(r) { if (fin) return; fin = true; clearTimeout(t); try { proc.kill(); } catch (_) { /* gone */ } resolve({ ...r, done: [...new Set([...sent, ...(r.done || [])])] }); }
      proc.on('message', (m) => { if (m && Array.isArray(m.sent)) { sent.push(...m.sent); arm(); return; } result = m; if (m && m.ok !== undefined) finish(m); });
      proc.on('exit', () => finish(result || { ok: false, err: 'stopped', done: [] }));
    });
  }

  async function waiting() {
    try { return (await fsp.readdir(queueDir())).filter((n) => n.endsWith('.json')).length; } catch (_) { return 0; }
  }

  /** copy the queue to <updates folder>\reports; whatever got there leaves the queue */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const n = await waiting();
      const src = source();
      if (!n) { last = { ...last, state: 'idle' }; return status(); }
      if (!endpoint && !src) { last = { ...last, state: 'nofolder' }; return status(); }
      if (!endpoint && feed.isWeb(src)) { last = { ...last, state: 'web' }; return status(); }
      const s = readSettings();
      let r;
      if (endpoint) {
        // (the public build: crash reports the person hasn't agreed to send are never sent - they
        // don't wait here either, or "waiting on this PC" would count them for good)
        const since = s.anonCrashReports ? Number(s.anonCrashSince) || 0 : 0;
        await dropUnsendable(since);
        if (!(await waiting())) { last = { ...last, state: 'idle' }; return status(); }
        r = await runJob(['post', endpoint, queueDir(), String(since), await wordsFile()]);
      } else r = await runJob(['put', queueDir(), src]);
      for (const f of r.done || []) await fsp.rm(path.join(queueDir(), f), { force: true }).catch(() => {});
      const sent = (r.done || []).filter((f) => f.endsWith('.json')).length;
      last = { state: r.ok ? 'sent' : 'failed', err: r.ok ? '' : r.err || 'unknown', at: Date.now(), sent };
      if (!r.ok) log('reports: not sent (' + r.err + '), ' + (await waiting()) + ' waiting');
      return status();
    })().finally(() => { flushing = null; send('reports:state', null); });
    return flushing;
  }
  let timer = null;
  function scheduleFlush(ms) { clearTimeout(timer); timer = setTimeout(() => void flush().catch(() => {}), ms); }

  async function status() {
    const src = source();
    const web = feed.isWeb(src);
    // (the public build sends to its own receiver, whatever the updates come from)
    const anon = !!endpoint;
    const st = { waiting: await waiting(), folder: src && !web ? path.join(src, 'reports') : '', queue: queueDir(), ...last, anon, crashes: anon && !!readSettings().anonCrashReports };
    // (no receiver with updates from the web: nothing is sent - said so)
    if (web && !anon) st.state = 'web';
    return st;
  }

  /** public build: the picture as a JPEG at most 1600 px wide (a PNG of a big screen is megabytes) */
  function smaller(png) {
    try {
      const { nativeImage } = require('electron');
      let img = nativeImage.createFromBuffer(Buffer.from(png));
      const { width } = img.getSize();
      if (width > 1600) img = img.resize({ width: 1600, quality: 'good' });
      const jpg = img.toJPEG(72);
      return jpg && jpg.length ? jpg : png;
    } catch (e) { log('report picture: ' + e); return png; }
  }
  /** public build: crash reports that will never be sent (none agreed to, or made before) go */
  async function dropUnsendable(since) {
    let names = [];
    try { names = (await fsp.readdir(queueDir())).filter((n) => n.endsWith('.json')); } catch (_) { return; }
    for (const n of names) {
      let rep = null;
      try { rep = JSON.parse(await fsp.readFile(path.join(queueDir(), n), 'utf8')); } catch (_) { continue; }
      if (rep && rep.kind !== 'problem' && !(since && Date.parse(rep.time) >= since)) {
        await fsp.rm(path.join(queueDir(), n), { force: true }).catch(() => {});
        if (rep.screenshot) await fsp.rm(path.join(queueDir(), path.basename(String(rep.screenshot))), { force: true }).catch(() => {});
      }
    }
  }
  /** names this PC knows are private (the recent files: names and folders), for anon.cjs to take out
   *  whole - a name with spaces can't be told from the words around it otherwise */
  async function wordsFile() {
    const words = new Set();
    try {
      for (const r of readSettings().recent || []) {
        if (typeof r !== 'string' || !r) continue;
        const base = path.win32.basename(r), dir = path.win32.dirname(r);
        words.add(base);
        words.add(base.replace(/\.[^.]+$/, ''));
        for (const part of dir.split(/[\\/]+/).slice(1)) if (part.length >= 4) words.add(part);
      }
    } catch (_) { /* none */ }
    const f = path.join(app.getPath('userData'), 'report-words.tmp');
    try { await fsp.writeFile(f, JSON.stringify([...words].slice(0, 400))); } catch (_) { return ''; }
    return f;
  }
  /** public build: anonymous crash reports on / off (only those made from now on are ever sent) */
  function crashSharing(on) {
    const s = readSettings();
    if (on) { s.anonCrashReports = true; s.anonCrashSince = Date.now(); } else { s.anonCrashReports = false; delete s.anonCrashSince; }
    writeSettings(s);
    if (on) scheduleFlush(2000);
    return status();
  }
  /** exactly what a crash report sent from here looks like (Settings > Help: "What's sent") */
  function preview() {
    let who = { user: '', pc: '' };
    try { who = { user: os.userInfo().username, pc: os.hostname() }; } catch (_) { /* none */ }
    const sample = { kind: 'crash', ...base(), where: 'window', message: 'TypeError: an example error (the real one goes here)', stack: '', log: logTail() };
    return JSON.stringify(require('./anon.cjs').anonymize(sample, who), null, 2);
  }

  return { crash, problem, flush, scheduleFlush, status, crashSharing, preview };
}

module.exports = { create };
