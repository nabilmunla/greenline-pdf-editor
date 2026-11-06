// Updates: the parts that touch the updates folder (often a network share) run here, in a
// process of their own. A share that hangs (server off, VPN down) can only stall this process -
// the app kills it after a time limit and carries on.
//   check <folder | web address>    -> { ok, latest } | { ok: false, reach, err }
//   copy <src | url> <dst> <size>   -> { progress } ..., { done, sha } | { ok: false, err }
//   put <queue> <folder>            -> { ok, done: [names copied to <folder>\reports] }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const feed = require('./feed.cjs');

const port = process.parentPort;
const send = (m) => { try { port.postMessage(m); } catch (_) { /* parent gone */ } };
const [cmd, a, b, c] = process.argv.slice(2);

function check(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return send({ ok: false, reach: 'notdir', err: 'not a folder' });
  } catch (e) {
    return send({ ok: false, reach: 'unreachable', err: e.code || String(e.message || e) });
  }
  let txt;
  try {
    txt = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8');
  } catch (e) {
    return send({ ok: false, reach: e.code === 'ENOENT' ? 'empty' : 'unreachable', err: e.code || String(e.message || e) });
  }
  try {
    const latest = JSON.parse(txt.replace(/^﻿/, ''));
    // (the signed part names the packages the app goes by: whether they are there, checked too)
    let signed = null;
    try { signed = typeof latest.signed === 'string' ? JSON.parse(latest.signed) : null; } catch (_) { signed = null; }
    // the package must be there too (someone may have copied latest.json first)
    for (const k of ['app', 'setup']) {
      const f = latest && latest[k] && latest[k].file;
      // (and whole: a package still being copied onto the share is smaller than latest.json says)
      if (f) { let st = null; try { st = fs.statSync(path.join(dir, path.basename(String(f)))); } catch (_) { /* not there */ } latest[k].present = !!st && (!st.isFile() || !latest[k].size || st.size === Number(latest[k].size)); }
    }
    const present = {};
    for (const k of ['app', 'setup']) {
      const p = signed && signed[k];
      if (p && p.file) { let st = null; try { st = fs.statSync(path.join(dir, path.basename(String(p.file)))); } catch (_) { /* not there */ } present[k] = !!st && (!st.isFile() || !p.size || st.size === Number(p.size)); }
    }
    latest.signedPresent = present;
    send({ ok: true, latest });
  } catch (e) {
    send({ ok: false, reach: 'bad', err: 'latest.json is not valid: ' + (e.message || e) });
  }
}

function copy(src, dst, size) {
  const total = Number(size) || 0;
  let done = 0, last = 0;
  const hash = crypto.createHash('sha256');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = fs.createReadStream(src, { highWaterMark: 1 << 20 });
  const w = fs.createWriteStream(dst);
  const fail = (e) => { send({ ok: false, err: e.code || String(e.message || e) }); try { w.destroy(); } catch (_) { /* */ } setTimeout(() => process.exit(1), 50); };
  r.on('error', fail);
  w.on('error', fail);
  r.on('data', (chunk) => {
    hash.update(chunk);
    done += chunk.length;
    const now = Date.now();
    if (now - last > 200) { last = now; send({ progress: done, total }); }
  });
  w.on('finish', () => {
    send({ progress: done, total });
    send({ done: true, bytes: done, sha: hash.digest('hex') });
    setTimeout(() => process.exit(0), 50);
  });
  r.pipe(w);
}

/** reports: queue folder -> <folder>\reports (screenshots first, so a report that has arrived is
 *  complete; written as .tmp then renamed, so nobody reads half a file) */
function put(src, dstRoot) {
  const dst = path.join(dstRoot, 'reports');
  const done = [];
  try {
    if (!fs.statSync(dstRoot).isDirectory()) return send({ ok: false, err: 'not a folder', done });
    fs.mkdirSync(dst, { recursive: true });
  } catch (e) { return send({ ok: false, err: e.code || String(e.message || e), done }); }
  const names = fs.readdirSync(src).filter((n) => /\.(json|png)$/.test(n)).sort((x, y) => (x.endsWith('.png') === y.endsWith('.png') ? x.localeCompare(y) : x.endsWith('.png') ? -1 : 1));
  for (const n of names) {
    // a report's screenshot goes with it: skip a .json whose .png didn't make it
    if (n.endsWith('.json') && names.includes(n.replace(/\.json$/, '.png')) && !done.includes(n.replace(/\.json$/, '.png'))) continue;
    try {
      fs.copyFileSync(path.join(src, n), path.join(dst, n + '.tmp'));
      fs.renameSync(path.join(dst, n + '.tmp'), path.join(dst, n));
      done.push(n);
    } catch (e) { return send({ ok: false, err: e.code || String(e.message || e), done }); }
  }
  send({ ok: true, done });
}

// ---------------------------------------------------------------- the web (GitHub releases)
// Electron's own network stack where this process has it (the PC's proxy settings), else Node's
function get(url) {
  let f = null;
  try { const { net } = require('electron'); if (net && typeof net.fetch === 'function') f = (u) => net.fetch(u, { redirect: 'follow', cache: 'no-store' }); } catch (_) { /* not here */ }
  if (!f) f = (u) => fetch(u, { redirect: 'follow', cache: 'no-store', headers: { 'User-Agent': 'PDF Editor updates' } });
  return f(url);
}
async function checkWeb(src) {
  let res;
  try { res = await get(feed.latestUrl(src)); } catch (e) { return send({ ok: false, reach: 'unreachable', err: String((e && (e.code || e.message)) || e) }); }
  // (no release yet - or none with a latest.json)
  if (res.status === 404) return send({ ok: false, reach: 'empty', err: 'HTTP 404' });
  if (!res.ok) return send({ ok: false, reach: 'unreachable', err: 'HTTP ' + res.status });
  try {
    const txt = await res.text();
    if (txt.length > 1 << 20) throw new Error('too long');
    send({ ok: true, latest: JSON.parse(txt.replace(/^\uFEFF/, '')) });
  } catch (e) {
    send({ ok: false, reach: 'bad', err: 'latest.json is not valid: ' + (e.message || e) });
  }
}
async function copyWeb(url, dst, size) {
  const total = Number(size) || 0;
  let done = 0, last = 0;
  const hash = crypto.createHash('sha256');
  const fail = (e) => { send({ ok: false, err: e }); setTimeout(() => process.exit(1), 50); };
  let res;
  try { res = await get(url); } catch (e) { return fail(String((e && (e.code || e.message)) || e)); }
  if (res.status === 404) return fail('ENOENT');
  if (!res.ok || !res.body) return fail('HTTP ' + res.status);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const w = fs.createWriteStream(dst);
  let failed = false;
  w.on('error', (e) => { failed = true; fail(e.code || String(e.message || e)); });
  try {
    const rd = res.body.getReader();
    for (;;) {
      const { done: end, value } = await rd.read();
      if (end || failed) break;
      const chunk = Buffer.from(value);
      done += chunk.length;
      // (more than latest.json said: not the file it signed - stopped)
      if (total && done > total) { try { rd.cancel(); } catch (_) { /* */ } w.destroy(); return fail('bigger than announced'); }
      hash.update(chunk);
      if (!w.write(chunk)) await new Promise((r) => w.once('drain', r));
      const now = Date.now();
      if (now - last > 200) { last = now; send({ progress: done, total }); }
    }
  } catch (e) { w.destroy(); return fail(String((e && (e.code || e.message)) || e)); }
  if (failed) return;
  w.end(() => {
    send({ progress: done, total });
    send({ done: true, bytes: done, sha: hash.digest('hex') });
    setTimeout(() => process.exit(0), 50);
  });
}

if (cmd === 'check' && feed.isWeb(a)) checkWeb(a).finally(() => setTimeout(() => process.exit(0), 50));
else if (cmd === 'check') { check(a); setTimeout(() => process.exit(0), 50); }
else if (cmd === 'put') { put(a, b); setTimeout(() => process.exit(0), 50); }
else if (cmd === 'copy' && feed.isWeb(a)) copyWeb(a, b, c);
else if (cmd === 'copy') copy(a, b, c);
else { send({ ok: false, err: 'unknown command' }); process.exit(2); }
