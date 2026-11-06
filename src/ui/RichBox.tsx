// The typing box of a text box / callout / typewriter: rich text, typed in place. Bold, italic,
// underline, colour, size and font act on the selected text only (nothing selected: the caller
// gives the whole box the style). The text is plain text in styled spans; the browser types into
// them ("plaintext-only": no markup of its own, pasting gives plain text), and the text with its
// styles is read back after every change. Undo / redo (Ctrl+Z / Ctrl+Y) are its own: the
// browser's own undo doesn't know about styles set from the bar.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type MutableRefObject } from 'react';
import { famCss } from './fontlist';
import { joinRuns, runsText, styleOf, styleRange, rangeStyle, type TextRun, type RunStyle, type BaseStyle, type FullStyle } from '../engine/richtext';

export interface RichApi {
  /** the selection, as positions in the text */
  sel(): [number, number];
  /** a style for the selected text; false: nothing selected (left to the caller) */
  format(patch: RunStyle): boolean;
  /** a style for all of the text (the selection kept) */
  formatAll(patch: RunStyle): void;
  /** the style of the selection (nothing selected: of all the text) - for the bar */
  style(): Partial<FullStyle>;
  /** the text and its styles as they are now */
  model(): { text: string; runs: TextRun[] | undefined };
  el(): HTMLDivElement | null;
}

interface Props {
  value: string;
  runs?: TextRun[];
  base: BaseStyle;
  className: string;
  style: CSSProperties;
  placeholder?: string;
  apiRef: MutableRefObject<RichApi | null>;
  /** the text or its styles changed (typed, pasted, styled, undone) */
  onChange(value: string, runs: TextRun[] | undefined): void;
  /** the selection moved or its style changed (the bar shows what it would act on) */
  onSelStyle?(s: Partial<FullStyle>): void;
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
  onBlur(): void;
  /** a ref to the element (sizing) */
  elRef?: MutableRefObject<HTMLDivElement | null>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
const rgb = (c: number[]) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})`;

/** a run's own look on top of the box's (sizes relative to the box's: zooming needs no redraw) */
function spanCss(r: RunStyle, base: BaseStyle): string {
  const out: string[] = [];
  if (r.b !== undefined) out.push(`font-weight:${r.b ? 700 : 400}`);
  if (r.i !== undefined) out.push(`font-style:${r.i ? 'italic' : 'normal'}`);
  if (r.u) out.push('text-decoration:underline');
  if (r.c) out.push(`color:${rgb(r.c)}`);
  if (r.s) out.push(`font-size:${+(r.s / base.size).toFixed(4)}em`);
  if (r.f) out.push(`font-family:${famCss(r.f)}`);
  return out.join(';');
}

/** the text and its styles as the box holds them (a line end the browser keeps at the end so the
 *  last line shows - "\n" or <br> - is not part of the text) */
function readDom(root: HTMLElement): TextRun[] {
  const out: TextRun[] = [];
  const walk = (n: Node, st: RunStyle) => {
    n.childNodes.forEach((c) => {
      if (c.nodeType === Node.TEXT_NODE) { const t = (c.nodeValue || '').replace(/\r\n?/g, '\n').replace(/ /g, ' '); if (t) out.push({ ...st, t }); return; }
      if (c.nodeName === 'BR') { out.push({ ...st, t: '\n' }); return; }
      if (c.nodeType !== Node.ELEMENT_NODE) return;
      const el = c as HTMLElement;
      let s2 = st;
      const r = el.getAttribute('data-r');
      if (r !== null) { try { s2 = JSON.parse(r) as RunStyle; } catch { s2 = st; } }
      // (blocks: a new line - not made by this box, but text pasted or dropped in some way)
      if ((el.nodeName === 'DIV' || el.nodeName === 'P') && out.length && !out[out.length - 1].t.endsWith('\n')) out.push({ ...st, t: '\n' });
      walk(el, s2);
    });
  };
  walk(root, {});
  const runs = joinRuns(out);
  const last = runs[runs.length - 1];
  if (last && last.t.endsWith('\n')) { last.t = last.t.slice(0, -1); if (!last.t) runs.pop(); }
  return runs;
}

/** the text's leaves in order: text nodes and line breaks (one character each) */
function leaves(root: Node): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => n.childNodes.forEach((c) => { if (c.nodeType === Node.TEXT_NODE || c.nodeName === 'BR') out.push(c); else walk(c); });
  walk(root);
  return out;
}
const lenOf = (n: Node) => (n.nodeType === Node.TEXT_NODE ? (n.nodeValue || '').length : 1);

/** a DOM position as a position in the text */
function offsetOf(root: Node, node: Node, off: number): number {
  if (node !== root && !root.contains(node)) return 0;
  const r = document.createRange();
  r.setStart(root, 0);
  try { r.setEnd(node, off); } catch { return 0; }
  let pos = 0;
  for (const l of leaves(root)) {
    if (l === node) { pos += off; break; }
    // (a leaf counts when it ends at or before the point)
    const inside = l.nodeType === Node.TEXT_NODE ? r.comparePoint(l, lenOf(l)) : r.comparePoint(l.parentNode!, Array.prototype.indexOf.call(l.parentNode!.childNodes, l) + 1);
    if (inside <= 0) pos += lenOf(l); else break;
  }
  return pos;
}

/** a position in the text as a DOM position: at a change of style, the end of the text before
 *  (typing goes on in its style, as in a word processor) - after a line end, the start of the next */
function pointAt(root: HTMLElement, pos: number): [Node, number] {
  let p = 0;
  const ls = leaves(root);
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i], n = lenOf(l);
    if (l.nodeType === Node.TEXT_NODE) {
      const t = l.nodeValue || '';
      if (pos < p + n || (pos === p + n && t[n - 1] !== '\n' && n > 0)) return [l, Math.max(0, pos - p)];
    } else if (pos === p) return [l.parentNode!, Array.prototype.indexOf.call(l.parentNode!.childNodes, l)];
    p += n;
  }
  return [root, root.childNodes.length];
}

export function RichBox(p: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const P = useRef(p);
  P.current = p;
  /** the text and styles now (as typed); runs always cover the whole text here */
  const model = useRef<{ text: string; runs: TextRun[] }>({ text: p.value, runs: p.runs ? p.runs.map((r) => ({ ...r })) : p.value ? [{ t: p.value }] : [] });
  /** what was last handed out / taken in: props equal to it are this box's own state coming back */
  const given = useRef<{ value: string; runs?: TextRun[] }>({ value: p.value, runs: p.runs });
  const hist = useRef<{ undo: { runs: TextRun[]; s: number; e: number }[]; redo: { runs: TextRun[]; s: number; e: number }[]; t: number; kind: string }>({ undo: [], redo: [], t: 0, kind: '' });
  const baseKey = JSON.stringify(p.base);

  const sel = (): [number, number] => {
    const root = ref.current, s = window.getSelection();
    if (!root || !s || !s.rangeCount) return [model.current.text.length, model.current.text.length];
    const r = s.getRangeAt(0);
    if (!root.contains(r.startContainer) && r.startContainer !== root) return [model.current.text.length, model.current.text.length];
    const L = model.current.text.length;
    const a = Math.min(L, offsetOf(root, r.startContainer, r.startOffset)), b = Math.min(L, offsetOf(root, r.endContainer, r.endOffset));
    return a <= b ? [a, b] : [b, a];
  };
  const setSel = (s: number, e: number) => {
    const root = ref.current, ws = window.getSelection();
    if (!root || !ws) return;
    const [an, ao] = pointAt(root, s), [bn, bo] = s === e ? [an, ao] : pointAt(root, e);
    try { const r = document.createRange(); r.setStart(an, ao); r.setEnd(bn, bo); ws.removeAllRanges(); ws.addRange(r); } catch { /* left */ }
  };
  /** the box drawn from the model (the selection kept) */
  const render = (keepSel = true) => {
    const root = ref.current;
    if (!root) return;
    const had = keepSel && document.activeElement === root ? sel() : null;
    const { runs, text } = model.current;
    const base = P.current.base;
    root.innerHTML = runs.map((r) => `<span data-r="${attr(JSON.stringify(styleOf(r)))}"${spanCss(r, base) ? ` style="${attr(spanCss(r, base))}"` : ''}>${esc(r.t)}</span>`).join('') + (text.endsWith('\n') ? '<br>' : '');
    root.toggleAttribute('data-empty', !text);
    if (had) setSel(had[0], had[1]);
  };
  const outRuns = (): TextRun[] | undefined => {
    const rs = model.current.runs;
    return rs.some((r) => Object.keys(r).length > 1) ? rs.map((r) => ({ ...r })) : undefined;
  };
  const emit = () => {
    const v = model.current.text, runs = outRuns();
    given.current = { value: v, runs };
    P.current.onChange(v, runs);
    tell();
  };
  const tell = () => { const [s, e] = sel(); P.current.onSelStyle?.(rangeStyle(P.current.base, model.current.runs, s, e)); };
  const snap = () => {
    const [s, e] = sel();
    const h = hist.current;
    h.undo.push({ runs: model.current.runs.map((r) => ({ ...r })), s, e });
    if (h.undo.length > 200) h.undo.shift();
    h.redo = [];
  };
  const restore = (from: 'undo' | 'redo') => {
    const h = hist.current;
    const st = h[from].pop();
    if (!st) return;
    const [s, e] = sel();
    h[from === 'undo' ? 'redo' : 'undo'].push({ runs: model.current.runs.map((r) => ({ ...r })), s, e });
    model.current = { runs: st.runs, text: runsText(st.runs) };
    h.kind = '';
    render(false);
    setSel(st.s, st.e);
    emit();
  };

  // the first drawing; the caret at the end of the text
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    render(false);
    root.focus();
    const n = model.current.text.length;
    setSel(n, n);
    tell();
  }, []);

  // changed from outside (the whole box given a style: its runs lose that style; the box's own
  // style changed: sizes are relative to it) - drawn again; this box's own changes coming back: not
  const lastBase = useRef(baseKey);
  useLayoutEffect(() => {
    const g = given.current;
    const same = g.value === p.value && g.runs === p.runs;
    if (same && lastBase.current === baseKey) return;
    lastBase.current = baseKey;
    if (!same) {
      given.current = { value: p.value, runs: p.runs };
      const runs = p.runs ? p.runs.map((r) => ({ ...r })) : p.value ? [{ t: p.value }] : [];
      model.current = { runs, text: p.value };
    }
    render();
    tell();
  }, [p.value, p.runs, baseKey]);

  useEffect(() => {
    const f = () => { const root = ref.current, s = window.getSelection(); if (root && s && s.rangeCount && root.contains(s.anchorNode)) tell(); };
    document.addEventListener('selectionchange', f);
    return () => document.removeEventListener('selectionchange', f);
  }, []);

  const restyleRange = (s: number, e: number, patch: RunStyle) => {
    const [a, b] = sel();
    snap();
    hist.current.kind = '';
    const runs = styleRange(model.current.runs, s, e, patch);
    model.current = { runs, text: runsText(runs) };
    render(false);
    setSel(a, b);
    emit();
  };
  useImperativeHandle(p.apiRef, () => ({
    sel,
    formatAll(patch: RunStyle) { if (model.current.text) restyleRange(0, model.current.text.length, patch); },
    format(patch: RunStyle) {
      const [s, e] = sel();
      if (s === e) return false;
      snap();
      hist.current.kind = '';
      const runs = styleRange(model.current.runs, s, e, patch);
      model.current = { runs, text: runsText(runs) };
      render(false);
      setSel(s, e);
      emit();
      return true;
    },
    style() { const [s, e] = sel(); return rangeStyle(P.current.base, model.current.runs, s, e); },
    model: () => ({ text: model.current.text, runs: outRuns() }),
    el: () => ref.current,
  }));

  const onBeforeInput = (e: InputEvent) => {
    const t = e.inputType || '';
    if (t === 'historyUndo' || t === 'historyRedo') { e.preventDefault(); restore(t === 'historyUndo' ? 'undo' : 'redo'); return; }
    if (t.startsWith('format')) { e.preventDefault(); return; }
    // typing: a step every second or so, or when it turns from typing to deleting; pasting, dropping: a step each
    const kind = t.startsWith('delete') ? 'del' : t === 'insertFromPaste' || t === 'insertFromDrop' ? 'paste' : 'ins';
    const h = hist.current, now = performance.now();
    if (kind === 'paste' || kind !== h.kind || now - h.t > 1000) snap();
    h.kind = kind === 'paste' ? '' : kind;
    h.t = now;
  };
  const onInput = () => {
    const root = ref.current;
    if (!root) return;
    const runs = readDom(root);
    model.current = { runs, text: runsText(runs) };
    root.toggleAttribute('data-empty', !model.current.text);
    // (a text box emptied: the browser's leftover line break would keep the empty-box hint away)
    if (!model.current.text && root.innerHTML) root.innerHTML = '';
    emit();
  };
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const f = (e: Event) => onBeforeInput(e as InputEvent);
    root.addEventListener('beforeinput', f);
    return () => root.removeEventListener('beforeinput', f);
  }, []);

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (k === 'z' || k === 'y')) {
      e.preventDefault(); e.stopPropagation();
      restore(k === 'y' || e.shiftKey ? 'redo' : 'undo');
      return;
    }
    P.current.onKeyDown(e);
  };

  return (
    <div
      ref={(el) => { ref.current = el; if (p.elRef) p.elRef.current = el; }}
      className={p.className}
      style={p.style}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      // (the box's direction from its first letter; each paragraph its own - unicode-bidi: plaintext)
      dir="auto"
      spellCheck
      role="textbox"
      aria-multiline="true"
      data-ph={p.placeholder || undefined}
      onInput={onInput}
      onKeyDown={keys}
      onBlur={() => P.current.onBlur()}
      // (dropping text from elsewhere in the window: as plain text, like pasting)
      onDrop={(e) => { if (!e.dataTransfer?.getData('text/plain')) e.preventDefault(); }}
    />
  );
}
