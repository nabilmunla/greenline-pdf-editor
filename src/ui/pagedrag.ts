// Dragging pages out of the Pages panel: they become a real PDF file (in a temp folder)
// handed to Windows as a file drag, so they can be dropped on the desktop, in Explorer,
// in an Outlook email - or into another open file here (we recognise our own temp files).
import { gcc } from './api';
import type { PdfDoc } from './doc';

export interface DraggedPages { doc: string; pages: number[]; name: string }
/** temp file path -> where its pages came from */
export const dragged = new Map<string, DraggedPages>();

export function pagesLabel(pages: number[]): string {
  const s = [...pages].sort((a, b) => a - b);
  if (s.length === 1) return 'page ' + (s[0] + 1);
  const contiguous = s.every((v, i) => i === 0 || v === s[i - 1] + 1);
  return contiguous ? `pages ${s[0] + 1}-${s[s.length - 1] + 1}` : `${s.length} pages`;
}

export function fileNameFor(doc: PdfDoc, pages: number[]): string {
  const base = doc.name.replace(/\.pdf$/i, '');
  return `${base} - ${pagesLabel(pages)}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
}

/** write the pages as a PDF in a temp folder; returns its path */
export async function prepare(doc: PdfDoc, pages: number[]): Promise<string> {
  const sorted = [...pages].sort((a, b) => a - b);
  const tmp = await doc.extract(sorted);
  const name = fileNameFor(doc, sorted);
  const path = await gcc.dragPrepare(tmp, name);
  dragged.set(path, { doc: doc.id, pages: sorted, name });
  return path;
}

/** small picture for the mouse pointer during the drag */
export function dragIcon(canvas: HTMLCanvasElement | null, count: number): Uint8Array | null {
  if (!canvas || !canvas.width) return null;
  const w = 96, h = Math.max(24, Math.round((96 * canvas.height) / canvas.width));
  const c = document.createElement('canvas');
  c.width = w + 12; c.height = Math.min(h, 140) + 12;
  const g = c.getContext('2d')!;
  if (count > 1) { g.fillStyle = '#fff'; g.strokeStyle = '#999'; g.fillRect(8, 8, w, c.height - 12); g.strokeRect(8.5, 8.5, w - 1, c.height - 13); }
  g.fillStyle = '#fff';
  g.fillRect(2, 2, w, c.height - 12);
  g.drawImage(canvas, 2, 2, w, c.height - 12);
  g.strokeStyle = '#b07741';
  g.lineWidth = 2;
  g.strokeRect(2, 2, w, c.height - 12);
  if (count > 1) {
    g.fillStyle = '#b07741';
    g.beginPath(); g.arc(w - 6, 14, 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 13px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(count), w - 6, 14.5);
  }
  const b64 = c.toDataURL('image/png').split(',')[1];
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

/**
 * Pages dropped on `target` at `at`. Our own dragged pages: moved (same file) or copied
 * (another file). Returns false for a file that didn't come from here.
 */
export async function dropPages(target: PdfDoc, path: string, at: number, movePages: (pages: number[], to: number) => Promise<void>): Promise<boolean> {
  const info = dragged.get(path);
  if (!info) return false;
  if (info.doc === target.id) { await movePages(info.pages, at); return true; }
  await target.insertFrom(at, path);
  return true;
}
