// Crash and problem reports. Each report is one file with a unique name (plus a screenshot when
// the person attached one), written first to a queue on this PC and then copied into
// <updates folder>\reports by update-worker.cjs (own process, time limit - a share that is away
// or hangs never holds the app up). Reports wait in the queue until the folder is reachable.
// Never contains the PDFs themselves; the log tail can contain file names.
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

function create({ version, readSettings, writeSettings, log, logFile, source, appName, send }) {
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
    if (png && png.length) await fsp.writeFile(path.join(dir, name + '.png'), png);
    const rep = { kind, ...base(), ...body, screenshot: png && png.length ? name + '.png' : null, log: logTail() };
    await fsp.writeFile(path.join(dir, name + '.json.part'), JSON.stringify(rep, null, 2));
    await fsp.rename(path.join(dir, name + '.json.part'), path.join(dir, name + '.json'));
    // keep the queue bounded (a PC that never reaches the share)
    const all = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    for (const n of all.slice(0, Math.max(0, all.length - MAX_QUEUE))) {
      await fsp.rm(path.join(dir, n), { force: true });
      await fsp.rm(path.join(dir, n.replace(/\.json$/, '.png')), { force: true });
    }
    return name;
  }

  /** an automatic report: once per kind of failure per day, at most 10 a day */
  function crash(where, err) {
    try {
      const msg = String((err && err.message) || err || 'unknown');
      const stack = String((err && err.stack) || '');
      if (/ResizeObserver loop/.test(msg)) return;
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
    await queue('problem', { text: String(text || '').slice(0, 20000), ...(extra || {}) }, png);
    const r = await flush();
    // updates from the web (GitHub): nothing is sent from here - the person's browser opens a new
    // issue with their words and the version filled in (no user or PC name, no log: those stay in
    // the report kept on this PC)
    const src = source();
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

  function runPut(src, dst) {
    return new Promise((resolve) => {
      let proc;
      try { proc = utilityProcess.fork(path.join(__dirname, 'update-worker.cjs'), ['put', src, dst], { serviceName: appName + ' reports', stdio: 'ignore' }); }
      catch (e) { resolve({ ok: false, err: String(e.message || e), done: [] }); return; }
      let result = null, fin = false;
      const t = setTimeout(() => finish({ ok: false, err: 'timeout', done: [] }), PUT_TIMEOUT);
      function finish(r) { if (fin) return; fin = true; clearTimeout(t); try { proc.kill(); } catch (_) { /* gone */ } resolve(r); }
      proc.on('message', (m) => { result = m; if (m && m.ok !== undefined) finish(m); });
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
      if (!src) { last = { ...last, state: 'nofolder' }; return status(); }
      if (feed.isWeb(src)) { last = { ...last, state: 'web' }; return status(); }
      const r = await runPut(queueDir(), src);
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
    return { waiting: await waiting(), folder: src && !feed.isWeb(src) ? path.join(src, 'reports') : '', queue: queueDir(), ...last, ...(feed.isWeb(src) ? { state: 'web' } : {}) };
  }

  return { crash, problem, flush, scheduleFlush, status };
}

module.exports = { create };
