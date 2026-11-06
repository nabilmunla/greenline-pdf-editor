// Offline translator (Mozilla Firefox Translations / Bergamot), main-process side:
// downloads the runtime and the language models once (checked against their SHA-256),
// keeps them in the app's data folder, and runs the engine in its own process.
'use strict';
const { net, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

// (the PDFED_MT_* variables are only for the app's own tests: a local stand-in for Mozilla's servers)
const RECORDS = process.env.PDFED_MT_RECORDS || 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records';
const CDN = process.env.PDFED_MT_CDN || 'https://firefox-settings-attachments.cdn.mozilla.net/';
/** the runtime, pinned: Firefox's bergamot-translator v0.6.0 (MPL-2.0). The loader script that
 *  must match it is shipped with the app (electron/engines/bergamot/bergamot-translator.js). */
const WASM = { path: 'main-workspace/translations-wasm/05082c31-aee8-4249-9e01-c1865afd7520.wasm', sha256: process.env.PDFED_MT_WASM_SHA || 'a3a89d9ad0a4ed8f27bf3e403701b23f5709816f6376438503f2fa5b0182c2dc', name: 'bergamot-translator-v0.6.0.wasm' };
/** this runtime runs model versions 1.x and 2.x (3.x needs a newer one) */
const MAX_MAJOR = 2;
const ENV = { 'appinfo.OS': 'WINNT', channel: 'release' };
/** how long the model list is kept before asking again (a day; tests: shorter) */
const LIST_TTL = Number(process.env.PDFED_MT_RECORDS_TTL) || 86400000;

module.exports = function translator({ dataDir, engineDir, log }) {
  const root = () => path.join(dataDir(), 'translator');
  const glue = process.env.PDFED_MT_GLUE || path.join(engineDir, 'bergamot', 'bergamot-translator.js');

  // ------------------------------------------------------------ the model list
  let recCache = null;
  async function records() {
    const file = path.join(root(), 'records.json');
    if (recCache && Date.now() - recCache.at < LIST_TTL) return recCache.data;
    let disk = null;
    try { disk = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { /* none yet */ }
    if (disk && Date.now() - disk.at < LIST_TTL) { recCache = disk; return disk.data; }
    try {
      const res = await net.fetch(RECORDS, { signal: AbortSignal.timeout(20000) }); // a network that drops quietly: don't say "Checking…" for ever
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = (await res.json()).data || [];
      recCache = { at: Date.now(), data };
      // keeping a copy is a convenience: a full disk or a locked folder is not an internet problem
      try { await fsp.mkdir(root(), { recursive: true }); await fsp.writeFile(file, JSON.stringify(recCache)); }
      catch (w) { log('translator: could not keep the model list: ' + w.message); }
      return data;
    } catch (e) {
      if (disk) { recCache = disk; return disk.data; } // offline: the list we had
      throw new Error('Could not get the list of translation languages from the download server (' + e.message + '). Check the internet connection - it is only needed once per language.');
    }
  }
  const matches = (expr) => {
    if (!expr || !expr.trim()) return true;
    return expr.split('||').some((c) => c.split('&&').every((a) => {
      const m = /^\s*env\.([\w.]+)\s*(==|!=)\s*'([^']*)'\s*$/.exec(a);
      if (!m || ENV[m[1]] === undefined) return false;
      return m[2] === '==' ? ENV[m[1]] === m[3] : ENV[m[1]] !== m[3];
    }));
  };
  const ver = (v) => { const m = /^(\d+)\.(\d+)$/.exec(v || ''); return m ? [+m[1], +m[2]] : null; };
  /** every complete model for from->to (model + lex + vocab(s)) this runtime can run, newest first */
  function pickAll(data, from, to) {
    const sets = new Map();
    for (const r of data) {
      if (r.fromLang !== from || r.toLang !== to) continue;
      const v = ver(r.version);
      if (!v || v[0] > MAX_MAJOR || !matches(r.filter_expression) || !r.attachment) continue;
      const s = sets.get(r.version) || { from, to, version: r.version, v, files: {} };
      s.files[r.fileType] = r;
      sets.set(r.version, s);
    }
    const ok = [...sets.values()].filter((s) => s.files.model && s.files.lex && (s.files.vocab || (s.files.srcvocab && s.files.trgvocab)));
    ok.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1]);
    return ok;
  }
  /**
   * direct, or through English. 'newest' = the newest version of each model (what a download
   * gets); 'installed' = the newest version already on this PC, else the newest - so a newer
   * model published by Mozilla never stops a pack that is installed from working (it is
   * offered as an update instead).
   */
  async function route(from, to, prefer = 'installed') {
    // language codes become folder names
    if (!/^[a-z]{2,3}$/.test(String(from)) || !/^[a-z]{2,3}$/.test(String(to))) throw new Error('Unknown language.');
    const data = await records();
    const choose = (a, b) => {
      const all = pickAll(data, a, b);
      if (!all.length) return null;
      return (prefer === 'installed' && all.find(complete)) || all[0];
    };
    const direct = choose(from, to);
    if (direct) return [direct];
    if (from !== 'en' && to !== 'en') {
      const a = choose(from, 'en'), b = choose('en', to);
      if (a && b) return [a, b];
    }
    throw new Error(`No offline model for ${from} → ${to}.`);
  }
  async function languages() {
    const data = await records();
    const codes = new Set();
    for (const r of data) if (ver(r.version) && ver(r.version)[0] <= MAX_MAJOR && matches(r.filter_expression)) { codes.add(r.fromLang); codes.add(r.toLang); }
    return [...codes].sort();
  }

  // ------------------------------------------------------------ files on disk
  // (the file name comes from the download server's list: only its own name is used, in plain
  // characters - never a path that could lead out of the models folder)
  const safeName = (n) => (path.basename(String(n || 'file')).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'file').slice(-100);
  const fileOf = (set, role) => { const r = set.files[role]; return path.join(root(), 'models', `${set.from}-${set.to}`, set.version, String(r.attachment.hash).replace(/[^0-9a-f]/gi, '').slice(0, 12) + '-' + safeName(r.name)); };
  const roles = (set) => ['model', 'lex', 'vocab', 'srcvocab', 'trgvocab'].filter((k) => set.files[k]);
  const wasmFile = () => path.join(root(), 'runtime', WASM.name);
  /** on disk, at its full size (a cut-off or emptied copy counts as missing: Download is offered again) */
  const exists = (f, size) => { try { const n = fs.statSync(f).size; return n > 0 && (!(size > 0) || n === size); } catch (_) { return false; } };
  const have = (set, k) => exists(fileOf(set, k), set.files[k].attachment.size);
  const complete = (set) => roles(set).every((k) => have(set, k));

  const missing = (r) => r.flatMap((s) => roles(s).filter((k) => !have(s, k)).map((k) => s.files[k].attachment.size));
  async function status(from, to) {
    try {
      const r = await route(from, to, 'installed');
      const need = missing(r);
      if (!exists(wasmFile())) need.push(5e6);
      const installed = need.length === 0;
      // installed, and Mozilla has a newer version: offered, never forced
      let update = null;
      if (installed) {
        const n = await route(from, to, 'newest');
        const more = missing(n);
        if (more.length) update = { download: more.reduce((a, x) => a + x, 0), version: n.map((s) => s.version).join(' + ') };
      }
      return { ok: true, installed, download: need.reduce((a, x) => a + x, 0), pivot: r.length > 1, version: r.map((s) => s.version).join(' + '), update };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** the system's network settings first (proxy); if refused, straight out with Node */
  async function fetchBytes(url, onBytes, name) {
    let why = '';
    // a download that stops moving for a minute is given up (instead of waiting for ever)
    const ac = new AbortController();
    let idle = null;
    const poke = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('the download stopped moving')), 60000); };
    try {
      poke();
      const res = await net.fetch(url, { headers: { accept: '*/*', 'accept-encoding': 'identity' }, signal: ac.signal });
      if (res.ok) {
        const reader = res.body.getReader();
        const parts = [];
        for (;;) {
          poke();
          const { value, done } = await reader.read();
          if (done) break;
          parts.push(Buffer.from(value));
          onBytes(value.length);
        }
        clearTimeout(idle);
        return Buffer.concat(parts);
      }
      clearTimeout(idle);
      let body = '';
      try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 160); } catch (_) { /* none */ }
      why = res.status + (res.headers.get('server') ? ' from ' + res.headers.get('server') : '') + (body ? ': ' + body : '');
      log('translator download ' + url + ' -> ' + why);
    } catch (e) { clearTimeout(idle); why = e.message; log('translator download ' + url + ' -> ' + why); }
    // second route: Node's own HTTPS (no proxy) - some company filters only act on the proxy
    try {
      const buf = await new Promise((resolve, reject) => {
        const get = (u, hops) => require('https').get(u, { headers: { 'user-agent': 'Mozilla/5.0 PDF Editor', accept: '*/*' }, timeout: 30000 }, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) { r.resume(); get(new URL(r.headers.location, u).toString(), hops + 1); return; }
          if (r.statusCode !== 200) { r.resume(); reject(new Error(String(r.statusCode))); return; }
          const parts = [];
          r.on('data', (c) => { parts.push(c); onBytes(c.length); });
          r.on('end', () => resolve(Buffer.concat(parts)));
          r.on('error', reject);
        }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); });
        get(url, 0);
      });
      return buf;
    } catch (e) { log('translator download (direct) ' + url + ' -> ' + e.message); why += ' / direct: ' + e.message; }
    throw new Error('Download failed (' + why + '): ' + name + '. If your company network blocks downloads from firefox-settings-attachments.cdn.mozilla.net, IT can allow that address, or the language pack can be copied in by hand.');
  }

  async function download(url, sha256, dest, onBytes, size) {
    if (exists(dest, size)) return dest;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const buf = await fetchBytes(url, onBytes, path.basename(dest));
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== sha256) throw new Error('A downloaded file did not match its checksum (' + path.basename(dest) + '); nothing was installed. Try again.');
    const tmp = dest + '.part';
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, dest);
    return dest;
  }
  async function install(from, to, progress) {
    const r = await route(from, to, 'newest');
    const jobs = [];
    if (!exists(wasmFile())) jobs.push({ url: CDN + WASM.path, sha: WASM.sha256, dest: wasmFile(), size: 5e6, exact: 0 });
    for (const s of r) for (const k of roles(s)) { const f = s.files[k]; jobs.push({ url: CDN + f.attachment.location, sha: f.attachment.hash, dest: fileOf(s, k), size: f.attachment.size, exact: f.attachment.size }); }
    const total = jobs.reduce((a, j) => a + (exists(j.dest, j.exact) ? 0 : j.size), 0);
    let done = 0;
    for (const j of jobs) { await download(j.url, j.sha, j.dest, (n) => { done += n; progress(done, total); }, j.exact); good.add(j.dest); }
    // older versions of these models are no longer needed (they stay usable until the new one is
    // complete); the engine lets go of them first (Windows can't delete files in use) - after
    // any translation running on it has finished
    await serial(async () => {
      if (proc) { const p = proc; proc = null; procKey = ''; p.kill(); }
      for (const s of r) {
        const dir = path.join(root(), 'models', `${s.from}-${s.to}`);
        for (const v of await fsp.readdir(dir).catch(() => [])) if (v !== s.version) await fsp.rm(path.join(dir, v), { recursive: true, force: true }).catch(() => {});
      }
    });
    return true;
  }
  /** files checked against their SHA-256 this session (a damaged or swapped copy is caught once,
   *  when the engine first loads it, and goes - Download is then offered again) */
  const good = new Set();
  async function verify(f, sha256) {
    if (good.has(f) || !sha256) return;
    const h = crypto.createHash('sha256');
    await new Promise((res, rej) => fs.createReadStream(f).on('data', (b) => h.update(b)).on('end', res).on('error', rej));
    if (h.digest('hex') !== String(sha256).toLowerCase()) {
      await fsp.rm(f, { force: true }).catch(() => {});
      throw new Error('A file of the language pack is damaged (' + path.basename(f) + ') and was removed. Download the language pack again.');
    }
    good.add(f);
  }
  /** one thing at a time on the engine: two translations (two files, or two language pairs) and
   *  an update take turns instead of replacing the engine under each other */
  let chain = Promise.resolve();
  function serial(fn) { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; }

  // ------------------------------------------------------------ the engine process
  // each engine process has its own list of calls waiting for an answer: when a process is
  // replaced (another language pair), its exit must not fail the new one's calls
  let proc = null, procKey = '', seq = 1;
  function start() {
    const me = utilityProcess.fork(path.join(engineDir, 'translate.mjs'), [], { serviceName: 'PDF Editor translator', stdio: 'pipe' });
    me.waiting = new Map();
    me.stdout?.on('data', (b) => log('[translator] ' + String(b).trim()));
    me.stderr?.on('data', (b) => log('[translator] ' + String(b).trim()));
    me.on('message', (m) => {
      const w = m && me.waiting.get(m.id);
      if (!w) return;
      me.waiting.delete(m.id);
      if (m.ok) w.res(m.value); else w.rej(new Error(m.error));
    });
    me.on('exit', (code) => {
      if (proc === me) { proc = null; procKey = ''; }
      log('translator engine exited ' + code);
      for (const w of me.waiting.values()) w.rej(new Error('The translation engine stopped (' + code + '). Try again.'));
      me.waiting.clear();
    });
    proc = me;
  }
  // (an engine that stops answering - hung, not exited - would hold every translation after it in
  // the queue for ever: after a generous wait it is ended, and the next call starts a fresh one)
  const LIMIT = { load: 300000, translate: 180000 };
  const call = (msg) => {
    const p = proc;
    return new Promise((res, rej) => {
      const id = seq++;
      const timer = setTimeout(() => {
        if (!p.waiting.has(id)) return;
        log('translator: no answer to ' + msg.type + ' - engine ended');
        if (proc === p) { proc = null; procKey = ''; }
        try { p.kill(); } catch (_) { /* gone */ }
      }, LIMIT[msg.type] || 180000);
      p.waiting.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      p.postMessage({ ...msg, id });
    });
  };
  async function translate(from, to, texts) {
    const r = await route(from, to, 'installed');
    for (const s of r) for (const k of roles(s)) if (!have(s, k)) throw new Error('NOT_INSTALLED');
    if (!exists(wasmFile())) throw new Error('NOT_INSTALLED');
    const key = r.map((s) => `${s.from}-${s.to}@${s.version}`).join('|');
    return serial(async () => {
      if (proc && procKey !== key) { const p = proc; proc = null; procKey = ''; p.kill(); }
      if (procKey !== key) {
        await verify(wasmFile(), WASM.sha256);
        for (const s of r) for (const k of roles(s)) await verify(fileOf(s, k), s.files[k].attachment.hash);
      }
      if (!proc) start();
      if (procKey !== key) {
        await call({ type: 'load', wasm: wasmFile(), glue, models: r.map((s) => ({ from: s.from, to: s.to, files: Object.fromEntries(roles(s).map((k) => [k, fileOf(s, k)])) })) });
        procKey = key;
      }
      // in batches: a long page goes through in pieces, so progress can be shown
      const out = [];
      for (let i = 0; i < texts.length; i += 24) out.push(...(await call({ type: 'translate', texts: texts.slice(i, i + 24) })));
      return out;
    });
  }
  function stop() { if (proc) { proc.kill(); proc = null; procKey = ''; } }

  return { languages, status, install, translate, stop };
};
