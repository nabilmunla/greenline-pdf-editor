// Built-in stamps (vector, house colours) + the user's own. {name} {date} {time} fill in when placed.
import type { StampDesign, RGB } from '../engine/mu';

/** real: w / h are its real size (from a scan) - placed at that size on any sheet */
export interface StampDef { id: string; name: string; design?: StampDesign; image?: string /* PNG data URL */; w?: number; h?: number; builtin?: boolean; real?: boolean }

const GREEN: RGB = [0.08, 0.5, 0.25];
const RED: RGB = [0.75, 0.1, 0.1];
const TEAL: RGB = [0.035, 0.19, 0.184];
const GOLD: RGB = [0.57, 0.29, 0.13];
const BLUE: RGB = [0.1, 0.3, 0.7];

const s = (id: string, title: string, color: RGB, sub = '{name} – {date}', border: StampDesign['border'] = 'double'): StampDef => ({
  id, name: title, builtin: true,
  design: { lines: [{ text: title, size: 18, bold: true }, ...(sub ? [{ text: sub, size: 8 }] : [])], color, border, fill: color, fillOpacity: 0.06 },
});

export const BUILTIN_STAMPS: StampDef[] = [
  s('approved', 'APPROVED', GREEN),
  s('approved-noted', 'APPROVED AS NOTED', GREEN),
  s('reviewed', 'REVIEWED', TEAL),
  s('revise', 'REVISE & RESUBMIT', GOLD),
  s('rejected', 'REJECTED', RED),
  s('received', 'RECEIVED', TEAL, '{date} {time} – {name}'),
  s('for-tender', 'FOR TENDER', BLUE, '{date}'),
  s('for-info', 'FOR INFORMATION', BLUE),
  s('for-construction', 'FOR CONSTRUCTION', GREEN),
  s('not-for-construction', 'NOT FOR CONSTRUCTION', RED, ''),
  s('preliminary', 'PRELIMINARY', GOLD, ''),
  s('draft', 'DRAFT', GOLD, '', 'rounded'),
  s('confidential', 'CONFIDENTIAL', RED, '', 'rounded'),
  s('void', 'VOID', RED, '', 'box'),
  s('completed', 'COMPLETED', GREEN, '{date}'),
  s('superseded', 'SUPERSEDED', RED, '{date}'),
];

export function fillFields(d: StampDesign, name: string): StampDesign {
  const now = new Date();
  const date = now.toLocaleDateString('en-GB');
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return { ...d, lines: d.lines.map((l) => ({ ...l, text: l.text.replace(/\{name\}/g, name).replace(/\{date\}/g, date).replace(/\{time\}/g, time) })) };
}

/** Helvetica / Helvetica-Bold widths (1/1000 em) as the engine measures a stamp's lines (its own
 *  copies of the fonts): characters 32-126, 160-255, then the few beyond that the stamps use */
const W_EXTRA = [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x20ac, 0x2122];
function widths(ascii: string, latin: string, extra: string): Map<number, number> {
  const m = new Map<number, number>();
  ascii.split(',').forEach((w, i) => m.set(32 + i, Number(w)));
  latin.split(',').forEach((w, i) => m.set(160 + i, Number(w)));
  extra.split(',').forEach((w, i) => m.set(W_EXTRA[i], Number(w)));
  return m;
}
const HELV = widths(
  '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584',
  '278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500',
  '556,1000,222,222,333,333,350,556,1000');
const HELV_B = widths(
  '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584',
  '278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556',
  '556,1000,278,278,500,500,350,556,1000');

/** width of a line of a stamp in points */
export function lineWidth(text: string, size: number, bold?: boolean): number {
  const t = bold ? HELV_B : HELV;
  let w = 0;
  // (other letters - Latin with accents beyond Western European, Greek, Cyrillic: a typical width)
  for (const ch of text) w += t.get(ch.codePointAt(0)!) ?? (bold ? 611 : 556);
  return (w / 1000) * size;
}

/**
 * Size in points, worked out as the engine does (stampSize in mu.ts): a box dragged or clicked
 * gets the proportions the stamp will really have. (Guessed widths per letter made the engine
 * redo the height - placed stamps hung 5-30 % below their box.)
 */
export function designSize(d: StampDesign): [number, number] {
  const pad = 8;
  let w = 0, h = pad;
  for (const l of d.lines) { w = Math.max(w, lineWidth(l.text, l.size, l.bold)); h += l.size * 1.18; }
  return [w + pad * 2 + (d.border === 'double' ? 6 : 0), h + pad + (d.border === 'double' ? 6 : 0)];
}

export const dataUrlToBytes = (u: string) => {
  const b = atob(u.split(',')[1]);
  const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
};
export const bytesToDataUrl = (b: Uint8Array, type = 'image/png') => {
  let s2 = '';
  for (let i = 0; i < b.length; i += 0x8000) s2 += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${type};base64,` + btoa(s2);
};
