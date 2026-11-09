// Anonymous reports (anon.cjs): what leaves the PC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scrub, anonymize } = require('../electron/anon.cjs');
const who = { user: 'jdoe', pc: 'DESKTOP-7Q2X' };

test('paths, file names, user and PC names come out of messages and logs', () => {
  const s = scrub(`Error: ENOENT open 'C:\\Users\\jdoe\\Desktop\\Tower B GA.pdf' at \\\\server\\Tenders\\T1\\x.pdf; /home/jdoe/a.pdf file:///D:/x/y.pdf "Sheet 3 - MEP.dwg" bill.xlsx on DESKTOP-7Q2X`, who);
  for (const bad of ['jdoe', 'Tower B', 'Tenders', 'Desktop', 'DESKTOP-7Q2X', 'bill.xlsx', 'MEP.dwg', 'x/y']) assert.ok(!s.includes(bad), bad + ' left in: ' + s);
  assert.ok(s.includes('<path>') && s.includes('<file>') && s.includes('<pc>'));
  assert.equal(scrub('at render (app://dist/assets/index.js:12:5)', who), 'at render (app://dist/assets/index.js:12:5)', 'code locations stay');
});

test('names and paths with spaces go whole; the app\'s own code locations stay', () => {
  const w = { user: 'jdoe', pc: 'DESKTOP-7Q2X', words: ['Tower B GA.pdf', 'Project Falcon'] };
  assert.equal(scrub('opened Tower B GA.pdf: 3 pages', w), 'opened <file>: 3 pages');
  assert.ok(!/Drawing|Rev 2/.test(scrub('opened Other Drawing Rev 2.pdf: 3 pages', w)), 'an unknown name with spaces');
  const p = scrub(`save failed: EPERM 'C:\\Users\\John Smith\\OneDrive - ACME Ltd\\Bids\\Project Falcon\\BOQ rev 3.pdf' at x`, w);
  for (const bad of ['Smith', 'ACME', 'Bids', 'Falcon', 'BOQ']) assert.ok(!p.includes(bad), bad + ' left in: ' + p);
  assert.equal(scrub('at load (C:\\Users\\John Smith\\AppData\\Local\\Programs\\PDF Editor\\resources\\app\\electron\\main.cjs:12:5)', w), 'at load (<app>/electron\\main.cjs:12:5)');
  for (const t of ['\\\\srv\\Tenders 2026\\x y.pdf', '/home/john smith/a.pdf', 'unquoted C:\\Users\\John Smith\\Desktop\\a b.pdf']) assert.ok(!/smith|Tenders|a b/i.test(scrub(t, w)), t);
});

test('a report keeps only what is needed; the time to the hour; the person\'s words as typed', () => {
  const rep = { kind: 'problem', app: 'PDF Editor', version: '0.9.2', runtime: '44.10.2', windows: '10.0.22631', arch: 'x64', user: 'jdoe', pc: 'DESKTOP-7Q2X',
    memoryMB: { total: 16000, free: 4000 }, uptimeMin: 12, time: '2026-11-06T12:34:56.000Z', text: 'The ruler is upside down on page 3 (I am jdoe)', openFiles: 2,
    screenshot: 'x.png', log: Array.from({ length: 300 }, (_, i) => `line ${i} C:\\Users\\jdoe\\a.pdf`).join('\n') };
  const a = anonymize(rep, who);
  assert.deepEqual(Object.keys(a).sort(), ['app', 'arch', 'kind', 'log', 'memoryMB', 'openFiles', 'runtime', 'text', 'time', 'uptimeMin', 'version', 'windows'].sort());
  assert.equal(a.time, '2026-11-06T12:00:00.000Z');
  assert.equal(a.text, 'The ruler is upside down on page 3 (I am <user>)');
  assert.equal(a.log.split('\n').length, 120);
  assert.ok(!JSON.stringify(a).includes('jdoe') && !JSON.stringify(a).includes('DESKTOP-7Q'));
  assert.equal(anonymize({ kind: 'weird' }).kind, 'crash', 'only two kinds');
});
