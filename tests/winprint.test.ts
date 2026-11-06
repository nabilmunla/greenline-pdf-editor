// Windows' default printer, read from the registry (Electron's printer list has no "default" mark
// since Electron 36 - the Print dialog offered the first printer of the list)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { defaultFromReg, markDefault } = require('../electron/winprint.cjs');

test('the Device value of reg query gives the printer name', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows\r\n    Device    REG_SZ    KONICA MINOLTA C300i (Office 2),winspool,Ne03:\r\n\r\n';
  assert.equal(defaultFromReg(out), 'KONICA MINOLTA C300i (Office 2)');
  assert.equal(defaultFromReg('    Device    REG_SZ    \\\\PRINTSRV01\\Plotter-A0,winspool,Ne02:\r\n'), '\\\\PRINTSRV01\\Plotter-A0');
  assert.equal(defaultFromReg('ERROR: The system was unable to find the specified registry key or value.'), '');
  assert.equal(defaultFromReg(''), '');
});

test('the default printer is marked in the list (any case), only that one', () => {
  const l = [{ name: 'Fax' }, { name: 'Microsoft Print to PDF' }, { name: '\\\\PRINTSRV01\\Plotter-A0' }];
  const m = markDefault(l, '\\\\printsrv01\\plotter-a0');
  assert.deepEqual(m.map((p) => p.isDefault), [false, false, true]);
  assert.deepEqual(markDefault(l, '').map((p) => p.isDefault), [false, false, false]);
});

test('the job asks for its paper with Windows\' paper code (A3 came out A4: Electron passed only a width and height)', () => {
  const { mediaSizeFor } = require('../electron/winprint.cjs');
  const MM = 72 / 25.4;
  // A3 landscape sheet (either way round): A3 portrait size + code 8
  const a3 = mediaSizeFor(420 * MM, 297 * MM);
  assert.equal(a3.vendor_id, '8');
  assert.equal(a3.name, 'ISO_A3');
  assert.equal(a3.width_microns, 297000);
  assert.equal(a3.height_microns, 420000);
  assert.equal(a3.imageable_area_top_microns, 420000);
  // the app's own A4 (595.28 x 841.89 pt) and the American ones
  assert.equal(mediaSizeFor(595.28, 841.89).vendor_id, '9');
  assert.equal(mediaSizeFor(612, 792).vendor_id, '1');
  assert.equal(mediaSizeFor(792, 1224).vendor_id, '3');
  assert.equal(mediaSizeFor(1190.55, 1683.78).vendor_id, '66');
  // A1 / A0 have no standard code; an odd page size: its size alone, as before
  const a1 = mediaSizeFor(1683.78, 2383.94);
  assert.equal(a1.vendor_id, undefined);
  assert.equal(a1.name, 'CUSTOM');
  assert.equal(a1.width_microns, 594000);
  assert.equal(mediaSizeFor(500, 700).vendor_id, undefined);
});
