// PLAN 13.2.4 (F16): Print › Save as PDF never compared the chosen name with the open PDF's own
// file (Export and the batch dialogs do), so the original could be replaced by the print version
// while its tab still held the old document and believed it saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { samePath } from '../src/ui/dlgutil';

test('the same file however it is written: case, slashes, "." and ".." steps', () => {
  assert.ok(samePath('C:\\Jobs\\A\\plan.pdf', 'c:/jobs/a/PLAN.PDF'));
  assert.ok(samePath('C:\\Jobs\\A\\..\\A\\.\\plan.pdf', 'C:\\Jobs\\A\\plan.pdf'));
  assert.ok(samePath('\\\\srv\\share\\x\\..\\plan.pdf', '//srv/share/plan.pdf'));
  assert.ok(!samePath('C:\\Jobs\\A\\plan.pdf', 'C:\\Jobs\\A\\plan (print).pdf'));
  assert.ok(!samePath('C:\\Jobs\\A\\plan.pdf', 'C:\\Jobs\\B\\plan.pdf'));
});

test('Print › Save as PDF refuses the open PDF itself before anything is written', () => {
  const src = readFileSync(new URL('../src/ui/PrintDlg.tsx', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('const savePdf = async'), src.indexOf('gcc.commit(m.path, to)'));
  assert.ok(/samePath\(to, doc\.path\)/.test(fn), 'the chosen name is compared with the open file');
  assert.ok(fn.indexOf('samePath(to, doc.path)') < fn.indexOf('make(true)'), 'before the PDF is made');
});

test('(review) and refuses a file open in another tab too', () => {
  const src = readFileSync(new URL('../src/ui/PrintDlg.tsx', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('const savePdf = async'), src.indexOf('gcc.commit(m.path, to)'));
  assert.ok(/p\.openPaths\.some\(\(x\) => samePath\(to, x\)\)/.test(fn), 'every open tab is compared');
  assert.ok(fn.indexOf('p.openPaths') < fn.indexOf('make(true)'), 'before the PDF is made');
  const dlg = readFileSync(new URL('../src/ui/Dialogs.tsx', import.meta.url), 'utf8');
  assert.match(dlg, /<PrintDlg [^>]*openPaths=\{/, 'Dialogs passes the open tabs');
});

test('Print › cancelling Save as PDF says the PDF was stopped, not the print', () => {
  const src = readFileSync(new URL('../src/ui/PrintDlg.tsx', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('const savePdf = async'), src.indexOf('gcc.commit(m.path, to)'));
  assert.doesNotMatch(fn, /The print was stopped/);
  assert.match(fn, /Saving the PDF was stopped\./);
});
