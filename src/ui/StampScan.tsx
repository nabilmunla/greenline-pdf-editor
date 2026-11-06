// Stamp from a scan or a photo: the picture is cleaned in a background worker (stampclean.ts) and
// shown as it will be placed; the person can move the crop, pick the ink, change the colour, the
// clean-up and the turn, then save it among their stamps.
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Ico } from './icons';
import { gcc, baseName } from './api';
import { muBatch } from './engines';
import { fileArg } from '../engine/rpc';
import { dpiOf, type Box, type CleanOpts, type RGB3 } from './stampclean';
import type { StampDef } from './stamps';
import { css } from './tools';

/** a picture to make a stamp from; ptPerPx: its real size when known (a scan, a page); note: a
 *  line about where it came from (a PDF's first page of several) */
export interface ScanSource { bmp: ImageBitmap; name: string; ptPerPx: number | null; note?: string }

const EXT = ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif', 'pdf'];
/** biggest picture worked on (a 48 MP photo would take seconds for nothing: stamps are small) */
const MAX_SRC = 3300;

/** a picture file - or a scanned PDF's first page - as a picture to clean */
export async function loadScan(path: string): Promise<ScanSource> {
  const name = baseName(path).replace(/\.\w+$/, '');
  if (/\.pdf$/i.test(path)) {
    // the first page at about 300 dpi (an A4 sheet 2,480 px across)
    // (the first page on white, at 300 dpi - as sharp as the limit allows for a big drawing)
    const t = await muBatch<{ bmp: ImageBitmap; w: number; h: number; s: number; pages: number }>('pagePicture', fileArg(path), 0, 300, MAX_SRC);
    return { bmp: t.bmp, name, ptPerPx: t.s > 0 ? 1 / t.s : null, note: t.pages > 1 ? `Page 1 of ${t.pages}. For another page: open the PDF, then Stamp > From a page.` : undefined };
  }
  const bytes = await gcc.read(path);
  const bmp = await createImageBitmap(new Blob([bytes as unknown as BlobPart]));
  const dpi = dpiOf(bytes);
  return { bmp, name, ptPerPx: dpi ? 72 / dpi : null };
}

/** a picture on the clipboard (a screenshot, a picture copied from an email) */
export async function pasteScan(): Promise<ScanSource | null> {
  const png = await gcc.pasteImage();
  if (!png) return null;
  return { bmp: await createImageBitmap(new Blob([png as unknown as BlobPart])), name: 'Stamp', ptPerPx: null };
}

/** the picture's pixels (at most MAX_SRC on its long side; k = its pixels per picture pixel) */
function pixelsOf(bmp: ImageBitmap): { w: number; h: number; data: Uint8ClampedArray; k: number } {
  const k = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, w, h);
  return { w, h, data: g.getImageData(0, 0, w, h).data, k };
}

interface Info { W: number; H: number; k: number; ink: RGB3; inkHue: number | null; others: boolean; crop: Box; angle: number }
interface Result { w: number; h: number; data: Uint8ClampedArray; srcW: number; srcH: number; angle: number }

/** the background worker, one call at a time */
class Cleaner {
  private w = new Worker(new URL('./stampclean.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private wait = new Map<number, { ok(v: any): void; no(e: Error): void }>();
  /** the worker failed (it answers every call itself, so this is a worker that could not
   *  start): later calls fail at once with the same words instead of waiting forever */
  private dead: Error | null = null;
  constructor() {
    this.w.onmessage = (e) => { const p = this.wait.get(e.data.id); if (!p) return; this.wait.delete(e.data.id); if (e.data.error) p.no(new Error(e.data.error)); else p.ok(e.data); };
    this.w.onerror = (e) => {
      this.dead = new Error(e.message || 'The picture could not be read.');
      this.w.terminate();
      for (const p of this.wait.values()) p.no(this.dead);
      this.wait.clear();
    };
  }
  call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise<T>((ok, no) => { this.wait.set(id, { ok, no }); this.w.postMessage({ ...msg, id }, transfer); });
  }
  analyse(px: { w: number; h: number; data: Uint8ClampedArray }) { return this.call<{ info: Info }>({ op: 'analyse', w: px.w, h: px.h, data: px.data.buffer }, [px.data.buffer]).then((r) => r.info); }
  clean(opts: CleanOpts) { return this.call<{ w: number; h: number; data: ArrayBuffer; srcW: number; srcH: number; angle: number }>({ op: 'clean', opts }).then((r): Result => ({ ...r, data: new Uint8ClampedArray(r.data) })); }
  pick(x: number, y: number) { return this.call<{ ink: RGB3 }>({ op: 'pick', x, y }).then((r) => r.ink); }
  stop() { this.w.terminate(); }
}

/** clean a picture with the usual settings, no questions (a signature from a scan); null: no ink */
export async function cleanQuick(src: ScanSource, maxSide: number): Promise<{ url: string; w: number; h: number } | null> {
  const c = new Cleaner();
  try {
    await c.analyse(pixelsOf(src.bmp));
    const r = await c.clean({ maxSide });
    return inkIn(r) ? { url: toUrl(r), w: r.w, h: r.h } : null;
  } finally { c.stop(); }
}

/** anything left to make a stamp of (an empty crop, a blank picture: nothing) */
const inkIn = (r: { w: number; h: number; data: Uint8ClampedArray }) => {
  if (r.w < 3 || r.h < 3) return false;
  let n = 0;
  for (let i = 3; i < r.data.length; i += 16) if (r.data[i] > 100 && ++n > 20) return true;
  return false;
};

function toUrl(r: { w: number; h: number; data: Uint8ClampedArray }): string {
  const cv = document.createElement('canvas');
  cv.width = r.w; cv.height = r.h;
  cv.getContext('2d')!.putImageData(new ImageData(r.data as unknown as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
  return cv.toDataURL('image/png');
}

const PRESETS: { name: string; c: RGB3 }[] = [
  { name: 'Blue', c: [0.1, 0.25, 0.72] },
  { name: 'Red', c: [0.78, 0.1, 0.12] },
  { name: 'Green', c: [0.05, 0.48, 0.22] },
  { name: 'Purple', c: [0.42, 0.18, 0.62] },
  { name: 'Black', c: [0.1, 0.1, 0.12] },
];
const MM = 25.4 / 72;

export function StampScanDlg({ src, onBack, onSave, toast }: { src: ScanSource; onBack(): void; onSave(s: StampDef, place: boolean): void; toast(t: string, k?: 'info' | 'err' | 'ok'): void }) {
  const cl = useRef<Cleaner | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [crop, setCrop] = useState<Box>([0, 0, 1, 1]);
  const [colour, setColour] = useState<'ink' | 'scan' | number>('ink');
  const [ink, setInk] = useState<RGB3 | null>(null);
  const [strength, setStrength] = useState(0.5);
  const [removeOther, setRemoveOther] = useState(true);
  const [straighten, setStraighten] = useState(true);
  const [turn, setTurn] = useState(0);
  const [name, setName] = useState(src.name || 'Stamp');
  const [widthMm, setWidthMm] = useState<number | null>(null);
  const [widthTxt, setWidthTxt] = useState<string | null>(null); // (as typed - checked on Enter / leaving)
  const [res, setRes] = useState<Result | null>(null);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // look at the picture once (shrunk if huge: its real size per pixel follows)
  const ptPerPx = useRef(src.ptPerPx);
  const shrunk = useRef(1); // (picture pixels per original pixel)
  useEffect(() => {
    const c = new Cleaner();
    cl.current = c;
    let live = true;
    const px = pixelsOf(src.bmp);
    shrunk.current = px.k;
    ptPerPx.current = src.ptPerPx ? src.ptPerPx / px.k : null;
    c.analyse(px).then((i) => { if (!live) return; setInfo(i); setCrop(i.crop); }).catch((e) => live && setErr(String(e.message || e)));
    return () => { live = false; c.stop(); cl.current = null; };
  }, [src]);

  const opts = (maxSide: number): CleanOpts => ({
    strength, removeOther, ink: ink ?? undefined, crop, straighten, turn, maxSide,
    color: colour === 'scan' ? null : colour === 'ink' ? undefined : PRESETS[colour].c,
  });
  // the preview: again after every change (the newest settings win; one at a time)
  const running = useRef(false), again = useRef(false);
  const now = useRef(opts(560));
  now.current = opts(560);
  useEffect(() => {
    if (!info) return;
    const run = async () => {
      if (running.current) { again.current = true; return; }
      running.current = true;
      try {
        do {
          again.current = false;
          try {
            const r = await cl.current!.clean(now.current);
            setRes(r);
            setErr('');
          } catch (e) { setErr(String((e as Error).message || e)); }
        } while (again.current && cl.current);
      } finally { running.current = false; }
    };
    const t = setTimeout(() => void run(), 40);
    return () => clearTimeout(t);
  }, [info, crop, colour, ink, strength, removeOther, straighten, turn]);

  // size on the page: the real size when the picture says (a scan, a page), else 40 mm across
  const realOf = (r: Result | null) => (r && ptPerPx.current ? r.srcW * ptPerPx.current * MM : null);
  const autoOf = (r: Result) => realOf(r) ?? (r.w >= r.h ? 40 : (40 * r.w) / r.h);
  const realMm = realOf(res);
  const wMm = widthMm ?? (res ? Math.round(autoOf(res) * 10) / 10 : 40);
  const hMm = res ? Math.round(((wMm * res.h) / res.w) * 10) / 10 : 0;
  const empty = !!res && !inkIn(res);
  const takeWidth = () => {
    if (widthTxt === null) return;
    const v = parseFloat(widthTxt.replace(',', '.'));
    if (Number.isFinite(v) && v > 0) setWidthMm(Math.max(3, Math.min(600, Math.round(v * 10) / 10)));
    setWidthTxt(null);
  };

  const save = async (place: boolean) => {
    if (!cl.current || !res) return;
    setSaving(true);
    try {
      // (the stamp as the settings are now - the preview may be a moment behind)
      const r = await cl.current.clean(opts(1100));
      if (!inkIn(r)) { toast('Nothing left to make a stamp of - widen the crop or lower the clean-up.', 'info'); return; }
      const wPt = (widthMm ?? autoOf(r)) / MM, hPt = (wPt * r.h) / r.w;
      // (a width typed in mm is that size on any sheet, like the real size - not scaled up with
      // the sheet as a stamp of no known size is)
      onSave({ id: 'u' + Date.now(), name: name.trim() || 'Stamp', image: toUrl(r), w: Math.round(wPt * 10) / 10, h: Math.round(hPt * 10) / 10, real: widthMm !== null || !!realOf(r) }, place);
    } catch (e) { toast(String((e as Error).message || e), 'err'); } finally { setSaving(false); }
  };
  /** the picture as it is (a logo that is already clean) - the crop and the size still count */
  const asIs = () => {
    // crop: working pixels -> picture pixels -> original pixels
    const f = info ? info.k / shrunk.current : 1;
    const c = info ? crop : ([0, 0, src.bmp.width, src.bmp.height] as Box);
    const sx = Math.max(0, c[0] * f), sy = Math.max(0, c[1] * f), sw = Math.min(src.bmp.width - sx, (c[2] - c[0]) * f), sh = Math.min(src.bmp.height - sy, (c[3] - c[1]) * f);
    if (sw < 2 || sh < 2) return;
    const cv = document.createElement('canvas');
    const k = Math.min(1, 1100 / Math.max(sw, sh));
    cv.width = Math.max(1, Math.round(sw * k)); cv.height = Math.max(1, Math.round(sh * k));
    cv.getContext('2d')!.drawImage(src.bmp, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    const real = src.ptPerPx ? sw * src.ptPerPx * MM : null;
    const wPt = (widthMm ?? real ?? 40) / MM;
    onSave({ id: 'u' + Date.now(), name: name.trim() || 'Stamp', image: cv.toDataURL('image/png'), w: wPt, h: (wPt * cv.height) / cv.width, real: widthMm !== null || !!real }, false);
  };

  // (a short window - 1280 x 720 at 100 %: smaller pictures, so Save is in view without scrolling)
  const [vh, setVh] = useState(window.innerHeight);
  useEffect(() => { const f = () => setVh(window.innerHeight); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  const boxH = Math.max(170, Math.min(340, vh - 560));
  const inkNow = ink ?? info?.ink ?? null;
  // (not shown before the picture was looked at: it then vanished for black ink)
  const coloured = ink ? Math.max(...ink) - Math.min(...ink) > 0.12 : !!info && info.inkHue !== null;
  return (
    <Modal title="Stamp from a scan" wide="xl" onClose={onBack}
      sub="The paper is taken away, the stamp cropped and straightened. Drag on the picture to choose what to keep."
      actions={<>
        {/* (after the picture was looked at - its crop is shown then; clicked before, it took the
            whole photo, a second later the crop. If looking at it failed: the whole picture.) */}
        <button className="btn ghost" style={{ marginRight: 'auto' }} disabled={saving || (!info && !err)} onClick={asIs} title="Keep the picture exactly as it is (a logo that is already clean)">Use the picture as it is</button>
        <button className="btn" onClick={onBack}>Back</button>
        <button className="btn" disabled={!res || empty || saving} onClick={() => void save(false)}>Save stamp</button>
        <button className="btn primary" disabled={!res || empty || saving} onClick={() => void save(true)}>Save &amp; place</button>
      </>}>
      {err ? <p className="hint err">{err}</p> : null}
      {src.note ? <p className="hint">{src.note}</p> : null}
      <div className="sscan">
        <div className="sscan-col">
          <div className="plab">Picture{picking ? ' – click the stamp’s ink' : ''}</div>
          <SourceView src={src} info={info} crop={crop} setCrop={setCrop} picking={picking} boxH={boxH}
            onPick={(x, y) => { setPicking(false); void cl.current?.pick(x, y).then((c) => { setInk(c); setColour('ink'); }); }} />
          {info && <div className="hrow">
            <button className="btn sm" onClick={() => setCrop(info.crop)} title="The stamp as found">Crop: found</button>
            <button className="btn sm" onClick={() => setCrop([0, 0, info.W, info.H])}>Whole picture</button>
            <button className={'btn sm' + (picking ? ' on' : '')} onClick={() => setPicking(!picking)} title="Click the stamp's ink in the picture (when another colour was taken for it)"><Ico n="select" size={14} /> Pick the ink</button>
          </div>}
        </div>
        <div className="sscan-col">
          <div className="plab">Stamp</div>
          <div className="sscan-out" style={{ height: boxH }}>
            {res && !empty ? <ResultView r={res} H={boxH - 20} /> : <span className="faint">{empty ? 'Nothing left in the crop - widen it, or move the clean-up towards "keep faint marks".' : info ? 'Cleaning…' : 'Looking at the picture…'}</span>}
          </div>
          {res && !empty && vh >= 820 && <div className="sscan-paper" title="On a page"><ResultView r={res} small /><div className="sscan-lines" /></div>}
        </div>
      </div>
      <div className="sscan-ctl">
        <div className="hrow"><span className="plab">Colour</span>
          <div className="seg">
            <button className={colour === 'ink' ? 'on' : ''} onClick={() => setColour('ink')} title="One even colour: the stamp's own ink">{inkNow && <i className="sw-mini" style={{ background: css(inkNow) }} />} Its ink</button>
            <button className={colour === 'scan' ? 'on' : ''} onClick={() => setColour('scan')} title="The colours as scanned (shading and wear kept)">As scanned</button>
            {PRESETS.map((p, i) => <button key={p.name} className={colour === i ? 'on' : ''} onClick={() => setColour(i)} title={p.name}><i className="sw-mini" style={{ background: css(p.c) }} /> {p.name}</button>)}
          </div>
        </div>
        <div className="hrow"><span className="plab">Clean-up</span>
          <span className="faint">keep faint marks</span>
          <input type="range" min={0} max={100} value={Math.round(strength * 100)} onChange={(e) => setStrength(Number(e.target.value) / 100)} />
          <span className="faint">clean more</span>
          {coloured && <label className="check sm"><input type="checkbox" checked={removeOther} onChange={(e) => setRemoveOther(e.target.checked)} /> Leave out black text, lines and other colours</label>}
        </div>
        <div className="hrow"><span className="plab">Turn</span>
          <button className="btn sm icon" title="Turn 90° left" onClick={() => setTurn((t) => t - 90)}><Ico n="rotl" size={14} /></button>
          <button className="btn sm icon" title="Turn 90° right" onClick={() => setTurn((t) => t + 90)}><Ico n="rotr" size={14} /></button>
          <input type="range" min={-15} max={15} step={0.5} value={((turn % 90) + 90 + 45) % 90 - 45} onChange={(e) => setTurn(Math.round(turn / 90) * 90 + Number(e.target.value))} title="Fine turn" />
          {info && info.angle !== 0 && <label className="check sm"><input type="checkbox" checked={straighten} onChange={(e) => setStraighten(e.target.checked)} /> Straightened by {Math.abs(info.angle)}°</label>}
        </div>
        <div className="hrow"><span className="plab">Size</span>
          <input className="input sm" inputMode="decimal" style={{ width: 84, flex: 'none' }} value={widthTxt ?? String(wMm)} onChange={(e) => setWidthTxt(e.target.value)} onBlur={takeWidth} onKeyDown={(e) => { if (e.key === 'Enter') takeWidth(); }} /> mm wide{res ? ` × ${hMm} mm` : ''}
          <span className="faint">{realMm ? '(its real size' + (widthMm !== null ? ' was ' + Math.round(realMm) + ' mm' : '') + ')' : '(you can resize it on the page)'}</span>
          <span className="plab" style={{ marginLeft: 16 }}>Name</span><input className="input sm" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 220, flex: 'none' }} />
        </div>
      </div>
    </Modal>
  );
}

/** the picture with the crop box: drag a new box, move it, or pull its corners and sides */
function SourceView({ src, info, crop, setCrop, picking, onPick, boxH }: { src: ScanSource; info: Info | null; crop: Box; setCrop(b: Box): void; picking: boolean; onPick(x: number, y: number): void; boxH: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const BOXW = 460, BOXH = boxH;
  const s = Math.min(BOXW / src.bmp.width, BOXH / src.bmp.height, 1.5);
  const dw = Math.round(src.bmp.width * s), dh = Math.round(src.bmp.height * s);
  useEffect(() => {
    const c = cv.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(dw * dpr); c.height = Math.round(dh * dpr);
    c.getContext('2d')!.drawImage(src.bmp, 0, 0, c.width, c.height);
  }, [src, dw, dh]);
  // working pixels <-> shown pixels
  const ws = info ? dw / info.W : 1;
  const drag = useRef<{ mode: 'new' | 'move' | number; x: number; y: number; b: Box } | null>(null);
  const at = (e: React.PointerEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return [(e.clientX - r.left) / ws, (e.clientY - r.top) / ws]; };
  const fit = (b: Box): Box => {
    if (!info) return b;
    // (the 4-px least size kept inside the picture too - at its right or bottom edge it ran past it)
    const x0 = Math.max(0, Math.min(info.W - 4, b[0], b[2])), x1 = Math.min(info.W, Math.max(b[0], b[2]));
    const y0 = Math.max(0, Math.min(info.H - 4, b[1], b[3])), y1 = Math.min(info.H, Math.max(b[1], b[3]));
    return [x0, y0, Math.max(x0 + 4, x1), Math.max(y0 + 4, y1)];
  };
  const down = (e: React.PointerEvent) => {
    if (!info) return;
    const [x, y] = at(e);
    if (picking) { onPick(x, y); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const h = (e.target as HTMLElement).dataset.h;
    // (a crop of the whole picture can't move: a drag in it draws a new one)
    const whole = crop[0] <= 1 && crop[1] <= 1 && crop[2] >= info.W - 1 && crop[3] >= info.H - 1;
    if (h !== undefined) drag.current = { mode: Number(h), x, y, b: crop };
    else if (!whole && x > crop[0] && x < crop[2] && y > crop[1] && y < crop[3]) drag.current = { mode: 'move', x, y, b: crop };
    else drag.current = { mode: 'new', x, y, b: [x, y, x, y] };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !info) return;
    const [x, y] = at(e);
    const dx = x - d.x, dy = y - d.y, b = d.b;
    if (d.mode === 'new') setCrop(fit([d.x, d.y, x, y]));
    else if (d.mode === 'move') {
      const w = b[2] - b[0], h = b[3] - b[1];
      const nx = Math.max(0, Math.min(info.W - w, b[0] + dx)), ny = Math.max(0, Math.min(info.H - h, b[1] + dy));
      setCrop([nx, ny, nx + w, ny + h]);
    } else {
      // handles: 0 top-left, 1 top, 2 top-right, 3 right, 4 bottom-right, 5 bottom, 6 bottom-left, 7 left
      const n = [...b] as Box;
      if ([0, 6, 7].includes(d.mode)) n[0] = b[0] + dx;
      if ([2, 3, 4].includes(d.mode)) n[2] = b[2] + dx;
      if ([0, 1, 2].includes(d.mode)) n[1] = b[1] + dy;
      if ([4, 5, 6].includes(d.mode)) n[3] = b[3] + dy;
      setCrop(fit(n));
    }
  };
  const up = () => { drag.current = null; };
  const box = { left: crop[0] * ws, top: crop[1] * ws, width: (crop[2] - crop[0]) * ws, height: (crop[3] - crop[1]) * ws };
  const hs = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
  return (
    <div className="sscan-src" style={{ width: dw, height: dh, cursor: picking ? 'crosshair' : 'default' }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <canvas ref={cv} style={{ width: dw, height: dh }} />
      {info && <div className="sscan-crop" style={box}>
        {/* (handles kept inside the picture: at its edge they were cut off and couldn't be grabbed) */}
        {!picking && hs.map(([fx, fy], i) => <i key={i} data-h={i} style={{ left: Math.max(6, Math.min(dw - 6, box.left + fx * box.width)) - box.left, top: Math.max(6, Math.min(dh - 6, box.top + fy * box.height)) - box.top, cursor: ['nwse', 'ns', 'nesw', 'ew', 'nwse', 'ns', 'nesw', 'ew'][i] + '-resize' }} />)}
      </div>}
    </div>
  );
}

function ResultView({ r, small, H: maxH }: { r: Result; small?: boolean; H?: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current!;
    c.width = r.w; c.height = r.h;
    c.getContext('2d')!.putImageData(new ImageData(r.data as unknown as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
  }, [r]);
  const W = small ? 150 : 440, H = small ? 90 : maxH ?? 300;
  const k = Math.min(W / r.w, H / r.h, small ? 1 : 2);
  return <canvas ref={cv} style={{ width: Math.round(r.w * k), height: Math.round(r.h * k) }} />;
}
