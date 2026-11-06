// AI assistant: what is sent about the open PDF, and the conversation with Claude / ChatGPT.
// Nothing leaves the PC until the person presses Send, and the panel lists exactly what goes.
import { gcc, type AiMessage, type AiPart, type AiProvider, type AiEvent } from './api';
import { rendererFor, renderers } from './engines';
import type { PdfDoc } from './doc';

export const PROVIDERS: Record<AiProvider, { name: string; keyUrl: string; keyHint: string; models: { id: string; label: string }[] }> = {
  anthropic: {
    name: 'Claude',
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyHint: 'sk-ant-…',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (balanced)' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (strongest)' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest)' },
    ],
  },
  openai: {
    name: 'ChatGPT',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol (balanced)' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra (strongest)' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna (fastest)' },
    ],
  },
};

export type Scope = { kind: 'page'; page: number } | { kind: 'pages'; pages: number[] } | { kind: 'all' };

/** what goes with the question - shown to the person before / after sending */
export interface Context {
  parts: AiPart[];
  /** the page numbers sent (0-based) and how */
  pages: number[];
  mode: 'pdf' | 'text';
  images: number[];
  /** picture-only pages that were left out (too many) */
  skippedImages: number[];
  /** pages left out because the file is too long (the most relevant ones were kept) */
  trimmed: number;
  chars: number;
  bytes: number;
  estTokens: number;
  note: string;
}

const PDF_PAGES = 20;          // up to this many pages go as a real PDF (text + pictures)
const PDF_BYTES = 18e6;        // ...if the extract stays under this size
const TEXT_BUDGET = 360_000;   // characters of page text (~90k tokens)
const MAX_IMAGES = 12;         // picture pages (drawings, scans) sent as images in text mode
const MIN_TEXT = 40;           // a page with less text than this is a picture (scan, drawing)

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

function scopePages(doc: PdfDoc, scope: Scope): number[] {
  if (scope.kind === 'page') return [scope.page];
  if (scope.kind === 'pages') return [...new Set(scope.pages)].sort((a, b) => a - b);
  return doc.pages.map((_, i) => i);
}

/** page text for many pages, in chunks spread over the drawing engines */
export async function pageTexts(doc: PdfDoc, pages: number[], onProgress?: (done: number) => void): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  await doc.drawReady();
  // contiguous runs, 50 pages per call
  const runs: [number, number][] = [];
  for (const p of pages) {
    const last = runs[runs.length - 1];
    if (last && last[1] === p && last[1] - last[0] < 50) last[1] = p + 1;
    else runs.push([p, p + 1]);
  }
  let done = 0;
  let next = 0;
  const worker = async (k: number) => {
    while (next < runs.length) {
      const [a, b] = runs[next++];
      const t = await renderers[k % renderers.length].call<string[]>('texts', [doc.id, a, b]);
      t.forEach((s, i) => out.set(a + i, s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()));
      done += b - a;
      onProgress?.(done);
    }
  };
  await Promise.all(renderers.map((_, k) => worker(k)));
  return out;
}

/** words of a question (English + Arabic), for picking the pages that matter */
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.\-/]{2,}/gu) || []).filter((w) => !STOP.has(w));
const STOP = new Set('the and for are was with this that what which from have has had not but all any can will shall into per its their there them they you your our out about how who when where why does did done should would could than then also such each other more most some only same very just over under between page pages document file'.split(' '));

/** the pages most related to the question, within the text budget (kept in page order) */
function pickRelevant(texts: Map<number, string>, question: string, budget: number, keep: number[]): { pages: number[]; trimmed: number } {
  const q = words(question);
  const df = new Map<string, number>();
  const tf = new Map<number, Map<string, number>>();
  for (const [p, t] of texts) {
    const m = new Map<string, number>();
    for (const w of words(t)) m.set(w, (m.get(w) || 0) + 1);
    tf.set(p, m);
    for (const w of new Set(q)) if (m.has(w)) df.set(w, (df.get(w) || 0) + 1);
  }
  const N = texts.size;
  const score = (p: number) => {
    const m = tf.get(p)!;
    let s = 0;
    for (const w of q) { const f = m.get(w) || 0; if (f) s += (1 + Math.log(f)) * Math.log(1 + N / (df.get(w) || 1)); }
    return s;
  };
  const ranked = [...texts.keys()].map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s || a.p - b.p);
  const chosen = new Set<number>();
  let used = 0;
  for (const p of keep) if (texts.has(p)) { chosen.add(p); used += texts.get(p)!.length; }
  for (const { p, s } of ranked) {
    if (chosen.has(p)) continue;
    const len = texts.get(p)!.length;
    if (used + len > budget) { if (s > 0) continue; else break; }
    chosen.add(p);
    used += len;
  }
  const pages = [...chosen].sort((a, b) => a - b);
  return { pages, trimmed: texts.size - pages.length };
}

/** a page as a JPEG (for drawings and scans: what the eye sees) */
async function pageJpeg(doc: PdfDoc, page: number, longSide = 1568): Promise<Uint8Array> {
  const pg = doc.pages[page];
  const s = longSide / Math.max(pg.w, pg.h);
  const w = Math.max(1, Math.round(pg.w * s)), h = Math.max(1, Math.round(pg.h * s));
  const bmp = await rendererFor(doc.id, page).call<ImageBitmap>('tile', [doc.id, page, s, 0, 0, w, h]);
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 })).arrayBuffer());
}

/**
 * What to send with a question. Few pages: the pages themselves as a PDF (the AI reads text
 * and sees drawings). Many pages: their text with page numbers (the most relevant pages
 * when the file is too long), plus pictures of pages that have no text (scans, drawings).
 */
export async function buildContext(doc: PdfDoc, scope: Scope, question: string, current: number, onProgress?: (msg: string) => void, prefer: 'auto' | 'text' = 'auto'): Promise<Context> {
  const pages = scopePages(doc, scope);
  const name = doc.name;
  // 1) small: as a PDF of just those pages
  if (prefer === 'auto' && pages.length <= PDF_PAGES) {
    onProgress?.('Preparing the pages…');
    const f = await doc.extract(pages);
    try {
      const st = await gcc.stat(f);
      if (st && st.size <= PDF_BYTES) {
        const bytes = await gcc.read(f);
        const map = pages.map((p, i) => `PDF page ${i + 1} = page ${p + 1}`).join(', ');
        return {
          parts: [
            { t: 'text', text: `Document: "${name}" (${doc.pages.length} pages). Attached: ${pages.length === doc.pages.length ? 'the whole document' : pages.length + ' of its pages'} as a PDF. Page numbers: ${map}. Always cite the document's page numbers (not the attachment's).` },
            { t: 'pdf', b64: b64(bytes), name: name.replace(/\.pdf$/i, '') + ' (extract).pdf' },
          ],
          pages, mode: 'pdf', images: [], skippedImages: [], trimmed: 0, chars: 0, bytes: bytes.length,
          estTokens: pages.length * 2500, note: '',
        };
      }
    } finally { void gcc.dropTemp([f]); }
  }
  // 2) text of the pages (+ pictures of picture pages)
  onProgress?.('Reading the text of ' + pages.length + ' page' + (pages.length > 1 ? 's' : '') + '…');
  const texts = await pageTexts(doc, pages, (n) => { if (pages.length > 100) onProgress?.(`Reading text… ${n} of ${pages.length} pages`); });
  const picture = pages.filter((p) => (texts.get(p) || '').replace(/\s+/g, '').length < MIN_TEXT);
  const withText = new Map([...texts].filter(([p]) => !picture.includes(p)));
  let chosen = [...withText.keys()];
  let trimmed = 0;
  const total = [...withText.values()].reduce((s, t) => s + t.length, 0);
  if (total > TEXT_BUDGET) {
    const r = pickRelevant(withText, question, TEXT_BUDGET, [current]);
    chosen = r.pages;
    trimmed = r.trimmed;
  }
  const imgPages = picture.slice(0, MAX_IMAGES);
  // the current page first among pictures when there are too many
  if (picture.length > MAX_IMAGES && picture.includes(current) && !imgPages.includes(current)) imgPages[imgPages.length - 1] = current;
  const skippedImages = picture.filter((p) => !imgPages.includes(p));
  const parts: AiPart[] = [];
  const head = `Document: "${name}" (${doc.pages.length} pages).` +
    (trimmed ? ` It is too long to send whole: below are the ${chosen.length} pages most related to the question (out of ${withText.size} with text).` : '') +
    ` Each page starts with "=== Page N ===". Always cite these page numbers.` +
    // (picture pages over the limit: the model is told, or it would take the document as complete)
    (skippedImages.length ? ` Not sent: ${skippedImages.length} picture-only page${skippedImages.length > 1 ? 's' : ''} (drawings or scans) - page${skippedImages.length > 1 ? 's' : ''} ${skippedImages.slice(0, 40).map((p) => p + 1).join(', ')}${skippedImages.length > 40 ? ', …' : ''}. If the answer could be on them, say so.` : '');
  let body = '';
  for (const p of chosen) body += `\n\n=== Page ${p + 1}${doc.pages[p].label && doc.pages[p].label !== String(p + 1) ? ` (labelled "${doc.pages[p].label}")` : ''} ===\n${withText.get(p)}`;
  parts.push({ t: 'text', text: head + body });
  let bytes = 0;
  for (let i = 0; i < imgPages.length; i++) {
    onProgress?.(`Picture of page ${imgPages[i] + 1} (${i + 1} of ${imgPages.length})…`);
    const jpg = await pageJpeg(doc, imgPages[i]);
    bytes += jpg.length;
    parts.push({ t: 'text', text: `=== Page ${imgPages[i] + 1} (picture: a drawing or scan) ===` });
    parts.push({ t: 'image', b64: b64(jpg), mime: 'image/jpeg' });
  }
  const chars = chosen.reduce((s, p) => s + (withText.get(p)?.length || 0), 0);
  return {
    parts, pages: [...chosen, ...imgPages].sort((a, b) => a - b), mode: 'text', images: imgPages, skippedImages, trimmed, chars,
    bytes: bytes + chars, estTokens: Math.round(chars / 3.6) + imgPages.length * 1600,
    note: skippedImages.length ? `${skippedImages.length} more picture-only pages were not sent (limit ${MAX_IMAGES}).` : '',
  };
}

export const SYSTEM_ASK = `You are the assistant inside a PDF editor used by a construction company's tendering and estimation team (specifications, bills of quantities, drawings, contracts, tender documents).
Answer from the document content provided. Be precise with quantities, units, clause numbers and dates; never invent figures.
Cite the pages you used as [p. N] (the document's page numbers given with the content), e.g. "Concrete grade C40 [p. 12]".
If the answer is not in the pages provided, say so plainly and suggest where it might be (e.g. other pages) - do not guess.
Answer in the language the question is asked in. Use short paragraphs, lists or small tables where they help.`;

export function systemTranslate(target: string): string {
  return `You translate documents for a construction company's tendering team. Translate the content provided into ${target}.
Keep the structure: one section per page, starting with the page heading exactly as given ("=== Page N ==="). Keep numbers, units, codes, clause numbers, drawing numbers and names as they are; keep tables as Markdown tables.
Use correct technical construction and contract terminology in ${target}. Translate everything; do not summarise, do not add comments.
For pictures (scans, drawings) translate the visible text. If a page has nothing to translate, write the page heading and "(no text)".`;
}

// ---------------------------------------------------------------- streaming

let seq = 1;
const listeners = new Map<string, (ev: AiEvent) => void>();
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  gcc.onAiEvent((id, ev) => listeners.get(id)?.(ev));
}

export interface Run { id: string; done: Promise<{ text: string; usage: Record<string, number> | null; stop: string }>; cancel(): void }

/** send and stream: onText gets the answer so far */
export function ask(provider: AiProvider, model: string, system: string, messages: AiMessage[], onText: (all: string) => void, maxTokens = 4096): Run {
  hook();
  const id = 'ai' + seq++ + '-' + Date.now().toString(36);
  let text = '';
  const done = new Promise<{ text: string; usage: Record<string, number> | null; stop: string }>((res, rej) => {
    listeners.set(id, (ev) => {
      if (ev.type === 'delta') { text += ev.text; onText(text); }
      else if (ev.type === 'done') { listeners.delete(id); res({ text, usage: ev.usage, stop: ev.stop }); }
      else { listeners.delete(id); rej(new Error(ev.message)); }
    });
    gcc.aiSend(id, provider, { model, system, messages, maxTokens }).catch((e) => { listeners.delete(id); rej(e); });
  });
  return { id, done, cancel: () => void gcc.aiCancel(id) };
}

// ---------------------------------------------------------------- answers: light Markdown

export type Block =
  | { k: 'p'; text: string }
  | { k: 'h'; text: string; level: number }
  | { k: 'ul' | 'ol'; items: string[]; start?: number }
  | { k: 'table'; rows: string[][] }
  | { k: 'code'; text: string }
  | { k: 'page'; n: number };

/** split an answer into blocks (paragraphs, lists, tables, page headings) */
export function blocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*=+\s*Page\s+(\d+)\b.*=+\s*$/i))) { out.push({ k: 'page', n: +m[1] }); i++; continue; }
    if (l.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push({ k: 'code', text: body.join('\n') });
      continue;
    }
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { out.push({ k: 'h', level: m[1].length, text: m[2] }); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      out.push({ k: 'table', rows });
      continue;
    }
    // lists: an indented line under an item carries that item on (a wrapped item is one item -
    // a numbered list doesn't start again at 1); numbered lists keep their first number
    const listOf = (item: RegExp) => {
      const items: string[] = [];
      while (i < lines.length) {
        const L = lines[i];
        if (item.test(L)) { items.push(L.replace(item, '')); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(L) && !/^\s*([-*•]|\d+[.)])\s+/.test(L)) { items[items.length - 1] += ' ' + L.trim(); i++; continue; }
        break;
      }
      return items;
    };
    if (/^\s*[-*•]\s+/.test(l)) { out.push({ k: 'ul', items: listOf(/^\s*[-*•]\s+/) }); continue; }
    if ((m = l.match(/^\s*(\d+)[.)]\s+/))) { const start = +m[1]; out.push({ k: 'ol', items: listOf(/^\s*\d+[.)]\s+/), start }); continue; }
    // a paragraph: at least this line (also a half-written table row or heading while the
    // answer is still streaming in), then the lines up to the next block
    const para: string[] = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(lines[i]) && !/^\s*=+\s*Page\s+\d+/i.test(lines[i])) para.push(lines[i++]);
    out.push({ k: 'p', text: para.join('\n') });
  }
  return out;
}

/** inline pieces: plain text, **bold**, `code`, and page citations [p. 12] / [pp. 3-5] / [p. 4, 7] */
export type Inline = { k: 't' | 'b' | 'c'; text: string } | { k: 'cite'; label: string; page: number };
export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[(?:pp?\.|page|pages|ص\.?)\s*([\d\s,\-–]+)\]/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ k: 't', text: s.slice(last, m.index) });
    if (m[1] != null) out.push({ k: 'b', text: m[1] });
    else if (m[2] != null) out.push({ k: 'c', text: m[2] });
    else {
      // each page number in the citation becomes its own link
      for (const part of m[3].split(',')) {
        const r = part.trim().split(/[-–]/).map((x) => parseInt(x, 10)).filter((x) => x > 0);
        if (r.length) out.push({ k: 'cite', label: part.trim(), page: r[0] });
      }
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ k: 't', text: s.slice(last) });
  return out;
}

export const isRtl = (s: string) => {
  const ar = (s.match(/[֐-ࣿ]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  return ar > lat;
};

/** a translation (Markdown-ish) as a printable HTML page, Arabic right-to-left */
export function translationHtml(title: string, md: string, lang: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inl = (t: string) => inline(t).map((x) => x.k === 'b' ? `<b>${esc(x.text)}</b>` : x.k === 'c' ? `<code>${esc(x.text)}</code>` : x.k === 'cite' ? esc(`[p. ${x.label}]`) : esc(x.text)).join('');
  const rtl = /arab|urdu|farsi|persian|hebrew/i.test(lang) || isRtl(md);
  let body = '';
  let first = true;
  for (const b of blocks(md)) {
    if (b.k === 'page') { body += `<h2 class="pg${first ? ' first' : ''}">${rtl ? 'صفحة' : 'Page'} ${b.n}</h2>`; first = false; continue; }
    if (b.k === 'h') body += `<h${b.level + 2}>${inl(b.text)}</h${b.level + 2}>`;
    else if (b.k === 'p') body += `<p>${inl(b.text).replace(/\n/g, '<br>')}</p>`;
    else if (b.k === 'ul' || b.k === 'ol') body += `<${b.k}>${b.items.map((x) => `<li>${inl(x)}</li>`).join('')}</${b.k}>`;
    else if (b.k === 'table') body += `<table>${b.rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${inl(c)}</td>` : `<th>${inl(c)}</th>`)).join('')}</tr>`).join('')}</table>`;
    else if (b.k === 'code') body += `<pre>${esc(b.text)}</pre>`;
  }
  return `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}" lang="${rtl ? 'ar' : 'en'}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:"Segoe UI","Noto Naskh Arabic","Arial",sans-serif;font-size:11pt;line-height:1.55;color:#111}
h1{font-size:15pt;margin:0 0 4pt} .sub{color:#666;font-size:9pt;margin-bottom:14pt}
h2.pg{font-size:12pt;color:#09302f;border-bottom:1px solid #c9a86a;padding-bottom:2pt;margin-top:18pt;break-before:page} h2.pg.first{break-before:auto}
table{border-collapse:collapse;margin:6pt 0;width:100%} td,th{border:1px solid #bbb;padding:3pt 5pt;vertical-align:top} th{background:#f2efe6}
pre{white-space:pre-wrap;font-family:Consolas,monospace;font-size:9.5pt}
</style></head><body><h1>${esc(title)}</h1><div class="sub">${esc(lang)} – machine translation</div>${body}</body></html>`;
}
