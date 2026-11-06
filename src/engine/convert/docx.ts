// A .docx writer: paragraphs with real runs (font, size, bold, italic, underline, colour,
// raised/lowered, right-to-left), tabs and indents, tables with merged cells, borders and
// shading, pictures, sections with their own page size, headers, footers and page numbers.
import { zipSync, strToU8 } from 'fflate';

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
export const tw = (pt: number) => Math.round(pt * 20);
const EMU = 12700;

export interface RunStyle { font: string; size: number; b?: boolean; i?: boolean; u?: boolean; s?: boolean; color?: number; va?: number; rtl?: boolean }
export interface RunPart { text: string; st: RunStyle; tab?: boolean; field?: 'PAGE' | 'NUMPAGES'; link?: string }

export interface ParaProps {
  style?: string;
  keepNext?: boolean;
  pageBreak?: boolean;
  tabs?: [number, 'left' | 'center' | 'right' | 'dotright'][];
  bidi?: boolean;
  before?: number;
  /** exact line pitch (points) or 0 for single */
  line?: number;
  left?: number; right?: number; first?: number;
  jc?: 'left' | 'center' | 'right' | 'both';
  outline?: number;
  /** a section ends with this paragraph */
  sect?: string;
  /** tiny paragraph (holds a break) */
  tiny?: boolean;
}

const clampSz = (pt: number) => Math.max(2, Math.min(3276, Math.round(pt * 2)));
export function runXml(p: RunPart, fieldRels: (uri: string) => string): string {
  const s = p.st;
  const rpr = `<w:rPr><w:rFonts w:ascii="${esc(s.font)}" w:hAnsi="${esc(s.font)}" w:cs="${esc(s.font)}"/>${s.b ? '<w:b/><w:bCs/>' : ''}${s.i ? '<w:i/><w:iCs/>' : ''}${s.s ? '<w:strike/>' : ''}${s.color ? `<w:color w:val="${s.color.toString(16).padStart(6, '0').toUpperCase()}"/>` : ''}<w:sz w:val="${clampSz(s.size)}"/><w:szCs w:val="${clampSz(s.size)}"/>${s.u ? '<w:u w:val="single"/>' : ''}${s.va ? `<w:vertAlign w:val="${s.va > 0 ? 'superscript' : 'subscript'}"/>` : ''}${s.rtl ? '<w:rtl/>' : ''}</w:rPr>`;
  if (p.field) return `<w:fldSimple w:instr=" ${p.field} "><w:r>${rpr}<w:t>${esc(p.text || '1')}</w:t></w:r></w:fldSimple>`;
  const body = p.tab ? '<w:tab/>' : `<w:t xml:space="preserve">${esc(p.text)}</w:t>`;
  const r = `<w:r>${rpr}${body}</w:r>`;
  return p.link ? `<w:hyperlink r:id="${fieldRels(p.link)}" w:history="1">${r}</w:hyperlink>` : r;
}

const lim = (v: number, lo = -31680) => Math.max(lo, Math.min(31680, v));
export function paraXml(pp: ParaProps, inner: string, tinySize = 1): string {
  const pr: string[] = [];
  if (pp.style) pr.push(`<w:pStyle w:val="${pp.style}"/>`);
  if (pp.keepNext) pr.push('<w:keepNext/>');
  if (pp.pageBreak) pr.push('<w:pageBreakBefore/>');
  if (pp.tabs?.length) pr.push('<w:tabs>' + pp.tabs.slice().sort((a, b) => a[0] - b[0]).map(([pos, k]) => `<w:tab w:val="${k === 'dotright' ? 'right' : k}"${k === 'dotright' ? ' w:leader="dot"' : ''} w:pos="${Math.max(0, tw(pos))}"/>`).join('') + '</w:tabs>');
  if (pp.bidi) pr.push('<w:bidi/>');
  if (pp.tiny) pr.push(`<w:spacing w:before="0" w:after="0" w:line="${tw(tinySize)}" w:lineRule="exact"/>`);
  // (Word's limits: spacing and indents up to 22 inches, exact line height up to 1584 pt)
  else pr.push(`<w:spacing w:before="${lim(tw(pp.before ?? 0), 0)}" w:after="0"${pp.line ? ` w:line="${lim(Math.max(tw(4), tw(pp.line)), 0)}" w:lineRule="exact"` : ' w:line="240" w:lineRule="auto"'}/>`);
  const l = lim(tw(pp.left ?? 0)), r = lim(tw(pp.right ?? 0)), f = lim(tw(pp.first ?? 0));
  if (l || r || f) pr.push(`<w:ind w:left="${l}" w:right="${r}"${f > 0 ? ` w:firstLine="${f}"` : f < 0 ? ` w:hanging="${Math.min(-f, Math.max(0, l))}"` : ''}/>`);
  if (pp.jc && pp.jc !== 'left') pr.push(`<w:jc w:val="${pp.jc}"/>`);
  if (pp.outline !== undefined) pr.push(`<w:outlineLvl w:val="${pp.outline}"/>`);
  if (pp.tiny) pr.push(`<w:rPr><w:sz w:val="${Math.max(2, tinySize * 2)}"/></w:rPr>`);
  if (pp.sect) pr.push(pp.sect);
  return `<w:p>${pr.length ? '<w:pPr>' + pr.join('') + '</w:pPr>' : ''}${inner}</w:p>`;
}

export interface Section {
  w: number; h: number;
  margins: [number, number, number, number]; // top right bottom left
  header?: string; footer?: string; // part xml bodies (paragraphs)
  pageStart?: number;
}

function fnv(d: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193);
  return h >>> 0;
}
function same(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class Docx {
  private rels: string[] = [];
  private media: Record<string, Uint8Array> = {};
  private nMedia = 0;
  private seen = new Map<string, { name: string; rid: string }>();
  private links = new Map<string, string>();
  private parts: Record<string, string> = {};
  private nHdr = 0;
  private picId = 1;
  constructor(public body: string[] = []) {}
  private rel(type: string, target: string, external = false): string {
    const id = 'rId' + (this.rels.length + 10);
    this.rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`);
    return id;
  }
  link = (uri: string) => { let id = this.links.get(uri); if (!id) { id = this.rel('hyperlink', uri, true); this.links.set(uri, id); } return id; };
  /** an inline picture run */
  picture(data: Uint8Array, ext: 'png' | 'jpeg', wPt: number, hPt: number): string {
    // the same picture again (a logo on every page): one copy in the file
    const key = ext + ':' + data.length + ':' + fnv(data);
    let seen = this.seen.get(key);
    if (seen && !same(this.media['word/media/' + seen.name], data)) seen = undefined;
    if (!seen) {
      const name = `image${++this.nMedia}.${ext === 'jpeg' ? 'jpeg' : 'png'}`;
      this.media['word/media/' + name] = data;
      seen = { name, rid: this.rel('image', 'media/' + name) };
      if (!this.seen.has(key)) this.seen.set(key, seen);
    }
    const { name, rid } = seen;
    const cx = Math.max(1, Math.round(wPt * EMU)), cy = Math.max(1, Math.round(hPt * EMU));
    const id = this.picId++;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
  /** sectPr for a section (header/footer parts are made here) */
  sectPr(s: Section): string {
    const refs: string[] = [];
    if (s.header) { const n = ++this.nHdr; this.parts[`word/header${n}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${s.header}</w:hdr>`; refs.push(`<w:headerReference w:type="default" r:id="${this.rel('header', `header${n}.xml`)}"/>`); }
    if (s.footer) { const n = ++this.nHdr; this.parts[`word/footer${n}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}>${s.footer}</w:ftr>`; refs.push(`<w:footerReference w:type="default" r:id="${this.rel('footer', `footer${n}.xml`)}"/>`); }
    const [t, r, b, l] = s.margins;
    const land = s.w > s.h;
    return `<w:sectPr>${refs.join('')}<w:type w:val="nextPage"/><w:pgSz w:w="${tw(s.w)}" w:h="${tw(s.h)}"${land ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${tw(t)}" w:right="${tw(r)}" w:bottom="${tw(b)}" w:left="${tw(l)}" w:header="${tw(Math.min(36, t * 0.5))}" w:footer="${tw(Math.min(36, b * 0.5))}" w:gutter="0"/>${s.pageStart ? `<w:pgNumType w:start="${s.pageStart}"/>` : ''}<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>`;
  }
  finish(defFont: string, defSize: number, title: string, headings: { font: string }[] = []): Uint8Array {
    void headings;
    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${this.body.join('')}</w:body></w:document>`;
    files['word/document.xml'] = strToU8(doc);
    for (const [k, v] of Object.entries(this.parts)) files[k] = strToU8(v);
    // (pictures are compressed already: stored, not squeezed again)
    for (const [k, v] of Object.entries(this.media)) files[k] = [v, { level: 0 }];
    const sz = Math.round(defSize * 2);
    files['word/styles.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${esc(defFont)}" w:hAnsi="${esc(defFont)}" w:cs="${esc(defFont)}" w:eastAsia="${esc(defFont)}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="en-GB" w:bidi="ar-AE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
      [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="${n - 1}"/></w:pPr></w:style>`).join('') +
      `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>` +
      `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="72" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="72" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
      `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`);
    files['word/settings.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${NS}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`);
    files['word/_rels/document.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${this.rels.join('')}</Relationships>`);
    const hf = Object.keys(this.parts).map((k) => `<Override PartName="/${k}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${k.includes('header') ? 'header' : 'footer'}+xml"/>`).join('');
    files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${hf}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
    files['_rels/.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    files['docProps/core.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
    files['docProps/app.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>PDF Editor</Application></Properties>`);
    return zipSync(files, { level: 6 });
  }
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
