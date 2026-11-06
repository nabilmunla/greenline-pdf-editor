// Minimal .xlsx writer (no dependencies beyond the zip library already in the app).
// Enough for clean exports: several sheets, bold headings, number formats, column
// widths, frozen header row, auto-filter.
import { zipSync, strToU8 } from 'fflate';

export type XCell = string | number | null | undefined | { v: string | number | null; s?: XStyle };
export type XStyle = 'h' | 'b' | 'n2' | 'n3' | 'n0' | 'b2' | 'i' | 'pct' | 'n1' | 'n4';

export interface XSheet {
  name: string;
  rows: XCell[][];
  widths?: number[];
  /** number of header rows to freeze (and filter on the last of them) */
  header?: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const col = (i: number) => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
// style index in cellXfs below
const STYLE: Record<XStyle, number> = { h: 1, b: 2, n2: 3, n3: 4, n0: 5, b2: 6, i: 7, pct: 8, n1: 9, n4: 10 };

export function writeXlsx(sheets: XSheet[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  // sheet names: no \ / ? * [ ] :, not starting or ending with ', at most 31 characters, and
  // each one different (Excel ignores case; "History" is its own) - else Excel "repairs" the file
  const names: string[] = [];
  sheets.forEach((s, i) => {
    const base = s.name.replace(/[\\/?*[\]:]/g, ' ').replace(/^[\s']+|[\s']+$/g, '').slice(0, 31) || 'Sheet' + (i + 1);
    let n = base;
    for (let k = 2; n.toLowerCase() === 'history' || names.some((x) => x.toLowerCase() === n.toLowerCase()); k++) n = base.slice(0, 31 - ` (${k})`.length) + ` (${k})`;
    names.push(n);
  });
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      `</Types>`,
  );
  files['_rels/.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      `</sheets>` +
      (sheets.some((s) => s.header) ? `<definedNames>` + sheets.map((s, i) => (s.header && s.rows.length > s.header ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i].replace(/'/g, "''"))}'!$A$${s.header}:$${col(Math.max(0, ...s.rows.map((r) => r.length)) - 1 || 0)}$${s.rows.length}</definedName>` : '')).join('') + `</definedNames>` : '') +
      `</workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="5"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.000"/><numFmt numFmtId="166" formatCode="0.0%"/><numFmt numFmtId="167" formatCode="#,##0.0"/><numFmt numFmtId="168" formatCode="#,##0.0000"/></numFmts>` +
      `<fonts count="3"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><i/><sz val="10"/><color rgb="FF666666"/><name val="Arial"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDFE9E7"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="2"><border/><border><bottom style="thin"><color rgb="FF9DB3AF"/></bottom></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="11"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment wrapText="1" vertical="center"/></xf>` +
      `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
      `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `</cellXfs></styleSheet>`,
  );
  sheets.forEach((sh, si) => {
    const out: string[] = [];
    out.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`);
    if (sh.header) out.push(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sh.header}" topLeftCell="A${sh.header + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`);
    if (sh.widths?.length) out.push('<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>');
    out.push('<sheetData>');
    sh.rows.forEach((row, ri) => {
      out.push(`<row r="${ri + 1}">`);
      row.forEach((c, ci) => {
        if (c === null || c === undefined) return;
        const cell = typeof c === 'object' ? c : { v: c };
        if (cell.v === null || cell.v === undefined || cell.v === '') return;
        const ref = col(ci) + (ri + 1);
        const st = cell.s ? ` s="${STYLE[cell.s]}"` : '';
        if (typeof cell.v === 'number' && Number.isFinite(cell.v)) out.push(`<c r="${ref}"${st}><v>${cell.v}</v></c>`);
        else out.push(`<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.v))}</t></is></c>`);
      });
      out.push('</row>');
    });
    out.push('</sheetData>');
    if (sh.header && sh.rows.length > sh.header) {
      const w = Math.max(...sh.rows.map((r) => r.length));
      out.push(`<autoFilter ref="A${sh.header}:${col(w - 1)}${sh.rows.length}"/>`);
    }
    out.push('</worksheet>');
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(out.join(''));
  });
  return zipSync(files, { level: 6 });
}
