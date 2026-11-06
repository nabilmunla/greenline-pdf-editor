// PDF font names -> the font a Windows PC has ("ABCDEF+TimesNewRomanPS-BoldMT" -> Times New Roman, bold).
import type { FontInfo } from './model';

/** letters-only lower-case key -> Windows family */
const KNOWN: Record<string, string> = {
  arial: 'Arial', arialmt: 'Arial', helvetica: 'Arial', helveticaneue: 'Arial', liberationsans: 'Arial', nimbussans: 'Arial', nimbussansl: 'Arial',
  freesans: 'Arial', dejavusans: 'Arial', arimo: 'Arial', swiss: 'Arial', univers: 'Arial',
  arialnarrow: 'Arial Narrow', liberationsansnarrow: 'Arial Narrow', nimbussansnarrow: 'Arial Narrow', helveticacondensed: 'Arial Narrow',
  arialblack: 'Arial Black', arialunicodems: 'Arial Unicode MS',
  times: 'Times New Roman', timesroman: 'Times New Roman', timesnewroman: 'Times New Roman', timesnewromanps: 'Times New Roman',
  liberationserif: 'Times New Roman', nimbusroman: 'Times New Roman', nimbusromno: 'Times New Roman', freeserif: 'Times New Roman',
  dejavuserif: 'Times New Roman', tinos: 'Times New Roman', roman: 'Times New Roman',
  courier: 'Courier New', couriernew: 'Courier New', liberationmono: 'Courier New', nimbusmono: 'Courier New', nimbusmonops: 'Courier New',
  freemono: 'Courier New', dejavusansmono: 'Courier New', cousine: 'Courier New',
  calibri: 'Calibri', carlito: 'Calibri', calibrilight: 'Calibri Light', cambria: 'Cambria', caladea: 'Cambria', cambriamath: 'Cambria Math',
  candara: 'Candara', consolas: 'Consolas', constantia: 'Constantia', corbel: 'Corbel', segoeui: 'Segoe UI', segoeuisemibold: 'Segoe UI Semibold',
  tahoma: 'Tahoma', verdana: 'Verdana', georgia: 'Georgia', garamond: 'Garamond', bookantiqua: 'Book Antiqua', bookmanoldstyle: 'Bookman Old Style',
  centurygothic: 'Century Gothic', century: 'Century', centuryschoolbook: 'Century Schoolbook', palatinolinotype: 'Palatino Linotype', palatino: 'Palatino Linotype',
  trebuchetms: 'Trebuchet MS', trebuchet: 'Trebuchet MS', lucidasans: 'Lucida Sans', lucidasansunicode: 'Lucida Sans Unicode', lucidaconsole: 'Lucida Console',
  franklingothic: 'Franklin Gothic Medium', franklingothicmedium: 'Franklin Gothic Medium', franklingothicbook: 'Franklin Gothic Book', gillsansmt: 'Gill Sans MT', gillsans: 'Gill Sans MT',
  microsoftsansserif: 'Microsoft Sans Serif', msreferencesansserif: 'Microsoft Sans Serif', aptos: 'Aptos', bahnschrift: 'Bahnschrift',
  symbol: 'Symbol', opensymbol: 'Symbol', symbolmt: 'Symbol', wingdings: 'Wingdings', wingdingsregular: 'Wingdings', zapfdingbats: 'Wingdings',
  simplifiedarabic: 'Simplified Arabic', traditionalarabic: 'Traditional Arabic', arabictypesetting: 'Arabic Typesetting', sakkalmajalla: 'Sakkal Majalla',
  andalus: 'Andalus', akhbarmt: 'Akhbar MT', dubai: 'Dubai', dubaimedium: 'Dubai Medium', amiri: 'Arial', notonaskharabic: 'Arial', notosansarabic: 'Arial',
};

const BOLD = /(bold|black|heavy|semibold|demibold|demi|extrabold|ultrabold|^bd$|bdit|^sb$)/i;
const ITALIC = /(italic|oblique|^it$|bdit|^obl$|slanted|kursiv)/i;
/** style words that are not part of the family name */
const STYLE = /^(bold|black|heavy|semibold|semi|demibold|demi|extrabold|ultrabold|light|extralight|ultralight|thin|regular|roman|medium|book|normal|italic|oblique|it|bd|bdit|obl|condensed|cond|cn|narrow|wide|extended|ps|mt|psmt|std|pro|lt|ltstd|w\d+|bolditalic|boldoblique|semibolditalic|lightitalic|mediumitalic)$/i;

const cache = new Map<string, FontInfo>();

export function fontInfo(raw: string, flags: { bold: boolean; italic: boolean; serif: boolean; mono: boolean }): FontInfo {
  const k = raw + '|' + flags.bold + flags.italic + flags.serif + flags.mono;
  const hit = cache.get(k);
  if (hit) return hit;
  let name = raw.replace(/^[A-Z]{6}\+/, '').replace(/[#_]20/g, ' ');
  // "Arial,Bold" / "Arial-BoldMT" / "Arial Bold"
  const parts = name.split(/[,\-]/);
  let base = parts[0];
  const rest = parts.slice(1).join(' ');
  let bold = flags.bold || BOLD.test(rest) || /bold|black|heavy|semibold/i.test(base);
  let italic = flags.italic || ITALIC.test(rest) || /italic|oblique/i.test(base);
  // "TimesNewRomanPSMT" / "ArialMT": drop trailing PS/MT; split camel case for unknown names
  base = base.replace(/(PSMT|PS|MT|Std|Pro|LT)$/g, '').replace(/(Bold|Italic|Oblique|Regular|Black|Semibold|Light|Medium)+$/i, (m) => { if (/bold|black|semibold/i.test(m)) bold = true; if (/italic|oblique/i.test(m)) italic = true; return ''; });
  const key = base.toLowerCase().replace(/[^a-z]/g, '');
  let family = KNOWN[key];
  if (!family) {
    // "Arial Narrow Bold" style words inside one token
    const words = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/\s+/).filter((w) => w && !STYLE.test(w));
    const k2 = words.join('').toLowerCase().replace(/[^a-z]/g, '');
    family = KNOWN[k2] || words.join(' ') || (flags.mono ? 'Courier New' : flags.serif ? 'Times New Roman' : 'Arial');
    // names that are really codes ("F1", "T3", "Font12") say nothing: go by the font's kind
    if (/^(f|t|c|font|tt)\s?\d+$/i.test(family) || family.length < 3) family = flags.mono ? 'Courier New' : flags.serif ? 'Times New Roman' : 'Arial';
  }
  const info: FontInfo = { family, bold, italic, serif: flags.serif || /times|roman|serif|georgia|garamond|cambria|book|century|palatino|constantia/i.test(family), mono: flags.mono || /courier|mono|consolas/i.test(family) };
  cache.set(k, info);
  return info;
}

/** Symbol / Wingdings private-use bullets -> real characters */
const PUA: Record<number, string> = {
  0xf0b7: '•', 0xf06c: '●', 0xf06e: '■', 0xf06f: '□', 0xf071: '❑', 0xf076: '❖', 0xf0a7: '▪', 0xf0a8: '◆', 0xf0d8: '➢', 0xf0fc: '✓', 0xf0fb: '✗',
  0xf0e0: '→', 0xf0e8: '➔', 0xf02d: '-', 0xf0b0: '°', 0xf0b4: '×', 0xf0b1: '±', 0xf0a3: '≤', 0xf0b3: '≥', 0xf0d6: '√', 0xf0a5: '∞', 0xf06d: 'μ', 0xf057: 'Ω',
};
export function fixChar(c: string): string {
  const u = c.charCodeAt(0);
  if (u >= 0xf000 && u <= 0xf0ff) return PUA[u] ?? '•';
  if (u === 0xa0 || u === 0x2007 || u === 0x202f) return ' ';
  if (u === 0xad) return '';
  return c;
}

/** a typical line height (as a multiple of the size) of a family, for Word's "single" spacing */
export function naturalLeading(family: string): number {
  const f = family.toLowerCase();
  if (/calibri|candara|corbel|consolas|constantia/.test(f)) return 1.22;
  if (/cambria/.test(f)) return 1.17;
  if (/segoe/.test(f)) return 1.33;
  if (/tahoma|verdana/.test(f)) return 1.21;
  if (/century gothic/.test(f)) return 1.23;
  if (/aptos/.test(f)) return 1.2;
  return 1.15;
}
