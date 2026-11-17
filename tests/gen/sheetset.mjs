// Generated drawing sets with a JSON truth - test data for "Link the sheets" (7.3). MuPDF makes the
// files; the truth is read back from the finished file (structured text words and their boxes), so it
// matches the bytes. Invented numbers only. Deterministic: a fixed seed per set, no dates, no random.
//
//   node tests/gen/sheetset.mjs [outdir]     writes set-a / set-b / set-c / set-mixed (.pdf + .truth.json)
//
// Truth (JSON): { set, pages: [{ page, size, w, h, kind: 'sheet'|'spec', no, title, noBox }],
//   refs: [{ page, text, box, target, kind: 'callout'|'bubble'|'refer'|'list', existing? }],
//   decoys: [{ page, text, kind }], existing: { links: [...], bookmarks: [...] } }
// Pages are 0-based; boxes are [x0,y0,x1,y1] in points, page space as shown (origin top-left, y down).
// A sheet with no title block has no: null. Two sheets with one number: the truth target is the first.
import * as mupdf from 'mupdf';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MM = 72 / 25.4;
const mm = (v) => v * MM;
const SIZES = { A1: [2384, 1684], A3: [1191, 842], A4: [595, 842] };
const PROJECT = 'PRJ-2603';
const CLIENT = ['NORTHGATE DEVELOPMENTS', 'HARBOUR DESIGN STUDIO'];
const n2 = (n) => (Math.abs(n) < 0.005 ? 0 : n).toFixed(2);
const esc = (s) => s.replace(/[\\()]/g, '\\$&');

// ---------------------------------------------------------------- random, fonts
function rng(seed) {
  let a = seed | 0;
  const next = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (n) => Math.floor(next() * n);
  const pick = (arr) => arr[int(arr.length)];
  const shuffle = (arr) => { const o = arr.slice(); for (let i = o.length - 1; i > 0; i--) { const j = int(i + 1); [o[i], o[j]] = [o[j], o[i]]; } return o; };
  return { next, int, pick, shuffle };
}
const FONTS = { F1: new mupdf.Font('Helvetica'), F2: new mupdf.Font('Helvetica-Bold') };
const WC = { F1: new Map(), F2: new Map() };
/** width of a string in points */
function tw(s, size, fk = 'F1') {
  let w = 0;
  for (const ch of s) {
    let a = WC[fk].get(ch);
    if (a === undefined) { a = FONTS[fk].advanceGlyph(FONTS[fk].encodeCharacter(ch)); WC[fk].set(ch, a); }
    w += a;
  }
  return w * size;
}

// ---------------------------------------------------------------- the page canvas
class Cv {
  constructor(W, H) { this.W = W; this.H = H; this.ops = ['0.5 w']; this.marks = []; }
  /** text at (x, baseline y), points, y down; word: the word of s to remember (a number, a reference) */
  put(s, x, y, size, o = {}) {
    const fk = o.bold ? 'F2' : 'F1';
    this.ops.push(`BT /${fk} ${n2(size)} Tf 1 0 0 1 ${n2(x)} ${n2(this.H - y)} Tm (${esc(s)}) Tj ET`);
    if (o.mark) {
      const word = o.mark.word, at = s.indexOf(word);
      this.marks.push({ ...o.mark, x: x + tw(s.slice(0, at), size, fk), y, size, fk, w: tw(word, size, fk) });
    }
  }
  line(x0, y0, x1, y1) { this.ops.push(`${n2(x0)} ${n2(this.H - y0)} m ${n2(x1)} ${n2(this.H - y1)} l S`); }
  rect(x, y, w, h) { this.ops.push(`${n2(x)} ${n2(this.H - y - h)} ${n2(w)} ${n2(h)} re S`); }
  circle(cx, cy, r) {
    const k = 0.5523 * r, H = this.H, y = H - cy;
    this.ops.push(`${n2(cx + r)} ${n2(y)} m ${n2(cx + r)} ${n2(y + k)} ${n2(cx + k)} ${n2(y + r)} ${n2(cx)} ${n2(y + r)} c ${n2(cx - k)} ${n2(y + r)} ${n2(cx - r)} ${n2(y + k)} ${n2(cx - r)} ${n2(y)} c ${n2(cx - r)} ${n2(y - k)} ${n2(cx - k)} ${n2(y - r)} ${n2(cx)} ${n2(y - r)} c ${n2(cx + k)} ${n2(y - r)} ${n2(cx + r)} ${n2(y - k)} ${n2(cx + r)} ${n2(y)} c S`);
  }
  gray(g) { this.ops.push(`${g} G`); }
  width(w) { this.ops.push(`${w} w`); }
  stream() { return this.ops.join('\n'); }
}

// ---------------------------------------------------------------- titles and numbers
const POOL = {
  AR: ['GROUND FLOOR PLAN', 'FIRST FLOOR PLAN', 'SECOND FLOOR PLAN', 'THIRD FLOOR PLAN', 'TYPICAL UPPER FLOOR PLAN', 'ROOF PLAN', 'REFLECTED CEILING PLAN', 'BUILDING ELEVATIONS NORTH AND EAST', 'BUILDING ELEVATIONS SOUTH AND WEST', 'BUILDING SECTIONS A-A AND B-B', 'STAIR CORE PLANS AND SECTIONS', 'WALL TYPES AND FIRE RATINGS', 'DOOR AND WINDOW SCHEDULE', 'FACADE DETAILS', 'LIFT LOBBY FINISHES', 'PARKING LAYOUT'],
  S: ['FOUNDATION LAYOUT', 'PILE CAP SCHEDULE', 'GROUND SLAB REINFORCEMENT', 'FIRST FLOOR FRAMING PLAN', 'SECOND FLOOR FRAMING PLAN', 'COLUMN SCHEDULE', 'SHEAR WALL DETAILS', 'ROOF FRAMING PLAN', 'STAIR AND RAMP REINFORCEMENT', 'TYPICAL CONNECTION DETAILS', 'RETAINING WALL SECTIONS', 'EXPANSION JOINT DETAILS'],
  M: ['CHILLED WATER SCHEMATIC', 'GROUND FLOOR DUCT LAYOUT', 'FIRST FLOOR DUCT LAYOUT', 'VENTILATION RISER DIAGRAM', 'PLANT ROOM LAYOUT', 'ROOF EQUIPMENT PLAN', 'PLUMBING RISER DIAGRAM', 'DRAINAGE LAYOUT GROUND FLOOR', 'FIRE FIGHTING SCHEMATIC', 'PUMP ROOM DETAILS'],
  E: ['POWER LAYOUT GROUND FLOOR', 'LIGHTING LAYOUT GROUND FLOOR', 'POWER LAYOUT FIRST FLOOR', 'LIGHTING LAYOUT FIRST FLOOR', 'SINGLE LINE DIAGRAM', 'DISTRIBUTION BOARD SCHEDULE', 'FIRE ALARM LAYOUT', 'LV ROOM LAYOUT AND DETAILS', 'EARTHING AND LIGHTNING PROTECTION', 'CABLE TRAY ROUTES'],
};
/** n unique titles from a pool: the pool, then the pool again with a level added */
function titlesFor(key, n) {
  const pool = POOL[{ ST: 'S', ME: 'M', EL: 'E' }[key] || key];
  const out = [];
  for (let i = 0; i < n; i++) out.push(i < pool.length ? pool[i] : `${pool[i % pool.length]} - LEVEL ${String(1 + Math.floor(i / pool.length)).padStart(2, '0')}`);
  return out;
}
/** a title in one or two lines (two when it is long: at the space nearest the middle) */
function splitTitle(t) {
  if (t.length <= 24) return [t];
  const mid = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? [t] : [t.slice(0, best), t.slice(best + 1)];
}

// ---------------------------------------------------------------- the sets (what is on each page)
function plan(name) {
  const pages = [];
  const sheet = (size, layout, no, title, extra = {}) => pages.push({ kind: 'sheet', size, layout, no, title, ...extra });
  const series = (size, layout, disc, start, n, key, fmt) => { const t = titlesFor(key || disc, n); for (let i = 0; i < n; i++) sheet(size, layout, fmt ? fmt(disc, start + i) : `${disc}-${start + i}`, t[i]); };
  let absent = ['AR-999', 'S-901', 'M-350'], pre = 'AR';
  if (name === 'A') {
    sheet('A1', 'right', 'G-001', 'COVER SHEET AND DRAWING LIST', { cover: true });
    series('A1', 'right', 'AR', 101, 12);
    series('A1', 'right', 'S', 201, 10);
    series('A1', 'right', 'M', 301, 9);
    series('A1', 'right', 'E', 401, 8);
    // (the sheet with no title block: S-208's place; two sheets with one number: M-308 carries M-307 again)
    Object.assign(pages[20], { no: null, title: null, layout: 'none' });
    pages[30].no = pages[29].no;
    absent = ['AR-999', 'S-901', 'S-208', 'M-350'];
  } else if (name === 'B') {
    series('A3', 'bottom', 'A', 101, 14, 'AR');
    series('A3', 'bottom', 'S', 201, 10);
    series('A3', 'bottom', 'M', 301, 8);
    series('A3', 'bottom', 'E', 401, 8);
    absent = ['A-999', 'S-901', 'E-777'];
  } else if (name === 'C') {
    for (const [d, base] of [['AR', 10101], ['ST', 20101], ['ME', 30101], ['EL', 40101]]) series('A1', 'right', d, base, 80, d, (dd, k) => `PRJ-AB1-DWG-${dd}-${k}`);
    absent = ['AR-19999', 'ST-29999', 'ME-39999'];
  } else if (name === 'mixed') {
    series('A1', 'right', 'AR', 101, 12);
    for (let i = 0; i < 30; i++) pages.push({ kind: 'spec', size: 'A4', layout: 'none', no: null, title: null, n: i });
    series('A3', 'bottom', 'S', 201, 12);
    absent = ['AR-199', 'S-299'];
  } else if (name === 'password') {
    series('A3', 'bottom', 'E', 101, 8);
    absent = ['E-199'];
  } else if (name === 'onepage') {
    sheet('A1', 'right', 'AR-101', 'GROUND FLOOR PLAN');
    absent = ['AR-103'];
  } else throw new Error('unknown set ' + name);
  void pre;
  return { pages, absent, tail: name === 'C' };
}

// ---------------------------------------------------------------- the sheet
const AREA = { A1: { x0: 40, y0: 30, x1: 660, y1: 495, cols: 5, rows: 4, ts: 14 }, A3: { x0: 22, y0: 25, x1: 288, y1: 232, cols: 4, rows: 4, ts: 9 } };

function titleBlock(cv, P, S, R) {
  const { W, H } = cv;
  const date = R.pick(['12.10.2026', '12.10.2026', '12.10.2026', '05.10.2026', '28.09.2026']);
  const rev = R.pick(['C02', 'C02', 'C02', 'C01', 'C03']);
  const scale = R.pick(['1:100', '1:100', '1:50', '1:200']);
  const lines = splitTitle(P.title);
  const long = P.no.length > 12;
  cv.width(1);
  if (P.layout === 'right') {
    const x0 = W - mm(150), xi = x0 + mm(8);
    cv.rect(x0, H - mm(185), mm(140), mm(175));
    for (const d of [156, 136, 116, 84, 70, 34]) cv.line(x0, H - mm(d), x0 + mm(140), H - mm(d));
    cv.line(xi + mm(45), H - mm(136), xi + mm(45), H - mm(116));
    cv.line(xi + mm(90), H - mm(136), xi + mm(90), H - mm(116));
    cv.put(CLIENT[0], xi, H - mm(170), 10, { bold: true });
    cv.put(CLIENT[1], xi, H - mm(162), 8);
    cv.put('PROJECT NO', xi, H - mm(150), 7);
    cv.put(PROJECT, xi, H - mm(141), 14);
    cv.put('DATE', xi, H - mm(130), 7); cv.put(date, xi, H - mm(121), 12);
    cv.put('SCALE', xi + mm(47), H - mm(130), 7); cv.put(scale, xi + mm(47), H - mm(121), 12);
    cv.put('REV', xi + mm(92), H - mm(130), 7); cv.put(rev, xi + mm(92), H - mm(121), 12);
    cv.put('TITLE', xi, H - mm(110), 7);
    const ts = 15;
    lines.forEach((l, i) => cv.put(l, xi, H - mm(100) + i * 1.6 * ts, ts, { mark: { kind: 'title', word: l.split(' ')[0] } }));
    cv.put('DRAWING NUMBER', xi, H - mm(64), 7);
    cv.put(P.no, xi, H - mm(48), long ? 16 : 28, { bold: true, mark: { kind: 'no', word: P.no } });
    cv.put('STATUS', xi, H - mm(28), 7); cv.put('FOR CONSTRUCTION', xi, H - mm(21), 10);
    // (a key plan in the strip's upper part)
    cv.rect(x0 + mm(10), mm(40), mm(120), mm(90));
    for (let i = 0; i < 12; i++) cv.line(x0 + mm(10 + R.int(100)), mm(40 + R.int(80)), x0 + mm(20 + R.int(100)), mm(50 + R.int(80)));
  } else {
    const y0 = H - mm(50);
    cv.rect(mm(10), y0, W - mm(20), mm(40));
    for (const x of [66, 186, 221, 251, 296]) cv.line(mm(x), y0, mm(x), H - mm(10));
    cv.put('PROJECT NO', mm(14), H - mm(43), 6); cv.put(PROJECT, mm(14), H - mm(36), 11);
    cv.put(CLIENT[0], mm(14), H - mm(24), 6, { bold: true }); cv.put(CLIENT[1], mm(14), H - mm(19), 5.5);
    cv.put('TITLE', mm(70), H - mm(43), 6);
    lines.forEach((l, i) => cv.put(l, mm(70), H - mm(36) + i * 1.6 * 12, 12, { mark: { kind: 'title', word: l.split(' ')[0] } }));
    cv.put('DATE', mm(190), H - mm(43), 6); cv.put(date, mm(190), H - mm(36), 10);
    cv.put('SCALE', mm(225), H - mm(43), 6); cv.put(scale, mm(225), H - mm(36), 10);
    cv.put('REV', mm(255), H - mm(43), 6); cv.put(rev, mm(255), H - mm(36), 10);
    cv.put('DRAWING NUMBER', mm(300), H - mm(43), 6);
    cv.put(P.no, mm(300), H - mm(28), 22, { bold: true, mark: { kind: 'no', word: P.no } });
  }
  cv.width(0.5);
}

/** a reference as it is written: the whole number, or its end after the project part (long numbers) */
function refText(no, form) { return form === 'tail' ? no.split('-').slice(-2).join('-') : no; }

function drawSheet(P, S, R, refs, decoys) {
  const [W, H] = SIZES[P.size];
  const cv = new Cv(W, H);
  const A = AREA[P.size];
  // frame, grid, rooms, hatching: a few hundred lines
  cv.rect(mm(10), mm(10), W - mm(20), H - mm(20));
  cv.gray(0.3);
  const ax0 = mm(A.x0), ay0 = mm(A.y0), aw = mm(A.x1 - A.x0), ah = mm(A.y1 - A.y0);
  for (let i = 0; i <= 8; i++) cv.line(ax0 + (aw * i) / 8, ay0, ax0 + (aw * i) / 8, ay0 + ah);
  for (let i = 0; i <= 5; i++) cv.line(ax0, ay0 + (ah * i) / 5, ax0 + aw, ay0 + (ah * i) / 5);
  for (let i = 0; i < 40; i++) { const x = ax0 + R.next() * aw * 0.8, y = ay0 + R.next() * ah * 0.8, w = (0.05 + R.next() * 0.15) * aw, h = (0.05 + R.next() * 0.15) * ah; cv.rect(x, y, w, h); }
  cv.gray(0.6);
  for (let i = 0; i < 100; i++) { const x = ax0 + R.next() * aw * 0.9, y = ay0 + R.next() * ah * 0.9, d = mm(6 + R.int(30)); cv.line(x, y, x + d, y + (R.int(2) ? d : 0)); }
  cv.gray(0);
  if (P.layout !== 'none') titleBlock(cv, P, S, R);

  // (the cover holds the drawing list instead)
  if (P.cover) return cv;
  const ts = A.ts;
  // what goes into the drawing area: references, then noise that must not link
  const items = [];
  const refItem = (r) => {
    const word = refText(S.nos[r.target], r.form);
    const mk = { kind: 'ref', variant: r.kind, target: r.target, word, text: word };
    if (r.kind === 'bubble') {
      const sz = ts * 0.9, rad = Math.max(tw(word, sz) / 2 + 0.4 * sz, 1.5 * sz);
      items.push({ w: 2 * rad, h: 2 * rad, draw: (x, y) => {
        const cx = x + rad, cy = y + rad;
        cv.circle(cx, cy, rad); cv.line(cx - rad, cy, cx + rad, cy);
        const dn = String(1 + R.int(9));
        cv.put(dn, cx - tw(dn, sz) / 2, cy - 0.25 * sz, sz);
        cv.put(word, cx - tw(word, sz) / 2, cy + 1.05 * sz, sz, { mark: mk });
      } });
    } else {
      const s = (r.kind === 'refer' ? 'REFER TO DWG. ' : 'SEE ') + word;
      items.push({ w: tw(s, ts), h: 1.4 * ts, draw: (x, y) => cv.put(s, x, y + 1.1 * ts, ts, { mark: mk }) });
    }
  };
  for (const r of refs) refItem(r);
  const textItem = (s, kind) => { items.push({ w: tw(s, ts), h: 1.4 * ts, draw: (x, y) => cv.put(s, x, y + 1.1 * ts, ts) }); decoys.push({ text: s, kind }); };
  if (R.next() < 0.45) { const a = R.pick(S.absent); textItem((R.int(2) ? 'REFER TO DWG. ' : 'SEE ') + a, 'absent'); }
  const rooms = P.size === 'A1' ? 3 + R.int(3) : 2 + R.int(2);
  for (let i = 0; i < rooms; i++) {
    const rn = String(101 + R.int(8) * 100 + R.int(30));
    items.push({ w: tw(rn, ts) + 0.8 * ts, h: 1.8 * ts, draw: (x, y) => { cv.rect(x, y, tw(rn, ts) + 0.8 * ts, 1.8 * ts); cv.put(rn, x + 0.4 * ts, y + 1.35 * ts, ts); } });
    decoys.push({ text: rn, kind: 'room' });
  }
  textItem(R.pick(['LEVEL 02', 'LEVEL 03', 'LEVEL 04', 'GROUND LEVEL']), 'level');
  textItem('FFL +' + (3 + R.int(20) * 0.5).toFixed(3), 'level');
  textItem(String(R.pick([3500, 6500, 7200, 9000, 12000, 15000])), 'dimension');
  textItem(String(R.pick([2400, 4800, 8100, 11000, 13500])), 'dimension');
  if (R.next() < 0.5) textItem('REFER TO GENERAL NOTES ' + PROJECT, 'project');
  const cw = mm(A.x1 - A.x0) / A.cols, ch = mm(A.y1 - A.y0) / A.rows;
  const order = R.shuffle([...Array(A.cols * A.rows).keys()]);
  items.forEach((it, i) => {
    const s = order[i];
    if (s === undefined) return;
    const cx = ax0 + (s % A.cols) * cw, cy = ay0 + Math.floor(s / A.cols) * ch;
    it.draw(cx + R.next() * Math.max(0, cw - it.w - 4), cy + R.next() * Math.max(0, ch - it.h - 4));
  });
  return cv;
}

// ---------------------------------------------------------------- the cover's drawing list (set A)
function drawList(cv, rows, ts = 13) {
  cv.put('DRAWING LIST', mm(40), mm(55), 22, { bold: true });
  cv.put('DWG NO', mm(45), mm(68), 8); cv.put('TITLE', mm(100), mm(68), 8);
  cv.put('DWG NO', mm(360), mm(68), 8); cv.put('TITLE', mm(415), mm(68), 8);
  rows.forEach((r, i) => {
    const col = Math.floor(i / 19), row = i % 19;
    const x = mm(45 + col * 315), y = mm(80 + row * 21);
    cv.put(r.no, x, y, ts, { mark: { kind: 'ref', variant: 'list', target: r.page, word: r.no, text: r.no } });
    cv.put(r.title, x + mm(55), y, ts);
    cv.line(x, y + 4, x + mm(300), y + 4);
  });
}

// ---------------------------------------------------------------- a specification page (mixed set)
const VOCAB = 'the contractor shall provide and install all door hardware in accordance with manufacturer instructions approved samples submitted prior to ordering work coordinated finishes as scheduled locks hinges closers fixings stainless steel fire rated assemblies tested certified delivery storage protection site engineer approval warranty period defects rectified at no cost employer sealant primer substrate surfaces cleaned inspected recorded handed over'.split(' ');
const SECTIONS = ['08 71 00', '08 11 13', '09 91 00', '26 05 00', '03 30 00'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function drawSpec(P, R) {
  const [W, H] = SIZES.A4;
  const cv = new Cv(W, H);
  const sec = SECTIONS[Math.floor(P.n / 6)], pg = (P.n % 6) + 1;
  cv.put(PROJECT + ' / SPECIFICATION', 380, 45, 8);
  cv.put('SECTION ' + sec, 72, 70, 12, { bold: true });
  let y = 100;
  const wrap = (words, max) => { const out = []; let cur = ''; for (const w of words) { if ((cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; } if (cur) out.push(cur); return out; };
  while (y < 740) {
    const clause = `${1 + R.int(4)}.${1 + R.int(6)}.${1 + R.int(9)}`;
    const n = 8 + R.int(40), words = [];
    for (let i = 0; i < n; i++) words.push(R.pick(VOCAB));
    const k = R.int(10);
    if (k === 0) words.push('as', 'issued', 'on', `${1 + R.int(28)} ${R.pick(MONTHS)} 2026`);
    else if (k === 1) words.push('(' + `2026-${String(1 + R.int(12)).padStart(2, '0')}-${String(1 + R.int(28)).padStart(2, '0')}` + ')');
    else if (k === 2) words.push('see', 'clause', `${1 + R.int(4)}.${1 + R.int(6)}.${1 + R.int(9)}`, 'and', 'Section', R.pick(SECTIONS));
    const lines = wrap(words, 78);
    lines.forEach((l, i) => { if (y < 750) { if (i === 0) cv.put(clause, 72, y, 10); cv.put(l, 110, y, 10); y += 13.5; } });
    y += 6;
  }
  cv.put('SECTION ' + sec + ' - ' + pg, (W - tw('SECTION ' + sec + ' - ' + pg, 9)) / 2, 810, 9);
  return cv;
}

// ---------------------------------------------------------------- reading a page back
/** one char per box: { text, box } for the reader (a '\n' with NaN boxes between lines), points, y down */
export function pageChars(page) {
  const text = []; const box = [];
  const st = page.toStructuredText('');
  try {
    st.walk({
      beginLine() { if (text.length) { text.push('\n'); box.push(NaN, NaN, NaN, NaN); } },
      onChar(c, _o, _f, _s, q) {
        const b = [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];
        for (const u of c) { text.push(u); box.push(...b); }
      },
    });
  } finally { st.destroy?.(); }
  return { text: text.join(''), box };
}
/** the words of a page with their boxes */
export function pageWords(page) {
  const { text, box } = pageChars(page);
  const words = [];
  let cur = '', b = null;
  const end = () => { if (cur) words.push({ s: cur, box: b }); cur = ''; b = null; };
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) { end(); continue; }
    const x0 = box[i * 4], y0 = box[i * 4 + 1], x1 = box[i * 4 + 2], y1 = box[i * 4 + 3];
    cur += text[i];
    b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
  }
  end();
  return words;
}
const r2 = (b) => b.map((v) => Math.round(v * 100) / 100);

/** the word the mark was written as: the nearest word of that text to where it was put */
function find(words, m) {
  const cx = m.x + m.w / 2, cy = m.y - 0.39 * m.size;
  let best = null, bd = Infinity;
  for (const w of words) {
    if (w.s !== m.word) continue;
    const d = Math.hypot((w.box[0] + w.box[2]) / 2 - cx, (w.box[1] + w.box[3]) / 2 - cy);
    if (d < bd) { bd = d; best = w; }
  }
  if (!best || bd > Math.max(m.size, 10)) throw new Error(`generator: "${m.word}" not read back near (${m.x.toFixed(0)}, ${m.y.toFixed(0)})`);
  return best;
}

// ---------------------------------------------------------------- the whole set
/** build one set: { bytes, truth, ms }. name: A, B, C, mixed, password (encrypted, "test"), onepage */
export function build(name) {
  const t0 = Date.now();
  const seed = { A: 1101, B: 2202, C: 3303, mixed: 4404, password: 5505, onepage: 6606 }[name];
  const R = rng(seed);
  const { pages, absent, tail } = plan(name);
  const S = { absent, nos: pages.map((p) => p.no) };
  // first page of each number (two sheets with one number: the first)
  const first = new Map();
  pages.forEach((p, i) => { if (p.no && !first.has(p.no)) first.set(p.no, i); });
  const numbered = pages.map((p, i) => (p.kind === 'sheet' && p.no ? i : -1)).filter((i) => i >= 0);
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(FONTS.F1), F2: doc.addSimpleFont(FONTS.F2) } };
  const marksOf = [], decoys = [];
  pages.forEach((P, i) => {
    let cv;
    if (P.kind === 'spec') cv = drawSpec(P, R);
    else {
      // references: 2 to 4 sheets of this file, never this sheet's own number
      const refs = [];
      if (!P.cover) {
        const n = 2 + R.int(3), kinds = ['callout', 'bubble', 'refer'], k0 = R.int(3);
        const used = new Set();
        for (let j = 0; j < n; j++) {
          const q = numbered[R.int(numbered.length)];
          const no = pages[q].no;
          if (no === P.no || used.has(no)) continue;
          used.add(no);
          refs.push({ kind: kinds[(k0 + j) % 3], target: first.get(no), form: tail && R.next() < 0.5 ? 'tail' : 'full' });
        }
      }
      const dec = [];
      cv = drawSheet(P, S, R, refs, dec);
      decoys.push(...dec.map((d) => ({ page: i, ...d })));
      if (P.cover) {
        const rows = [], seen = new Set([P.no]);
        pages.forEach((q, j) => { if (j && q.no && !seen.has(q.no)) { seen.add(q.no); rows.push({ no: q.no, title: q.title, page: j }); } });
        S.listRows = rows;
        drawList(cv, rows);
      }
    }
    marksOf.push(cv.marks);
    doc.insertPage(-1, doc.addPage([0, 0, SIZES[P.size][0], SIZES[P.size][1]], 0, res, cv.stream()));
  });
  // set A: one existing link (over the first reference on page 2) and one existing bookmark
  const existing = { links: [], bookmarks: [] };
  if (name === 'A') {
    const m = marksOf[2].find((x) => x.kind === 'ref');
    const rect = [m.x - 2, m.y - 1.05 * m.size, m.x + m.w + 2, m.y + 0.3 * m.size];
    doc.loadPage(2).createLink(rect, '#page=' + (m.target + 1));
    existing.links.push({ page: 2, box: r2(rect), target: m.target });
    doc.outlineIterator().insert({ title: 'Architectural drawings', uri: '#page=2' });
    existing.bookmarks.push({ title: 'Architectural drawings', page: 1 });
    m.existing = true;
  }
  // (copied out: a view into MuPDF's memory goes stale when that memory grows)
  const plain = doc.saveToBuffer('').asUint8Array().slice();
  // the truth, from what MuPDF reads in the finished file
  const rd = mupdf.Document.openDocument(plain, 'application/pdf');
  const truth = { set: name, pages: [], refs: [], decoys, existing };
  pages.forEach((P, i) => {
    const words = pageWords(rd.loadPage(i));
    const e = { page: i, size: P.size, w: SIZES[P.size][0], h: SIZES[P.size][1], kind: P.kind, no: P.no, title: P.title, noBox: null };
    if (P.cover) e.cover = true;
    if (P.layout === 'none' && P.kind === 'sheet') e.noTitleBlock = true;
    for (const m of marksOf[i]) {
      const w = find(words, m);
      if (m.kind === 'no') e.noBox = r2(w.box);
      else if (m.kind === 'ref') { const r = { page: i, text: m.text, box: r2(w.box), target: m.target, kind: m.variant }; if (m.existing) r.existing = true; truth.refs.push(r); }
      else find(words, m); // (a title line: must be in the file)
    }
    truth.pages.push(e);
  });
  let bytes = plain;
  if (name === 'password') bytes = doc.saveToBuffer('encrypt=aes-256,user-password=test,owner-password=test').asUint8Array().slice();
  return { bytes, truth, ms: Date.now() - t0 };
}

export const SET_FILES = { A: 'set-a', B: 'set-b', C: 'set-c', mixed: 'set-mixed', password: 'password', onepage: 'one-page' };
/** write a set into a folder: <dir>/<file>.pdf and <file>.truth.json; returns the paths */
export function write(name, dir) {
  mkdirSync(dir, { recursive: true });
  const r = build(name);
  const pdf = resolve(dir, SET_FILES[name] + '.pdf');
  writeFileSync(pdf, r.bytes);
  writeFileSync(resolve(dir, SET_FILES[name] + '.truth.json'), JSON.stringify(r.truth));
  return { pdf, ms: r.ms, truth: r.truth };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] || fileURLToPath(new URL('../tmp-sets/', import.meta.url)));
  for (const n of ['A', 'B', 'C', 'mixed']) { const r = write(n, dir); console.log(n, r.truth.pages.length, 'pages', r.truth.refs.length, 'refs', r.ms + ' ms', r.pdf); }
}
