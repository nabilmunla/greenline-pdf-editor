// 0.13 deep ritual: the sweeps' findings that were real, one test each (failing on the code before the fix).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sheetIndex, type BandLine, type PageToks } from '../src/ui/sheets.ts';
import { writeXlsx } from '../src/ui/xlsxwrite.ts';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT = resolve(import.meta.dirname, '..');
const MM = 72 / 25.4;

/** electron/reports.cjs with its userData in `dir` */
function reportsIn(dir: string) {
  const M = Module as unknown as { _load: (name: string, ...rest: unknown[]) => unknown };
  const orig = M._load;
  M._load = function (this: unknown, name: string, ...rest: unknown[]) { return name === 'electron' ? { app: { getPath: () => dir }, utilityProcess: {} } : orig.call(this, name, ...rest); };
  try {
    return createRequire(join(ROOT, 'electron', 'x.cjs'))('./reports.cjs').create({ version: '0.13.0', readSettings: () => ({}), writeSettings() {}, log() {}, logFile: () => '', source: () => '', appName: 'PDF Editor', send() {}, endpoint: 'https://rx.example/report' });
  } finally { M._load = orig; }
}

test('1: dropQueue - a folder in the queue, or a report that can\'t be removed, does not keep the rest (they went to the public receiver)', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'sweep13-rep-'));
  try {
    const outbox = join(dir, 'reports-outbox');
    fs.mkdirSync(join(outbox, '00-a-folder', 'inside'), { recursive: true });
    fs.writeFileSync(join(outbox, '00-a-folder', 'inside', 'x.json'), 'x');
    const names = Array.from({ length: 20 }, (_, i) => `2026111${i % 10}-report${i}.json`);
    for (const n of names) fs.writeFileSync(join(outbox, n), '{}');
    fs.writeFileSync(join(outbox, 'locked.json'), '{}');
    const reports = reportsIn(dir);
    // (a report Windows won't let go of - open in a scanner: EBUSY - every time)
    const rm = fs.rmSync;
    fs.rmSync = function (p: fs.PathLike, o?: fs.RmOptions) { if (String(p).endsWith('locked.json')) { const e = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException; e.code = 'EBUSY'; throw e; } return rm(p, o); } as typeof fs.rmSync;
    try { reports.dropQueue(); } finally { fs.rmSync = rm; }
    assert.deepEqual(fs.readdirSync(outbox), ['locked.json'], 'everything else went, the folder too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('2: a sheet\'s titles - 400 band lines a page are looked at in about linear time, not every line for every line', () => {
  // (a title-like line every 2.5 mm in three columns 4 mm apart: no line goes on from another - the
  //  old search tried every line for every line, twice a page)
  const W = 841 * MM, H = 594 * MM, L = 400;
  let reads = 0;
  const line = (text: string, box: [number, number, number, number]): BandLine => ({ text, get box() { reads++; return box; } });
  const word = (i: number) => { let s = ''; do { s += String.fromCharCode(65 + (i % 26)); i = Math.floor(i / 26); } while (i); return s; };
  const pages: PageToks[] = Array.from({ length: 4 }, (_, i) => {
    const lines = Array.from({ length: L }, (_, k) => {
      const x = W - 160 * MM + (k % 3) * 4 * MM, y = H - 400 * MM + k * 2.5 * MM;
      return line(`FLOOR PLAN ${word(i * L + k)}ZONE`, [x, y, x + 40, y + 8]);
    });
    const no = `A-${101 + i}`;
    return { page: i, w: W, h: H, text: true, lines, toks: [{ raw: no, key: no, box: [W - 120 * MM, H - 40 * MM, W - 120 * MM + 50, H - 40 * MM + 12], band: true, pre: 'DWG NO' }] };
  });
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.no), ['A-101', 'A-102', 'A-103', 'A-104']);
  assert.ok(idx.sheets.every((s) => /^FLOOR PLAN [A-Z]+ZONE$/.test(s.title)), 'a title on each: ' + idx.sheets.map((s) => s.title).join(' / '));
  // (the sort alone reads about 2 L log L; the old search read 2 x L x L x 3 a page - 960,000)
  const perLine = reads / (pages.length * L);
  console.log(`   band line boxes read ${Math.round(perLine)} times a line (the old search: 4,001)`);
  assert.ok(perLine < 60, `band line boxes read ${reads.toLocaleString('en-GB')} times: ${Math.round(perLine)} a line`);
});

test('E: an Excel export of a sheet with 300,000 rows and a filter is written (the widest row was found with one argument a row)', () => {
  const rows = [['Page', 'Kind', 'Value', 'Unit'], ...Array.from({ length: 300_000 }, (_, i) => [i + 1, 'Length', i * 0.5, 'm'])];
  rows[1234].push('a note');
  const z = unzipSync(writeXlsx([{ name: 'Measurements', rows, header: 1 }]));
  assert.match(strFromU8(z['xl/worksheets/sheet1.xml'].subarray(-200)), /<autoFilter ref="A1:E300001"\/>/);
  assert.match(strFromU8(z['xl/workbook.xml']), /'Measurements'!\$A\$1:\$E\$300001</);
});
