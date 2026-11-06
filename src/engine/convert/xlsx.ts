// A .xlsx writer with real styles: fonts, fills, borders, alignment, number formats, merged
// cells, column widths, row heights, frozen header rows and print titles.
import { zipSync, strToU8 } from 'fflate';

export interface XFont { name: string; size: number; b?: boolean; i?: boolean; u?: boolean; s?: boolean; color?: number }
export interface XStyle {
  font: XFont;
  fill?: number;
  /** top, right, bottom, left: 0 none, 1 thin, 2 medium, 3 thick */
  bd?: [number, number, number, number];
  h?: 'left' | 'center' | 'right';
  v?: 'top' | 'center' | 'bottom';
  wrap?: boolean;
  indent?: number;
  rot?: number;
  fmt?: string;
}
export interface XCell { v: string | number; st: XStyle }
export interface XSheet {
  name: string;
  rows: (XCell | null)[][];
  heights: (number | undefined)[];
  widths: number[];
  merges: [number, number, number, number][];
  /** rows to freeze at the top (0 none) */
  freeze?: number;
  /** repeat rows [from, to] (1-based) on every printed page */
  titles?: [number, number];
  landscape?: boolean;
  paper?: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
export const colName = (i: number) => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
const hex = (c: number) => 'FF' + c.toString(16).padStart(6, '0').toUpperCase();

class Registry<T> {
  list: string[] = [];
  private m = new Map<string, number>();
  constructor(first: string[]) { for (const f of first) this.add(f); }
  add(xml: string): number { let i = this.m.get(xml); if (i === undefined) { i = this.list.length; this.list.push(xml); this.m.set(xml, i); } return i; }
  declare _t: T;
}

const BUILTIN_FMT: Record<string, number> = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10 };

export function writeWorkbook(sheets: XSheet[], defaultFont: XFont): Uint8Array {
  const fontXml = (f: XFont) => `<font>${f.b ? '<b/>' : ''}${f.i ? '<i/>' : ''}${f.s ? '<strike/>' : ''}${f.u ? '<u/>' : ''}<sz val="${Math.min(409, Math.max(1, Math.round(f.size * 2) / 2))}"/>${f.color && f.color !== 0 ? `<color rgb="${hex(f.color)}"/>` : ''}<name val="${esc(f.name)}"/></font>`;
  const fonts = new Registry<XFont>([fontXml(defaultFont)]);
  const fills = new Registry<number>(['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']);
  const SIDE = ['', 'thin', 'medium', 'thick'];
  const bdXml = (b?: [number, number, number, number]) => {
    if (!b || !b.some((x) => x)) return '<border><left/><right/><top/><bottom/><diagonal/></border>';
    const s = (tag: string, v: number) => (v ? `<${tag} style="${SIDE[v]}"><color auto="1"/></${tag}>` : `<${tag}/>`);
    return `<border>${s('left', b[3])}${s('right', b[1])}${s('top', b[0])}${s('bottom', b[2])}<diagonal/></border>`;
  };
  const borders = new Registry<string>([bdXml()]);
  const fmts = new Map<string, number>();
  let nextFmt = 164;
  const fmtId = (f?: string) => {
    if (!f || f === 'General') return 0;
    if (BUILTIN_FMT[f] !== undefined) return BUILTIN_FMT[f];
    let id = fmts.get(f);
    if (id === undefined) { id = nextFmt++; fmts.set(f, id); }
    return id;
  };
  const xfs = new Registry<XStyle>(['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']);
  const styleId = (st: XStyle) => {
    const fo = fonts.add(fontXml(st.font));
    const fi = st.fill !== undefined ? fills.add(`<fill><patternFill patternType="solid"><fgColor rgb="${hex(st.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const bo = borders.add(bdXml(st.bd));
    const nf = fmtId(st.fmt);
    const al = st.h || st.v || st.wrap || st.indent || st.rot ? `<alignment${st.h ? ` horizontal="${st.h}"` : ''}${st.v ? ` vertical="${st.v}"` : ''}${st.wrap ? ' wrapText="1"' : ''}${st.indent ? ` indent="${Math.min(15, st.indent)}"` : ''}${st.rot ? ` textRotation="${st.rot}"` : ''}/>` : '';
    return xfs.add(`<xf numFmtId="${nf}" fontId="${fo}" fillId="${fi}" borderId="${bo}" xfId="0"${nf ? ' applyNumberFormat="1"' : ''}${fo ? ' applyFont="1"' : ''}${fi ? ' applyFill="1"' : ''}${bo ? ' applyBorder="1"' : ''}${al ? ' applyAlignment="1">' + al + '</xf>' : '/>'}`);
  };
  // shared strings
  const sst: string[] = [];
  const sstIdx = new Map<string, number>();
  let sstCount = 0;
  // (a cell holds at most 32,767 characters)
  const str = (s: string) => { sstCount++; if (s.length > 32767) s = s.slice(0, 32767); let i = sstIdx.get(s); if (i === undefined) { i = sst.length; sst.push(s); sstIdx.set(s, i); } return i; };

  const files: Record<string, Uint8Array> = {};
  const names: string[] = [];
  // Excel's rules for sheet names: 31 characters at most, none of \ / ? * [ ] :, not starting or
  // ending with an apostrophe, not "History", unique (ignoring case)
  const trimQ = (x: string) => x.replace(/^[\s']+|[\s']+$/g, '');
  for (const [i, s] of sheets.entries()) {
    let base = trimQ(trimQ(s.name.replace(/[\u0000-\u001f\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ')).slice(0, 31));
    if (!base) base = 'Sheet' + (i + 1);
    let n = /^history$/i.test(base) ? base + ' 1' : base;
    for (let k = 2; names.some((x) => x.toLowerCase() === n.toLowerCase()); k++) {
      const suf = ' (' + k + ')';
      n = trimQ(base.slice(0, 31 - suf.length)) + suf;
    }
    names.push(n);
  }
  sheets.forEach((sh, si) => {
    const out: string[] = [];
    let ncols = Math.max(1, sh.widths.length);
    for (const r of sh.rows) if (r.length > ncols) ncols = r.length;
    const nrows = Math.max(1, sh.rows.length);
    out.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`);
    out.push(`<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${colName(ncols - 1)}${nrows}"/>`);
    out.push(`<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}>${sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sh.freeze + 1}" sqref="A${sh.freeze + 1}"/>` : ''}</sheetView></sheetViews>`);
    out.push(`<sheetFormatPr defaultRowHeight="12.75"/>`);
    if (sh.widths.length) out.push('<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(1, Math.min(255, Math.round(w * 100) / 100))}" customWidth="1"/>`).join('') + '</cols>');
    out.push('<sheetData>');
    sh.rows.forEach((row, ri) => {
      const ht = sh.heights[ri];
      const cells: string[] = [];
      row.forEach((c, ci) => {
        if (!c) return;
        const ref = colName(ci) + (ri + 1);
        const s = styleId(c.st);
        const sa = s ? ` s="${s}"` : '';
        if (typeof c.v === 'number' && Number.isFinite(c.v)) cells.push(`<c r="${ref}"${sa}><v>${c.v}</v></c>`);
        else if (c.v === '') cells.push(`<c r="${ref}"${sa}/>`);
        else cells.push(`<c r="${ref}"${sa} t="s"><v>${str(String(c.v))}</v></c>`);
      });
      if (!cells.length && ht === undefined) return;
      out.push(`<row r="${ri + 1}"${ht ? ` ht="${Math.round(Math.min(409, ht) * 4) / 4}" customHeight="1"` : ''}>${cells.join('')}</row>`);
    });
    out.push('</sheetData>');
    if (sh.merges.length) out.push(`<mergeCells count="${sh.merges.length}">` + sh.merges.map(([r0, c0, r1, c1]) => `<mergeCell ref="${colName(c0)}${r0 + 1}:${colName(c1)}${r1 + 1}"/>`).join('') + '</mergeCells>');
    out.push(`<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>`);
    out.push(`<pageSetup${sh.paper ? ` paperSize="${sh.paper}"` : ''} orientation="${sh.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`);
    out.push(`<headerFooter><oddFooter>&amp;C&amp;8Page &amp;P of &amp;N</oddFooter></headerFooter>`);
    out.push('</worksheet>');
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(out.join(''));
  });
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + `</Types>`,
  );
  files['_rels/.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  files['docProps/core.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  files['docProps/app.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>PDF Editor</Application></Properties>`);
  const titles = sheets.map((s, i) => (s.titles ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${esc(names[i]).replace(/'/g, "''")}'!$${s.titles[0]}:$${s.titles[1]}</definedName>` : '')).join('');
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>` +
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + `</sheets>` + (titles ? `<definedNames>${titles}</definedNames>` : '') + `</workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${names.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  files['xl/sharedStrings.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sstCount}" uniqueCount="${sst.length}">` + sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') + `</sst>`);
  const numFmts = [...fmts.entries()];
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      (numFmts.length ? `<numFmts count="${numFmts.length}">` + numFmts.map(([f, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(f)}"/>`).join('') + `</numFmts>` : '') +
      `<fonts count="${fonts.list.length}">${fonts.list.join('')}</fonts><fills count="${fills.list.length}">${fills.list.join('')}</fills><borders count="${borders.list.length}">${borders.list.join('')}</borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.list.length}">${xfs.list.join('')}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  return zipSync(files, { level: 6 });
}
