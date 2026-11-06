// Tools: what each one draws and its default look.
import type { MeasureFmt } from './geom';
import type { RGB } from '../engine/mu';

export type ToolId =
  | 'select' | 'hand' | 'zoom' | 'snapshot'
  | 'highlight' | 'area-highlight' | 'underline' | 'strike' | 'squiggly'
  | 'note' | 'textbox' | 'typewriter' | 'callout'
  | 'rect' | 'ellipse' | 'line' | 'arrow' | 'polyline' | 'polygon' | 'cloud' | 'pencil'
  | 'stamp' | 'image' | 'signature'
  | 'm-length' | 'm-polylength' | 'm-area' | 'm-rectarea' | 'm-perimeter' | 'm-count' | 'm-angle' | 'm-calibrate' | 'm-viewport'
  | 'redact-area' | 'redact-text' | 'edit-text' | 'table' | 'crop' | 'ocr-area' | 'stamp-grab' | 'link';

export type Gesture = 'none' | 'rect' | 'two' | 'poly' | 'ink' | 'text' | 'click' | 'callout';
/** how an Area or Perimeter is drawn: corners clicked, a rectangle, a circle */
export type MeasureHow = 'points' | 'rect' | 'circle';
export const HOW_HINT: Record<MeasureHow, string> = {
  points: 'Click the corners; double-click or Enter to finish. Type a length (4200, 4.2 m) and Enter for the next corner that far along.',
  rect: 'Drag from one corner to the opposite one - or click the two corners. Shift = a square.',
  circle: 'Click the middle, then a point on the edge (or drag from the middle out).',
};

export interface Style {
  color: RGB | null;
  fill: RGB | null;
  opacity: number;
  width: number;
  dash: boolean;
  cloudy: number;
  fontSize: number;
  fontColor: RGB;
  /** text box font: Helv / TiRo / Cour or a typeface from the PC; bold, italic */
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  le: [string, string];
  /** redaction: the box left where content was removed - a colour, 'auto' (the page's own
   *  colour around it, so it blends in) or 'none' */
  redact?: number[] | 'auto' | 'none';
  /** measuring: unit and decimals of the numbers (one setting for all measuring tools) */
  fmt?: MeasureFmt;
}

export const RED: RGB = [0.86, 0.13, 0.13];
export const BLUE: RGB = [0.1, 0.35, 0.85];
export const TEAL: RGB = [0.035, 0.19, 0.184];
export const YELLOW: RGB = [1, 0.9, 0.15];

const base: Style = { color: RED, fill: null, opacity: 1, width: 1.5, dash: false, cloudy: 0, fontSize: 11, fontColor: [0.1, 0.1, 0.1], le: ['None', 'None'] };

/** tools that draw no markup of their own (no colour, line or opacity to set) */
export const NO_STYLE: ToolId[] = ['select', 'hand', 'zoom', 'snapshot', 'table', 'link', 'crop', 'ocr-area', 'edit-text', 'm-calibrate', 'm-viewport', 'redact-area', 'redact-text', 'stamp', 'image', 'signature', 'stamp-grab'];

export interface ToolDef { label: string; gesture: Gesture; key?: string; style?: Partial<Style>; hint: string; snaps?: boolean }

export const TOOLS: Record<ToolId, ToolDef> = {
  select: { label: 'Select', gesture: 'none', key: 'v', hint: 'Click a markup to select it, drag text to select text. Drag a markup to move it.' },
  hand: { label: 'Hand', gesture: 'none', key: 'h', hint: 'Drag to move around. Hold Space with any tool for the same.' },
  zoom: { label: 'Zoom area', gesture: 'rect', key: 'z', hint: 'Drag a box to zoom into it.' },
  snapshot: { label: 'Snapshot', gesture: 'rect', key: 'g', hint: 'Drag a box: the area is copied as a picture (paste into Word, Outlook, Excel).' },
  'stamp-grab': { label: 'Stamp from page', gesture: 'rect', hint: 'Drag a box round a stamp on this page (a scan): it is cleaned up - paper removed, straightened - to save as one of your stamps.' },
  highlight: { label: 'Highlight', gesture: 'text', key: 'i', style: { color: YELLOW }, hint: 'Drag over text to highlight it. Drag on an empty spot to highlight an area.' },
  'area-highlight': { label: 'Area highlight', gesture: 'rect', style: { color: YELLOW }, hint: 'Drag a box to highlight an area.' },
  underline: { label: 'Underline', gesture: 'text', key: 'u', style: { color: BLUE }, hint: 'Drag over text to underline it.' },
  strike: { label: 'Strikeout', gesture: 'text', key: 'k', style: { color: RED }, hint: 'Drag over text to strike it out.' },
  squiggly: { label: 'Squiggly', gesture: 'text', style: { color: [0.1, 0.6, 0.2] }, hint: 'Drag over text to underline it with a wavy line.' },
  note: { label: 'Comment', gesture: 'click', key: 'n', style: { color: YELLOW }, hint: 'Click where the comment goes, then type it.' },
  textbox: { label: 'Text box', gesture: 'rect', key: 't', style: { color: null, fontColor: RED, width: 1 }, hint: 'Drag a box (or click) and type.' },
  typewriter: { label: 'Typewriter', gesture: 'click', style: { color: null, fontColor: [0, 0, 0], width: 0 }, hint: 'Click and type – plain text without a box.' },
  callout: { label: 'Callout', gesture: 'callout', key: 'q', style: { color: [1, 1, 0.85], fontColor: RED, width: 1 }, hint: 'Click the point the arrow shows, then click (or drag) where the text goes.' },
  rect: { label: 'Rectangle', gesture: 'rect', key: 'r', snaps: true, hint: 'Drag a box. Shift = square.' },
  ellipse: { label: 'Ellipse', gesture: 'rect', key: 'e', snaps: true, hint: 'Drag. Shift = circle.' },
  line: { label: 'Line', gesture: 'two', key: 'l', snaps: true, hint: 'Drag, or click two points. Shift = 0/45/90°.' },
  arrow: { label: 'Arrow', gesture: 'two', key: 'a', snaps: true, style: { le: ['None', 'ClosedArrow'] }, hint: 'Drag, or click two points. Shift = 0/45/90°.' },
  polyline: { label: 'Polyline', gesture: 'poly', snaps: true, hint: 'Click points. Double-click or Enter to finish, Ctrl+Z or Backspace takes back a point.' },
  polygon: { label: 'Polygon', gesture: 'poly', snaps: true, hint: 'Click corners. Double-click or Enter to finish (it closes itself).' },
  cloud: { label: 'Cloud', gesture: 'poly', key: 'c', snaps: true, style: { cloudy: 1 }, hint: 'Click corners around what to cloud; double-click or Enter to finish. Or drag a box.' },
  pencil: { label: 'Pencil', gesture: 'ink', key: 'p', style: { width: 2 }, hint: 'Draw freehand.' },
  stamp: { label: 'Stamp', gesture: 'rect', hint: 'Click to place the stamp (or drag to size it).' },
  image: { label: 'Image', gesture: 'rect', hint: 'Click to place the picture (or drag to size it).' },
  signature: { label: 'Signature', gesture: 'rect', hint: 'Click to place your signature (or drag to size it).' },
  'm-length': { label: 'Length', gesture: 'two', key: 'm', snaps: true, style: { color: BLUE, le: ['OpenArrow', 'OpenArrow'], width: 1 }, hint: 'Click two points (snaps to line ends). Shift = 0/45/90°. After the first point, type a length (4200, 4.2 m) and Enter.' },
  'm-polylength': { label: 'Polylength', gesture: 'poly', snaps: true, style: { color: BLUE, width: 1.5 }, hint: 'Click points along the run; double-click or Enter to finish. Ctrl+Z takes back a point, Esc cancels. Type a length (4200, 4.2 m) and Enter for the next point that far along.' },
  'm-area': { label: 'Area', gesture: 'poly', snaps: true, style: { color: BLUE, fill: [0.55, 0.75, 1], opacity: 0.55, width: 1 }, hint: 'Area and perimeter: click the corners; double-click or Enter to finish. Ctrl+Z takes back a corner, Esc cancels.' },
  'm-rectarea': { label: 'Rectangle area', gesture: 'two', snaps: true, style: { color: BLUE, fill: [0.55, 0.75, 1], opacity: 0.55, width: 1 }, hint: 'Drag from one corner to the opposite one - or click the two corners. Shift = a square.' },
  'm-perimeter': { label: 'Perimeter', gesture: 'poly', snaps: true, style: { color: BLUE, width: 1.5 }, hint: 'Click the corners; double-click or Enter to finish. Ctrl+Z takes back a corner, Esc cancels.' },
  'm-count': { label: 'Count', gesture: 'click', style: { color: RED, fill: RED }, hint: 'Click each item to count it. Backspace takes back the last one.' },
  'm-angle': { label: 'Angle', gesture: 'poly', snaps: true, style: { color: BLUE, width: 1 }, hint: 'Click three points: start, corner, end.' },
  'm-calibrate': { label: 'Calibrate', gesture: 'two', snaps: true, hint: 'Click both ends of a dimension you know, then type its real length.' },
  'm-viewport': { label: 'Viewport', gesture: 'rect', hint: 'Drag a box around a detail drawn at a different scale.' },
  'redact-area': { label: 'Redact area', gesture: 'rect', style: { redact: [0, 0, 0] }, hint: 'Drag over what must be removed. Nothing is removed until you press Apply.' },
  'redact-text': { label: 'Redact text', gesture: 'text', style: { redact: [0, 0, 0] }, hint: 'Drag over text that must be removed. Nothing is removed until you press Apply.' },
  'edit-text': { label: 'Edit text', gesture: 'click', hint: 'Click a line of text to change it. Enter to finish, Esc to cancel.' },
  table: { label: 'Table to Excel', gesture: 'rect', hint: 'Drag a box around a table (on a drawing too): it is copied for pasting and can be saved as an Excel file of just that area.' },
  crop: { label: 'Crop', gesture: 'rect', hint: 'Drag the area to keep.' },
  link: { label: 'Link', gesture: 'rect', hint: 'Drag a box over what is to be clicked (a sheet number, a reference) to make a link; click a link to change or delete it.' },
  'ocr-area': { label: 'Read area', gesture: 'rect', hint: 'Drag a box: the text in it (also on scans) is read and copied.' },
};

export function toolStyle(t: ToolId, custom?: Partial<Style>): Style {
  return { ...base, ...(TOOLS[t].style || {}), ...(custom || {}) };
}

export const MEASURE_TOOLS: ToolId[] = ['m-length', 'm-polylength', 'm-area', 'm-rectarea', 'm-perimeter', 'm-count', 'm-angle', 'm-calibrate'];

export const PALETTE: RGB[] = [
  [0.86, 0.13, 0.13], [0.95, 0.45, 0.1], [1, 0.9, 0.15], [0.2, 0.65, 0.25], [0.1, 0.35, 0.85], [0.45, 0.25, 0.75],
  [0.035, 0.19, 0.184], [0.69, 0.47, 0.25], [0, 0, 0], [0.45, 0.45, 0.45], [1, 1, 1], [1, 0.6, 0.75],
];

export const css = (c: RGB | number[] | null | undefined, a = 1) => (c ? `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})` : 'transparent');
export const hex = (c: RGB | number[] | null | undefined) => (c ? '#' + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('') : '');
export const fromHex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/** said where a text tool's size is picked: new text on a bigger sheet is made bigger with it
 *  (Viewer.tsx sheetK) - the size picked came out as 18, 36 or 48 pt with nothing saying why */
export const BIG_SHEET_TEXT = 'On bigger sheets new text is made bigger with the sheet, to read as on A4: ×1.5 on A3, ×2 on A2, ×3 on A1, ×4 on A0 (lines a little thicker). The size picked here is for A4.';
