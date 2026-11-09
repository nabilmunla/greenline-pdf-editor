// The public build's report receiver: a Cloudflare Worker on the developer's own account.
//   POST /report          an anonymised report from the app (electron/anon.cjs) -> stored privately
//   GET  /                the list (password: the ADMIN_KEY secret, browser sign-in box)
//   GET  /r/<id>          one report (its picture inline);  POST /r/<id>/delete
// Setup (Cloudflare dashboard): a KV namespace bound as REPORTS, a secret ADMIN_KEY. Reports expire
// after 180 days by themselves. Nothing here is secret - the password lives in Cloudflare, not here.

const KEEP_DAYS = 180;
const MAX_BODY = 1_200_000;       // a report with its picture (the app sends a JPEG of at most 1600 px)
const PER_HOUR = 20;              // reports per address per hour
const PER_DAY = 500;              // reports a day in all (per Cloudflare location): a flood stops here
const MAX_FIELD = { where: 200, message: 2000, stack: 8000, text: 20000, log: 30000 };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/report') return req.method === 'POST' ? await receive(req, env) : text('POST only', 405);
      if (!authorised(req, env)) return new Response('Sign in', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Reports", charset="UTF-8"' } });
      if (url.pathname === '/') return await list(env, url);
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
  if (req.headers.get('x-report-client') !== 'pdf-editor') return text('Not a report', 400);
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return text('Too big', 413);
  // (simple brakes: this data centre's cache counts per address an hour, and all reports a day.
  // The address itself is never stored - only a hash of it, in the cache, for an hour)
  const ip = req.headers.get('cf-connecting-ip') || '';
  const hour = Math.floor(Date.now() / 3600000);
  const cache = caches.default;
  const count = async (key, limit, age) => {
    const ck = new Request('https://rate.local/' + key);
    const seen = Number((await (await cache.match(ck))?.text()) || 0);
    if (seen >= limit) return false;
    await cache.put(ck, new Response(String(seen + 1), { headers: { 'Cache-Control': 'max-age=' + age } }));
    return true;
  };
  if (!(await count(await hash(ip + '|' + hour), PER_HOUR, 3600))) return text('Too many reports - try again later', 429);
  if (!(await count('day-' + Math.floor(hour / 24), PER_DAY, 86400))) return text('Too many reports today - try again tomorrow', 429);

  // (read up to the limit - a request without a length is not read whole first)
  const raw = await readCapped(req, MAX_BODY);
  if (raw === null) return text('Too big', 413);
  let r;
  try { r = JSON.parse(raw); } catch (_) { return text('Not a report', 400); }
  if (!r || typeof r !== 'object' || !['crash', 'problem'].includes(r.kind) || !/^\d+\.\d+\.\d+$/.test(String(r.version || ''))) return text('Not a report', 400);
  const rep = {
    kind: r.kind, app: str(r.app, 40), version: str(r.version, 20), runtime: str(r.runtime, 20), windows: str(r.windows, 40), arch: str(r.arch, 10),
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
  await env.REPORTS.put('r:' + id, JSON.stringify({ ...rep, hasShot }), { ...ttl, metadata: { kind: rep.kind, version: rep.version, time: rep.received, title, shot: hasShot } });
  return text('Thanks', 200);
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
  const res = await env.REPORTS.list({ prefix: 'r:', limit: 200, cursor: url.searchParams.get('more') || undefined });
  const rows = res.keys.map((k) => {
    const m = k.metadata || {};
    const id = k.name.slice(2);
    return `<tr><td>${esc((m.time || '').replace('T', ' ').slice(0, 16))}</td><td class="${m.kind === 'problem' ? 'p' : 'c'}">${esc(m.kind || '')}</td><td>${esc(m.version || '')}</td><td><a href="/r/${id}">${esc(m.title || '(no text)')}</a>${m.shot ? ' 🖼' : ''}</td></tr>`;
  }).join('');
  const more = res.list_complete ? '' : `<p><a href="/?more=${encodeURIComponent(res.cursor)}">Older…</a></p>`;
  return html('Reports', `<h1>Reports</h1><p class="dim">Newest first. Each is kept ${KEEP_DAYS} days.</p><table><tr><th>Received (UTC)</th><th>Kind</th><th>Version</th><th>What</th></tr>${rows || '<tr><td colspan="4">None yet.</td></tr>'}</table>${more}`);
}
async function one(env, id) {
  const v = await env.REPORTS.get('r:' + id);
  if (!v) return text('Not found (or expired)', 404);
  const r = JSON.parse(v);
  const head = ['kind', 'version', 'runtime', 'windows', 'arch', 'time', 'received', 'uptimeMin', 'openFiles'].map((k) => r[k] != null ? `<tr><th>${k}</th><td>${esc(r[k])}</td></tr>` : '').join('') +
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
