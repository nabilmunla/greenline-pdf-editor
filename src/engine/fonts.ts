// Fonts from the PC (Windows' font folder) for text that the 14 built-in PDF fonts can't show:
// other typefaces (Calibri, Segoe UI, ...), Arabic and other scripts. Embedded in the PDF (subset
// on saving), so every PDF program shows the text the same way.
import * as mupdf from 'mupdf';
import * as hb from 'harfbuzzjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/** files for regular, bold, italic, bold italic (Windows names; then stand-ins on test machines) */
const FAMILIES: [string, string[], string[]?][] = [
  ['Arial', ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'], ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf']],
  ['Arial Narrow', ['arialn.ttf', 'arialnb.ttf', 'arialni.ttf', 'arialnbi.ttf']],
  ['Bahnschrift', ['bahnschrift.ttf']],
  ['Calibri', ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'], ['Carlito-Regular.ttf', 'Carlito-Bold.ttf', 'Carlito-Italic.ttf', 'Carlito-BoldItalic.ttf']],
  ['Candara', ['candara.ttf', 'candarab.ttf', 'candarai.ttf', 'candaraz.ttf']],
  ['Century Gothic', ['gothic.ttf', 'gothicb.ttf', 'gothici.ttf', 'gothicbi.ttf']],
  ['Comic Sans MS', ['comic.ttf', 'comicbd.ttf', 'comici.ttf', 'comicz.ttf']],
  ['Consolas', ['consola.ttf', 'consolab.ttf', 'consolai.ttf', 'consolaz.ttf']],
  ['Constantia', ['constan.ttf', 'constanb.ttf', 'constani.ttf', 'constanz.ttf']],
  ['Corbel', ['corbel.ttf', 'corbelb.ttf', 'corbeli.ttf', 'corbelz.ttf']],
  ['Courier New', ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'], ['LiberationMono-Regular.ttf', 'LiberationMono-Bold.ttf', 'LiberationMono-Italic.ttf', 'LiberationMono-BoldItalic.ttf']],
  ['Franklin Gothic', ['framd.ttf', 'frabk.ttf', 'framdit.ttf', 'frabkit.ttf']],
  ['Garamond', ['gara.ttf', 'garabd.ttf', 'garait.ttf']],
  ['Georgia', ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf']],
  ['Segoe UI', ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf']],
  ['Tahoma', ['tahoma.ttf', 'tahomabd.ttf']],
  ['Times New Roman', ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'], ['LiberationSerif-Regular.ttf', 'LiberationSerif-Bold.ttf', 'LiberationSerif-Italic.ttf', 'LiberationSerif-BoldItalic.ttf']],
  ['Trebuchet MS', ['trebuc.ttf', 'trebucbd.ttf', 'trebucit.ttf', 'trebucbi.ttf']],
  ['Verdana', ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'], ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSans-Oblique.ttf', 'DejaVuSans-BoldOblique.ttf']],
  // Arabic typefaces
  ['Dubai', ['dubai-regular.ttf', 'dubai-bold.ttf']],
  ['Sakkal Majalla', ['majalla.ttf', 'majallab.ttf']],
  ['Simplified Arabic', ['simpo.ttf', 'simpbdo.ttf']],
  ['Traditional Arabic', ['trado.ttf', 'tradbdo.ttf']],
  ['Arabic Typesetting', ['arabtype.ttf']],
  // test machines only (Linux): Arabic stand-in
  ['DejaVu Sans', ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSans-Oblique.ttf', 'DejaVuSans-BoldOblique.ttf']],
];
/** the built-in PDF families, and the font used for them when shaping is needed */
export const BASE_TTF: Record<string, string> = { Helv: 'Arial', TiRo: 'Times New Roman', Cour: 'Courier New' };
/** who to ask for a character the chosen font doesn't have */
const FALLBACK = ['Arial', 'Tahoma', 'Segoe UI', 'Times New Roman', 'Sakkal Majalla', 'DejaVu Sans'];

let index: Map<string, string> | null = null;
function fontDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.PDFED_FONT_DIRS) dirs.push(...process.env.PDFED_FONT_DIRS.split(/[;:](?![\\/])/).filter(Boolean));
  if (process.platform === 'win32') {
    dirs.push(join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else dirs.push('/usr/share/fonts', '/usr/local/share/fonts', join(process.env.HOME || '/root', '.fonts'));
  return dirs;
}
function scan(): Map<string, string> {
  if (index) return index;
  index = new Map();
  const walk = (d: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      if (/\.(ttf|otf)$/i.test(n)) { if (!index!.has(n.toLowerCase())) index!.set(n.toLowerCase(), p); continue; }
      if (depth < 4 && !n.includes('.')) { try { if (statSync(p).isDirectory()) walk(p, depth + 1); } catch { /* skip */ } }
    }
  };
  for (const d of fontDirs()) walk(d, 0);
  return index;
}

function fileFor(family: string, bold: boolean, italic: boolean): string | null {
  const f = FAMILIES.find((x) => x[0].toLowerCase() === family.toLowerCase());
  if (!f) return null;
  const idx = scan();
  const want = (bold ? 1 : 0) + (italic ? 2 : 0);
  // the style asked for, then the nearest one there is
  const order = [want, want & 1, want & 2, 0].filter((v, i, a) => a.indexOf(v) === i);
  for (const list of [f[1], f[2] || []]) {
    for (const k of order) { const n = list[k]; if (n && idx.has(n.toLowerCase())) return idx.get(n.toLowerCase())!; }
  }
  return null;
}

/** the families found on this PC (the built-in three come first in the interface) */
export function availableFamilies(): string[] {
  return FAMILIES.filter((f) => f[0] !== 'DejaVu Sans' || process.platform !== 'win32').filter((f) => !!fileFor(f[0], false, false)).map((f) => f[0]);
}

export interface FontRef {
  key: string;          // file path
  family: string;
  mu: mupdf.Font;
  hb: hb.Font;
  upem: number;
  asc: number;          // in em
  desc: number;         // in em (positive)
  bold: boolean;
  italic: boolean;
  /** the real style it has (asked bold, file regular) */
  has(cp: number): boolean;
}
const loaded = new Map<string, FontRef | null>();

export function loadFont(family: string, bold = false, italic = false): FontRef | null {
  const file = fileFor(family, bold, italic);
  if (!file) return null;
  if (loaded.has(file)) return loaded.get(file)!;
  let ref: FontRef | null = null;
  try {
    const bytes = new Uint8Array(readFileSync(file));
    const m = new mupdf.Font(basename(file).replace(/\.\w+$/, ''), bytes);
    const face = new hb.Face(new hb.Blob(bytes));
    const f = new hb.Font(face);
    const upem = face.upem || 1000;
    const ext = f.hExtents();
    const cache = new Map<number, boolean>();
    ref = {
      key: file, family, mu: m, hb: f, upem, bold, italic,
      asc: ext && ext.ascender ? ext.ascender / upem : 0.9,
      desc: ext && ext.descender ? Math.abs(ext.descender) / upem : 0.2,
      has(cp: number) {
        let v = cache.get(cp);
        if (v === undefined) { v = m.encodeCharacter(cp) > 0; cache.set(cp, v); }
        return v;
      },
    };
    (ref as FontRef & { bytes: Uint8Array }).bytes = bytes;
  } catch { ref = null; }
  loaded.set(file, ref);
  return ref;
}
export function fontBytes(f: FontRef): Uint8Array { return (f as FontRef & { bytes: Uint8Array }).bytes; }

/** the chosen font first, then the ones that cover Arabic and other scripts */
export function fontStack(family: string, bold: boolean, italic: boolean): FontRef[] {
  const out: FontRef[] = [];
  const add = (f: FontRef | null) => { if (f && !out.some((x) => x.key === f.key)) out.push(f); };
  add(loadFont(BASE_TTF[family] || family, bold, italic));
  for (const fb of FALLBACK) add(loadFont(fb, bold, italic));
  return out;
}

/** a font from given bytes (text edits: the font closest to the line being edited) */
export function fontFromBytes(name: string, bytes: Uint8Array): FontRef | null {
  const key = 'bytes:' + name + ':' + bytes.length;
  if (loaded.has(key)) return loaded.get(key)!;
  let ref: FontRef | null = null;
  try {
    const m = new mupdf.Font(name, bytes);
    const face = new hb.Face(new hb.Blob(bytes));
    const f = new hb.Font(face);
    const upem = face.upem || 1000;
    const ext = f.hExtents();
    const cache = new Map<number, boolean>();
    ref = { key, family: name, mu: m, hb: f, upem, bold: false, italic: false, asc: ext.ascender / upem || 0.9, desc: Math.abs(ext.descender) / upem || 0.2, has(cp: number) { let v = cache.get(cp); if (v === undefined) { v = m.encodeCharacter(cp) > 0; cache.set(cp, v); } return v; } };
    (ref as FontRef & { bytes: Uint8Array }).bytes = bytes;
  } catch { ref = null; }
  loaded.set(key, ref);
  return ref;
}
