// The anonymous user counter (Greenline build only; plan 7.10, receiver: reports-receiver/worker.js).
// Once a day this app sends a random number (made at the first ping, nothing of the PC or the
// person in it), its version and "win" / "linux" / "mac" - nothing else - so the developer can see
// how many installs there are. Never in the company build: there the module does nothing and makes
// no number. Nothing is sent until the first-start pop-up has been answered. Switched off = no
// ping and the number is deleted (a new one is made if it is switched on again).
// Settings (settings.json, so an update keeps them): userCount (default on), installId, countDay
// (the UTC day of the last ping that arrived), countAsked (the pop-up was answered).
// A failed ping is silent: no queue, no log of the number, no report, no message - it waits for
// the next try (every 6 h, only on a day that has no ping yet).
'use strict';
const crypto = require('crypto');

const FIRST_MS = 60 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

/** the counting address from the report receiver's address (".../report" or just the base): ".../count" */
function countUrl(endpoint) {
  const e = String(endpoint || '').trim();
  if (!/^https?:\/\//i.test(e)) return '';
  return e.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\/report$/i, '') + '/count';
}

const osName = (platform) => (platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux');
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * brand: package.json "brand" ('greenline' for the public build; anything else = nothing happens)
 * url: where to post (empty = no receiver: nothing happens)
 * the rest is for tests: fetch, now, platform, timers, timeoutMs, first, every
 */
function create(o) {
  const brand = String(o.brand || '');
  const url = String(o.url || '');
  const active = brand === 'greenline' && /^https?:\/\//i.test(url);
  const log = o.log || (() => {});
  const readSettings = o.readSettings, writeSettings = o.writeSettings;
  const now = o.now || Date.now;
  const timeoutMs = o.timeoutMs || TIMEOUT_MS;
  const setT = o.setTimeout || setTimeout, clearT = o.clearTimeout || clearTimeout;
  const first = o.first || FIRST_MS, every = o.every || EVERY_MS;
  const doFetch = o.fetch || ((u, init) => {
    let f = null;
    try { const { net } = require('electron'); if (net && typeof net.fetch === 'function') f = net.fetch; } catch (_) { /* not in Electron */ }
    return (f || fetch)(u, init);
  });

  // the person's settings as they are now ({} when they can't be read: nothing is sent then)
  const read = () => { try { const s = readSettings(); return s && typeof s === 'object' ? s : {}; } catch (_) { return {}; } };
  const patch = (p) => { const s = readSettings(); const n = { ...s }; for (const [k, v] of Object.entries(p)) { if (v === undefined) delete n[k]; else n[k] = v; } writeSettings(n); };
  const isOn = (s) => s.userCount !== false;

  let timer = null, busy = false, stopped = false, claimed = false;

  function state() {
    if (!active) return { active: false, asked: true, on: false };
    const s = read();
    return { active: true, asked: s.countAsked === true, on: isOn(s) };
  }

  /** one try: true when a ping arrived today. Never throws, never says anything. */
  async function tick() {
    if (!active || busy) return busy ? 'busy' : 'inactive';
    busy = true;
    try {
      const s = read();
      if (s.countAsked !== true) return 'unasked';
      if (!isOn(s)) return 'off';
      const today = utcDay(now());
      if (s.countDay === today) return 'today';
      let id = typeof s.installId === 'string' && /^[0-9a-f]{32}$/.test(s.installId) ? s.installId : '';
      if (!id) {
        // (made now, at the first ping - not at install, not at start)
        id = crypto.randomBytes(16).toString('hex');
        try { patch({ installId: id }); } catch (_) { return 'failed'; } // (no place to keep it: no ping)
      }
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      let to;
      const res = await Promise.race([
        doFetch(url, {
          method: 'POST', signal: ctl ? ctl.signal : undefined,
          headers: { 'Content-Type': 'application/json', 'X-Report-Client': 'pdf-editor' },
          body: JSON.stringify({ id, v: String(o.version), os: osName(o.platform || process.platform) }),
        }),
        new Promise((_r, rej) => { to = setTimeout(() => { try { if (ctl) ctl.abort(); } catch (_) { /* gone */ } rej(new Error('timeout')); }, timeoutMs); }),
      ]).finally(() => { clearTimeout(to); });
      if (!res || !res.ok) return 'failed';
      // (switched off while the ping was on its way: nothing written back)
      const after = read();
      if (isOn(after) && after.installId === id) { try { patch({ countDay: today }); } catch (_) { /* tried again at the next try */ } }
      return 'sent';
    } catch (_) {
      return 'failed'; // silent: waits for the next try
    } finally { busy = false; }
  }

  function schedule(ms) {
    if (!active || stopped) return;
    if (timer) clearT(timer);
    timer = setT(() => { timer = null; void tick().finally(() => schedule(every)); }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    active,
    state,
    tick,
    /** the first try 60 s from now, then every 6 h */
    start() { stopped = false; schedule(first); },
    stop() { stopped = true; if (timer) clearT(timer); timer = null; },
    /** the first window to ask while the pop-up is unanswered gets it (one pop-up per start) */
    claim() { if (!active || claimed || state().asked) return false; claimed = true; return true; },
    /** the pop-up's answer: true = "Keep it on", false = "Turn it off" */
    answer(keep) {
      if (!active) return state();
      patch(keep ? { countAsked: true, userCount: true } : { countAsked: true, userCount: false, installId: undefined });
      // (a try soon after a "keep": the 60 s try of this start passed while the pop-up was open)
      if (keep) schedule(first);
      return state();
    },
    /** the Settings switch */
    set(on) {
      if (!active) return state();
      patch(on ? { countAsked: true, userCount: true } : { countAsked: true, userCount: false, installId: undefined });
      if (on) schedule(first);
      return state();
    },
  };
}

/** where reports go, from the receiver's address (".../report" or just the base): ".../report" -
 *  the public build's address is the bare base, and the receiver takes reports only at /report:
 *  every report was refused (F34) */
function reportUrl(endpoint) {
  const e = String(endpoint || '').trim();
  if (!/^https?:\/\//i.test(e)) return e;
  return e.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\/report$/i, '') + '/report';
}

module.exports = { create, countUrl, reportUrl };
