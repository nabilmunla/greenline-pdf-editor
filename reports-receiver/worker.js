// The public build's report receiver: a Cloudflare Worker on the developer's own account.
//   POST /report          an anonymised report from the app (electron/anon.cjs) -> stored privately
//   GET  /                the list (password: the ADMIN_KEY secret, browser sign-in box)
//   GET  /r/<id>          one report (its picture inline);  POST /r/<id>/delete
//   POST /count           the anonymous user counter: one ping per install per day (id, version, OS)
//   GET  /counts          the numbers per app: today so far and the daily rows (same password; ?format=json)
// It serves two apps, kept apart: the PDF Editor and Rev Radar. The app is the x-report-client header
// ('pdf-editor' or 'rev-radar', nothing else is accepted). GET /?app=rev-radar filters the list.
// Setup (Cloudflare dashboard): a KV namespace bound as REPORTS, a secret ADMIN_KEY (the counter needs nothing more). Reports expire
// after 180 days by themselves. Nothing here is secret - the password lives in Cloudflare, not here.

const KEEP_DAYS = 180;
const MAX_BODY = 1_200_000;       // a report with its picture (the app sends a JPEG of at most 1600 px)
const PER_HOUR = 20;              // reports per address per hour
const PER_DAY = 500;              // reports a day in all (per Cloudflare location): a flood stops here
const COUNT_KEEP_DAYS = 30;       // an install not heard from for 30 days drops out of the count
const ROWS_KEEP_DAYS = 400;       // the daily totals
const COUNT_PER_HOUR = 60;        // count pings per address per hour (an office behind one address)
const MAX_COUNT = 200;            // bytes of a count ping
const DETAIL_ROWS = 25;           // daily rows shown with their version / OS split (a free Worker may make 50 store calls)
const APPS = { 'pdf-editor': 'PDF Editor', 'rev-radar': 'Rev Radar' };   // header value -> name shown
const DEFAULT_APP = 'pdf-editor';  // anything stored before the second app existed (no app on it) is the PDF Editor's
const appOf = (req) => { const c = req.headers.get('x-report-client'); return Object.prototype.hasOwnProperty.call(APPS, c) ? c : null; };
const MAX_FIELD = { where: 200, message: 2000, stack: 8000, text: 20000, log: 30000 };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/report') return req.method === 'POST' ? await receive(req, env) : text('POST only', 405);
      if (url.pathname === '/count') return req.method === 'POST' ? await ping(req, env) : text('POST only', 405);
      if (!authorised(req, env)) return new Response('Sign in', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Reports", charset="UTF-8"' } });
      if (url.pathname === '/') return await list(env, url);
      if (url.pathname === '/counts') return await counts(env, url);
      const m = /^\/r\/([\w-]{8,80})(\/delete)?$/.exec(url.pathname);
      if (m && !m[2]) return await one(env, m[1]);
      if (m && m[2] === '/delete' && req.method === 'POST') { await env.REPORTS.delete('r:' + m[1]); await env.REPORTS.delete('s:' + m[1]); return Response.redirect(url.origin + '/', 303); }
      return text('Not found', 404);
    } catch (e) {
      return text('Error: ' + (e && e.message || e), 500);
    }
  },
};

// ---------------------------------------------------------------- receiving
async function receive(req, env) {
  // only the app: it sends this header, and a web page can't without asking first (a site can't
  // make its visitors' browsers post reports)
  const client = appOf(req);
  if (!client) return text('Not a report', 400);
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return text('Too big', 413);
  const over = await overLimit(req, '', PER_HOUR, PER_DAY, now(env));
  if (over === 'hour') return text('Too many reports - try again later', 429);
  if (over === 'day') return text('Too many reports today - try again tomorrow', 429);
  const hour = Math.floor(now(env) / 3600000);

  // (read up to the limit - a request without a length is not read whole first)
  const raw = await readCapped(req, MAX_BODY);
  if (raw === null) return text('Too big', 413);
  let r;
  try { r = JSON.parse(raw); } catch (_) { return text('Not a report', 400); }
  if (!r || typeof r !== 'object' || !['crash', 'problem'].includes(r.kind) || !/^\d+\.\d+\.\d+$/.test(String(r.version || ''))) return text('Not a report', 400);
  const rep = {
    kind: r.kind, client, app: str(r.app, 40), version: str(r.version, 20), runtime: str(r.runtime, 20), windows: str(r.windows, 40), arch: str(r.arch, 10),
    memoryMB: r.memoryMB && typeof r.memoryMB === 'object' ? { total: num(r.memoryMB.total), free: num(r.memoryMB.free) } : null,
    uptimeMin: num(r.uptimeMin), time: str(r.time, 30), openFiles: num(r.openFiles),
    // (to the hour, like the report's own time - no exact moment is kept)
    received: new Date(hour * 3600000).toISOString(),
  };
  for (const [k, n] of Object.entries(MAX_FIELD)) if (r[k] != null) rep[k] = str(r[k], n);
  const id = String(9e9 - hour).padStart(10, '0') + '-' + crypto.randomUUID().slice(0, 12); // newest hour first in the list
  const ttl = { expirationTtl: KEEP_DAYS * 86400 };
  let hasShot = false;
  // the picture: kept as it came (base64 - decoding it here would cost more time than a free Worker
  // has); a PNG or a JPEG and nothing else, shown inline on the report's page
  if (r.kind === 'problem' && typeof r.screenshot === 'string' && /^(iVBORw0KGgo|\/9j\/)[A-Za-z0-9+/]*={0,2}$/.test(r.screenshot.slice(0, 64)) && /^[A-Za-z0-9+/]*={0,2}$/.test(r.screenshot.slice(-64))) {
    await env.REPORTS.put('s:' + id, r.screenshot, ttl);
    hasShot = true;
  }
  const title = (rep.kind === 'problem' ? (rep.text || '').split('\n')[0] : (rep.message || rep.where || '')).slice(0, 120);
  await env.REPORTS.put('r:' + id, JSON.stringify({ ...rep, hasShot }), { ...ttl, metadata: { kind: rep.kind, version: rep.version, time: rep.received, title, shot: hasShot, app: client } });
  return text('Thanks', 200);
}

// (simple brakes: this data centre's cache counts per address an hour, and all reports a day.
// The address itself is never stored - only a hash of it, in the cache, for an hour)
async function overLimit(req, tag, perHour, perDay, t) {
  const ip = req.headers.get('cf-connecting-ip') || '';
  const hour = Math.floor(t / 3600000);
  const cache = caches.default;
  const count = async (key, limit, age) => {
    const ck = new Request('https://rate.local/' + key);
    const seen = Number((await (await cache.match(ck))?.text()) || 0);
    if (seen >= limit) return false;
    await cache.put(ck, new Response(String(seen + 1), { headers: { 'Cache-Control': 'max-age=' + age } }));
    return true;
  };
  if (!(await count(await hash(tag + ip + '|' + hour), perHour, 3600))) return 'hour';
  if (perDay && !(await count('day-' + Math.floor(hour / 24), perDay, 86400))) return 'day';
  return '';
}

// ---------------------------------------------------------------- the user counter
// One key per install per app, an EMPTY value, the facts in the key's metadata { last, prev, v, os }
// (last / prev = UTC day numbers), gone 30 days after its last ping. The key is made from a SHA-256 of
// the install's number (the number itself is not kept): the PDF Editor's is c:<24 hex> (as it always was),
// Rev Radar's is c:rev-radar:<24 hex>. So a key with no app in it is the PDF Editor's, and the same number
// in two apps gives two unrelated keys. A ping writes only when `last` is not today: one KV write per
// install per day per app (free plan: 1,000 writes a day). The counts are read from the keys' metadata
// (one list of all c: keys serves both apps: no extra reads). The first ping of a new UTC day (from either
// app) closes yesterday: ONE n:<date> row holding both apps' totals (day / week / month, by version, by OS),
// kept 400 days - at most one such write a day, never one per app.
const now = (env) => (typeof env.CLOCK === 'function' ? env.CLOCK() : Date.now()); // (CLOCK: a test hook only)
const DAY_MS = 86400000;
const dayDate = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
const keyPrefix = (app) => (app === DEFAULT_APP ? 'c:' : 'c:' + app + ':');
const keyApp = (name) => { const m = /^c:([a-z-]+):/.exec(name); return m && Object.prototype.hasOwnProperty.call(APPS, m[1]) ? m[1] : DEFAULT_APP; };

async function ping(req, env) {
  const app = appOf(req);
  if (!app) return text('Not a count', 400);
  const t = now(env);
  if (await overLimit(req, 'c-', COUNT_PER_HOUR, 0, t)) return text('Too many - try again later', 429);
  const raw = await readCapped(req, MAX_COUNT);
  let c;
  try { c = JSON.parse(raw); } catch (_) { return text('Not a count', 400); }
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== 3 || typeof c.id !== 'string' || typeof c.v !== 'string' || !/^[0-9a-f]{32}$/.test(c.id) ||
      !/^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(c.v) || !['win', 'linux', 'mac'].includes(c.os)) return text('Not a count', 400);
  const today = Math.floor(t / DAY_MS);
  const key = keyPrefix(app) + await hash(c.id);
  const { metadata: m } = await env.REPORTS.getWithMetadata(key);
  if (m && m.last === today) return text('Thanks', 200);
  await closeYesterday(env, today);
  await env.REPORTS.put(key, '', { expirationTtl: COUNT_KEEP_DAYS * 86400, metadata: { last: today, prev: m && Number.isInteger(m.last) ? m.last : null, v: c.v, os: c.os } });
  return text('Thanks', 200);
}

// every install's metadata, with its app (list pages of up to 1,000 keys; both apps in the same pages)
async function installs(env) {
  const all = [];
  let cursor;
  do {
    const res = await env.REPORTS.list({ prefix: 'c:', limit: 1000, cursor });
    for (const k of res.keys) if (k.metadata && Number.isInteger(k.metadata.last)) all.push({ ...k.metadata, app: keyApp(k.name) });
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return all;
}
// the totals as they stood at the end of UTC day d: seen on that day / in the 7 days to it / all keys
// then (a key pinged since keeps its one earlier day in `prev`, so a later list gives the same answer)
function totals(metas, d) {
  const seen = (m, a, b) => (m.last >= a && m.last <= b) || (Number.isInteger(m.prev) && m.prev >= a && m.prev <= b);
  const dayKeys = metas.filter((m) => seen(m, d, d));
  const by = (f) => dayKeys.reduce((o, m) => { o[m[f]] = (o[m[f]] || 0) + 1; return o; }, {});
  return {
    day: dayKeys.length,
    week: metas.filter((m) => seen(m, d - 6, d)).length,
    month: metas.filter((m) => m.last <= d || (Number.isInteger(m.prev) && m.prev <= d)).length,
    byVersion: by('v'), byOs: by('os'),
  };
}
// both apps' totals for day d: { apps: { 'pdf-editor': {...}, 'rev-radar': {...} } }
const bothApps = (metas, d) => ({ apps: Object.fromEntries(Object.keys(APPS).map((a) => [a, totals(metas.filter((m) => m.app === a), d)])) });
// a row's numbers only (day / week / month per app: short enough for the key's 1 KB of metadata, so
// the daily list needs no reads). A row written before the second app (flat day / week / month) is the PDF Editor's.
const rowNumbers = (r) => {
  const out = {};
  for (const a of Object.keys(APPS)) {
    const x = r.apps ? r.apps[a] : (a === DEFAULT_APP ? r : null);
    out[a] = x ? { day: x.day || 0, week: x.week || 0, month: x.month || 0 } : { day: 0, week: 0, month: 0 };
  }
  return out;
};
const sumApps = (n) => Object.values(n).reduce((o, x) => ({ day: o.day + x.day, week: o.week + x.week, month: o.month + x.month }), { day: 0, week: 0, month: 0 });
// writes yesterday's row if it is not there yet (a read of the row first, a write at most once a day)
async function closeYesterday(env, today, metas) {
  const name = 'n:' + dayDate(today - 1);
  if ((await env.REPORTS.get(name)) !== null) return null;
  const row = bothApps(metas || await installs(env), today - 1);
  const nums = rowNumbers(row);
  await env.REPORTS.put(name, JSON.stringify(row), { expirationTtl: ROWS_KEEP_DAYS * 86400, metadata: { a: Object.fromEntries(Object.entries(nums).map(([k, x]) => [k, [x.day, x.week, x.month]])) } });
  return { name, ...row };
}

// ---------------------------------------------------------------- reading (the developer)
function authorised(req, env) {
  const h = req.headers.get('authorization') || '';
  if (!env.ADMIN_KEY || !h.startsWith('Basic ')) return false;
  let pass = '';
  try { pass = atob(h.slice(6)).split(':').slice(1).join(':'); } catch (_) { return false; }
  // (compared in full whatever the first difference - no timing hints)
  const a = new TextEncoder().encode(pass), b = new TextEncoder().encode(env.ADMIN_KEY);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a[i] || 0) ^ (b[i] || 0);
  return d === 0;
}
async function list(env, url) {
  const want = Object.prototype.hasOwnProperty.call(APPS, url.searchParams.get('app')) ? url.searchParams.get('app') : '';   // '' = both apps
  // (one app: further pages are read until 200 of its reports are in hand, 5 lists at most - the
  // filter was applied to one page of 200, which could show none of them with "Older" under it)
  const ofApp = (k) => !want || ((k.metadata || {}).app || DEFAULT_APP) === want;
  let res = await env.REPORTS.list({ prefix: 'r:', limit: 200, cursor: url.searchParams.get('more') || undefined });
  const keys = res.keys.filter(ofApp);
  for (let n = 1; want && keys.length < 200 && !res.list_complete && n < 5; n++) {
    res = await env.REPORTS.list({ prefix: 'r:', limit: 200, cursor: res.cursor });
    keys.push(...res.keys.filter(ofApp));
  }
  const rows = keys.map((k) => {
    const m = k.metadata || {};
    const id = k.name.slice(2);
    return `<tr><td>${esc((m.time || '').replace('T', ' ').slice(0, 16))}</td><td>${esc(APPS[m.app || DEFAULT_APP] || m.app)}</td><td class="${m.kind === 'problem' ? 'p' : 'c'}">${esc(m.kind || '')}</td><td>${esc(m.version || '')}</td><td><a href="/r/${id}">${esc(m.title || '(no text)')}</a>${m.shot ? ' 🖼' : ''}</td></tr>`;
  }).join('');
  const q = want ? '&app=' + want : '';
  const more = res.list_complete ? '' : `<p><a href="/?more=${encodeURIComponent(res.cursor)}${q}">Older…</a></p>`;
  const tab = (a, label) => (a === want ? `<b>${label}</b>` : `<a href="${a ? '/?app=' + a : '/'}">${label}</a>`);
  const filter = `<p>Show: ${tab('', 'All')} · ${Object.entries(APPS).map(([a, n]) => tab(a, esc(n))).join(' · ')}</p>`;
  return html('Reports', `<h1>Reports</h1><p><a href="/counts">User counts</a></p>${filter}<p class="dim">Newest first. Each is kept ${KEEP_DAYS} days.</p><table><tr><th>Received (UTC)</th><th>App</th><th>Kind</th><th>Version</th><th>What</th></tr>${rows || '<tr><td colspan="5">None yet.</td></tr>'}</table>${more}`);
}
async function counts(env, url) {
  const t = now(env), today = Math.floor(t / DAY_MS);
  const metas = await installs(env);                        // (1 list call per 1,000 installs, both apps together)
  const closed = await closeYesterday(env, today, metas);   // (1 read, and at most 1 write a day)
  const live = bothApps(metas, today);
  const res = await env.REPORTS.list({ prefix: 'n:', limit: 1000 });   // (1 list call: the rows' numbers are in their metadata)
  const rows = res.keys.map((k) => ({ date: k.name.slice(2), apps: rowNumbers(k.metadata && k.metadata.a ? { apps: Object.fromEntries(Object.entries(k.metadata.a).map(([a, x]) => [a, { day: x[0], week: x[1], month: x[2] }])) } : (k.metadata || {})) }));
  if (closed && !rows.some((r) => r.date === closed.name.slice(2))) rows.push({ date: closed.name.slice(2), apps: rowNumbers(closed) });
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  // (the version / OS split lives in each row's value, both apps in the one value: 1 read per newest row)
  await Promise.all(rows.slice(0, DETAIL_ROWS).map(async (r) => {
    try {
      const v = JSON.parse(await env.REPORTS.get('n:' + r.date));
      for (const a of Object.keys(APPS)) { const x = v.apps ? v.apps[a] : (a === DEFAULT_APP ? v : null); if (x) { r.apps[a].byVersion = x.byVersion; r.apps[a].byOs = x.byOs; } }
    } catch (_) { /* no split */ }
  }));
  for (const r of rows) r.total = sumApps(r.apps);
  const todayRow = { date: dayDate(today), apps: live.apps };
  todayRow.total = sumApps(todayRow.apps);
  if (url.searchParams.get('format') === 'json') return new Response(JSON.stringify({ today: todayRow, days: rows }, null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const split = (o) => (o ? Object.entries(o).sort().map(([k, n]) => `${esc(k)}: ${n}`).join(', ') : '');
  const tr = (r, a, label) => `<tr><td>${esc(label || r.date)}</td><td>${r.apps[a].day}</td><td>${r.apps[a].week}</td><td>${r.apps[a].month}</td><td>${split(r.apps[a].byVersion)}</td><td>${split(r.apps[a].byOs)}</td></tr>`;
  const perApp = Object.entries(APPS).map(([a, n]) => `<h2>${esc(n)}</h2><table><tr><th>UTC date</th><th>Day</th><th>Week</th><th>Month</th><th>By version</th><th>By OS</th></tr>${tr(todayRow, a, todayRow.date + ' (so far)')}${rows.map((r) => tr(r, a)).join('')}</table>`).join('');
  const trt = (r, label) => `<tr><td>${esc(label || r.date)}</td><td>${r.total.day}</td><td>${r.total.week}</td><td>${r.total.month}</td></tr>`;
  return html('User counts', `<p><a href="/">← Reports</a> · <a href="/counts?format=json">JSON</a></p><h1>User counts</h1><p class="dim">Installs, not people; one ping per install per day, each app counted apart. Day = seen that UTC day, week = the last 7 days, month = the last 30 days. Today is still counting.</p>
    ${perApp}<h2>Both apps together</h2><table><tr><th>UTC date</th><th>Day</th><th>Week</th><th>Month</th></tr>${trt(todayRow, todayRow.date + ' (so far)')}${rows.map((r) => trt(r)).join('')}</table>`);
}
async function one(env, id) {
  const v = await env.REPORTS.get('r:' + id);
  if (!v) return text('Not found (or expired)', 404);
  const r = JSON.parse(v);
  const head = `<tr><th>app</th><td>${esc(APPS[r.client || DEFAULT_APP])}</td></tr>` + ['kind', 'version', 'runtime', 'windows', 'arch', 'time', 'received', 'uptimeMin', 'openFiles'].map((k) => r[k] != null ? `<tr><th>${k}</th><td>${esc(r[k])}</td></tr>` : '').join('') +
    (r.memoryMB ? `<tr><th>memory</th><td>${esc(r.memoryMB.total)} MB (${esc(r.memoryMB.free)} free)</td></tr>` : '');
  const block = (k) => r[k] ? `<h2>${k}</h2><pre>${esc(r[k])}</pre>` : '';
  const pic = r.hasShot ? await env.REPORTS.get('s:' + id) : null;
  const mime = pic && pic.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
  return html('Report', `<p><a href="/">← All reports</a></p><table>${head}</table>${block('text')}${block('where')}${block('message')}${block('stack')}${pic && /^[A-Za-z0-9+/=]+$/.test(pic) ? `<h2>picture</h2><img src="data:${mime};base64,${pic}">` : ''}${block('log')}
    <form method="post" action="/r/${id}/delete" onsubmit="return confirm('Delete this report?')"><button>Delete</button></form>`);
}
async function readCapped(req, max) {
  if (!req.body) return '';
  const rd = req.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await rd.cancel(); } catch (_) { /* gone */ } return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return new TextDecoder().decode(all);
}

// ---------------------------------------------------------------- bits
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const text = (t, status = 200) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
async function hash(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join(''); }
function html(title, body) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#173634;max-width:1100px}h1{margin:0 0 4px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #dfe9e7;padding:6px 8px;text-align:left;vertical-align:top}th{color:#5c7a76;font-weight:600}pre{background:#eff3f2;padding:10px;white-space:pre-wrap;word-break:break-word;max-height:480px;overflow:auto}.dim{color:#5c7a76}.p{color:#145553;font-weight:600}.c{color:#924a22;font-weight:600}img{max-width:100%;border:1px solid #dfe9e7}button{margin-top:16px}</style>${body}`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'" } });
}
