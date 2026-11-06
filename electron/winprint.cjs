// Windows' default printer. Electron's printer list has no "default" mark since Electron 36
// (PrinterInfo is name / displayName / description / options only), so up to 0.8.6 the Print
// dialog never knew it and offered the first printer of the list (often Fax or Microsoft Print to
// PDF). Windows keeps the default printer as the person's "Device" value
// (HKCU\Software\Microsoft\Windows NT\CurrentVersion\Windows: "<printer name>,winspool,Ne01:") -
// also when "Let Windows manage my default printer" changes it (GetDefaultPrinter reads the same).
'use strict';
const KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows';

/** the printer name from `reg query <KEY> /v Device` output ('' if none) - a printer name can't
 *  hold a comma, so it is everything before the first one */
function defaultFromReg(out) {
  const m = /^\s*Device\s+REG_SZ\s+(.*?)\s*$/im.exec(String(out || ''));
  if (!m) return '';
  return m[1].split(',')[0].trim();
}

/** Windows' default printer ('' elsewhere, or when it can't be read) */
function defaultPrinter() {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((res) => {
    require('child_process').execFile('reg', ['query', KEY, '/v', 'Device'], { windowsHide: true, timeout: 5000 }, (err, so) => res(err ? '' : defaultFromReg(so)));
  });
}

/** the printers with the default one marked (by name, as Windows writes it, any case) */
function markDefault(list, name) {
  const n = String(name || '').toLowerCase();
  return list.map((p) => ({ ...p, isDefault: !!n && String(p.name).toLowerCase() === n }));
}

// ---------------------------------------------------------------- the paper a job asks for
// Electron's print() gives Windows the paper only as a width and height (dmPaperWidth / Length);
// many drivers go by the paper code (dmPaperSize) and keep their default - A3 asked, A4 came out
// with part of the drawing on it (Electron issue 31705). Chromium sets the paper code when the job's
// media size carries a vendor_id, so the job's media size is passed in full, with Windows' code for
// the standard papers (DMPAPER_*). A0 / A1 have no standard code: their size alone, as before.
const PAPER_IDS = [
  { name: 'ISO_A3', label: 'A3', w: 297, h: 420, id: 8 },
  { name: 'ISO_A4', label: 'A4', w: 210, h: 297, id: 9 },
  { name: 'ISO_A5', label: 'A5', w: 148, h: 210, id: 11 },
  { name: 'ISO_A2', label: 'A2', w: 420, h: 594, id: 66 },
  { name: 'ISO_A6', label: 'A6', w: 105, h: 148, id: 70 },
  { name: 'NA_LETTER', label: 'Letter', w: 215.9, h: 279.4, id: 1 },
  { name: 'NA_LEGAL', label: 'Legal', w: 215.9, h: 355.6, id: 5 },
  { name: 'NA_LEDGER', label: 'Tabloid', w: 279.4, h: 431.8, id: 3 },
];
const MM = 72 / 25.4;
/** the media size of a sheet (points, either way round) for webContents.print's mediaSize */
function mediaSizeFor(wPt, hPt) {
  const s = Math.min(wPt, hPt) / MM, l = Math.max(wPt, hPt) / MM;
  const um = (mm) => Math.round(mm * 1000);
  const known = PAPER_IDS.find((p) => Math.abs(p.w - s) <= 2 && Math.abs(p.h - l) <= 2);
  const w = known ? um(known.w) : um(s), h = known ? um(known.h) : um(l);
  return {
    name: known ? known.name : 'CUSTOM', custom_display_name: known ? known.label : 'Custom',
    width_microns: w, height_microns: h,
    imageable_area_left_microns: 0, imageable_area_bottom_microns: 0, imageable_area_right_microns: w, imageable_area_top_microns: h,
    ...(known ? { vendor_id: String(known.id) } : {}),
  };
}

// ---------------------------------------------------------------- the printer's own preferences
// Windows' print dialog (print with silent: false) always opens on the default printer - Electron
// can't tell it which (another printer picked in the panel showed the default one's preferences).
// The picked printer's own "Printing preferences" window instead (what Settings > Printers opens):
// tray, quality, finishing - saved for this person, used by every print to that printer from now
// on; the panel still sets paper, copies, sides and colour. rundll32 printui.dll,PrintUIEntry /e is
// Windows' own way to open it; it returns when the window closes.
function openPrefs(name) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, reason: 'Windows only' });
  const exe = require('path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
  return new Promise((res) => {
    const t0 = Date.now();
    require('child_process').execFile(exe, ['printui.dll,PrintUIEntry', '/e', '/n', String(name)], { windowsHide: false }, (err) => {
      // (gone at once with an error: it didn't open - the printer is unknown to Windows)
      if (err && Date.now() - t0 < 1500) res({ ok: false, reason: String(err.message || err) });
      else res({ ok: true });
    });
  });
}

module.exports = { defaultFromReg, defaultPrinter, markDefault, mediaSizeFor, openPrefs, PAPER_IDS };
