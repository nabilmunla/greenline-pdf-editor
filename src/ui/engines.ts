// The engines, each in its own background process (not in this window, so a file that
// exhausts an engine's memory can't take the window down):
//  - 2-4 PDFium processes draw page content (tiles) and read text positions
//  - 1 MuPDF process holds the open documents (every edit) and draws the markup layer
//  - 1 MuPDF process for long jobs (compress, merge, batch) so the open file stays responsive
// Files are read by the engines straight from disk, on demand.
import { EngineClient } from '../engine/rpc';
import { gcc } from './api';
import { APP_NAME } from './brand';

let started: Promise<void> | null = null;
export const renderers: EngineClient[] = [];
export const editor = new EngineClient('Editing engine');
export const batcher = new EngineClient('Batch engine');

const RENDERERS = gcc.renderers || Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 3)));
for (let i = 0; i < RENDERERS; i++) renderers.push(new EngineClient('Drawing engine ' + (i + 1)));

const byName = new Map<string, EngineClient>([...renderers.map((r, i) => ['render' + i, r] as const), ['edit', editor], ['batch', batcher]]);

type RestartHook = (c: EngineClient, kind: 'render' | 'edit' | 'batch', code: number) => void | Promise<void>;
const hooks = new Set<RestartHook>();
/** run after an engine had to be restarted (reopen what it had open) */
export function onEngineRestart(f: RestartHook) { hooks.add(f); return () => { hooks.delete(f); }; }

window.addEventListener('message', (e: MessageEvent) => {
  // an engine that kept stopping is not started again (5 times in 2 minutes): what waits on it
  // fails with a message, and the window says what to do
  if (e.source === window && e.data?.type === 'engine-gaveup') {
    const c = byName.get(String(e.data.name));
    if (!c) return;
    gcc.log(`${c.name} gave up after repeated exits (${e.data.code})`);
    // a drawing engine, with others still going: taken out of the list (every page, search and
    // open goes to the others - left in, it was picked first as "least busy" and its pages
    // stayed blank)
    const k = renderers.indexOf(c);
    if (k >= 0 && renderers.length > 1) {
      renderers.splice(k, 1);
      c.fail(c.name + ' was switched off');
      window.dispatchEvent(new CustomEvent('gcc-engine-gaveup', { detail: `One of the drawing engines kept stopping and was switched off – the others carry on (pages may draw a little slower). Closing ${APP_NAME} and opening it again brings it back.` }));
      return;
    }
    // (the editing engine holds the open files: without it nothing can be saved - the recovery
    // copies written so far bring the changes back after a restart)
    const msg = `The ${c.name.toLowerCase()} keeps stopping (${e.data.code}), so it was not started again. ` + (c === editor
      ? `Close ${APP_NAME} and open it again – files with unsaved changes are offered back from their recovery copies.`
      : `Save your work, then close ${APP_NAME} and open it again.`);
    c.fail(msg);
    window.dispatchEvent(new CustomEvent('gcc-engine-gaveup', { detail: msg }));
    return;
  }
  if (e.source !== window || !e.data || e.data.type !== 'engine-port' || !e.ports[0]) return;
  const { name, restarted, code } = e.data as { name: string; restarted: boolean; code: number };
  const c = byName.get(name);
  if (!c) return;
  c.attach(e.ports[0], restarted, code);
  if (restarted) {
    const kind = name === 'edit' ? 'edit' : name === 'batch' ? 'batch' : 'render';
    gcc.log(`engine ${name} restarted (exit ${code})`);
    for (const h of hooks) void Promise.resolve(h(c, kind, code)).catch((err) => gcc.log('restart hook: ' + err));
  }
});

/** an engine that has not loaded after this long is said so (antivirus checking the 100 MB
 *  engine files the first time can take a while; a normal start takes a second or two) */
const START_LIMIT_MS = 120_000;

/**
 * The first answer of an engine (it answers once it has loaded). One that fails to load is
 * started again by the app a moment later: asked again then, a few times, before giving up -
 * a file held for a moment (antivirus, low memory) must not end the session.
 */
async function firstAnswer(c: EngineClient, until: number): Promise<void> {
  for (let tries = 1; ; tries++) {
    let timer = 0;
    const left = until - performance.now();
    try {
      await Promise.race([
        c.call('memory'),
        new Promise((_, rej) => { timer = window.setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), Math.max(0, left)); }),
      ]);
      return;
    } catch (e) {
      if ((e as { timeout?: boolean }).timeout || tries >= 4) {
        gcc.log(`${c.name} did not start: ${(e as Error).message || e}`);
        throw new Error((e as { timeout?: boolean }).timeout
          ? `The PDF engines did not start within two minutes. Close ${APP_NAME} and open it again. If it happens again, your antivirus may be holding the program's files.`
          : `The PDF engines could not start (${String((e as Error).message || e).slice(0, 160)}). Close ${APP_NAME} and open it again.`);
      }
      gcc.log(`${c.name} failed to start (try ${tries}): ${(e as Error).message || e}`);
      // (the app starts a new engine 1.5 s after one dies on starting up)
      await new Promise((r) => window.setTimeout(r, 2500));
    } finally { window.clearTimeout(timer); }
  }
}

export function startEngines(): Promise<void> {
  if (started) return started;
  const job = (async () => {
    await gcc.enginesStart([...byName.keys()].map((name) => ({ name, role: name === 'edit' || name === 'batch' ? 'edit' : 'render' })));
    // first call to each answers once the engine has loaded
    const until = performance.now() + START_LIMIT_MS;
    await Promise.all([...byName.values()].map((c) => firstAnswer(c, until)));
  })();
  started = job;
  // a start that failed is not kept: asking again starts afresh (it was kept, failure and all)
  job.catch(() => { if (started === job) started = null; });
  return job;
}

/**
 * A drawing engine's memory only ever grows: one that has grown big keeps it until it stops (a PC
 * with four big scans open showed 355 MB of its 16 GB free). One left idle for a few minutes
 * with more than IDLE_HEAP gives it back: a planned restart (exit 75 - no message, no crash
 * report), the files reopened in the new one. (Not sooner: a dense sheet read in again takes
 * seconds, and that is what the next zoom would wait for.)
 */
const IDLE_HEAP = Number(localStorage.getItem('pdfed-idle-heap')) || 1.1 * 1024 ** 3;
const IDLE_MS = Number(localStorage.getItem('pdfed-idle-ms')) || 180_000;
window.setInterval(() => {
  if (!started) return;
  void (async () => {
    for (const c of renderers) {
      if (c.busy || performance.now() - c.lastUse < IDLE_MS) continue;
      const heap = await c.call<number>('heap').catch(() => 0);
      if (heap > IDLE_HEAP && !c.busy && performance.now() - c.lastUse >= IDLE_MS) {
        gcc.log(`${c.name}: idle with ${Math.round(heap / 2 ** 20)} MB - planned restart`);
        await c.call('exitNow').catch(() => {});
      }
    }
  })();
}, Math.min(30_000, IDLE_MS / 2));

/** least busy drawing engine */
export function renderer(): EngineClient {
  let best = renderers[0];
  for (const r of renderers) if (r.busy < best.busy) best = r;
  return best;
}

/**
 * The drawing engine for a picture of one page. Before an engine can draw any part of a page
 * it reads the whole page in - seconds and ~800 MB for a dense A0 sheet - and keeps it. Drawing
 * engine 1 reads every page anyway (text, links, snap points), so a page's tiles go to engine 1
 * or to one partner engine (pages take turns between the others): with 4 engines a sheet is
 * held twice, not four times, and more drawings fit before engines have to start afresh.
 */
export function rendererFor(doc: string, page: number): EngineClient {
  if (renderers.length <= 2) return renderer();
  let h = page * 31;
  for (let i = 0; i < doc.length; i++) h = (h * 33 + doc.charCodeAt(i)) >>> 0;
  const partner = renderers[1 + (h % (renderers.length - 1))];
  return partner.busy <= renderers[0].busy ? partner : renderers[0];
}

export const mu = <T,>(method: string, ...args: unknown[]) => editor.call<T>(method, args);
// The batch engine asks for a planned restart like the editing engine (MuPDF's error count near
// the point where it corrupts memory). It holds files across calls (a batch job's open file, an
// export), so it is let go only when it holds none and nothing is waiting on it; calls made
// while it starts again wait for the new one.
const held = new Set<string>();
let batchRecycle = false;
let restarting: Promise<void> | null = null;
batcher.onNotice = (n) => { if (n === 'recycle') { batchRecycle = true; recycleBatch(); } };
// (a new batch engine holds nothing: what the old one held went with it)
onEngineRestart((c) => { if (c === batcher) { held.clear(); batchRecycle = false; } });
function recycleBatch() {
  if (!batchRecycle || held.size || batcher.busy || restarting) return;
  batchRecycle = false;
  restarting = (async () => {
    const back = new Promise<void>((res) => {
      const off = onEngineRestart((c) => { if (c === batcher) { off(); res(); } });
      window.setTimeout(() => { off(); res(); }, 5000);
    });
    gcc.log('batch engine: planned restart');
    await batcher.call('exitNow').catch(() => {});
    await back;
  })().finally(() => { restarting = null; });
}
async function batchCall<T>(method: string, args: unknown[], out?: boolean): Promise<T> {
  if (restarting) await restarting;
  const id = String(args[0]);
  if (method === 'close' || method === 'exportFinish' || method === 'exportEnd' || method === 'mergeFinish' || method === 'mergeEnd' || method === 'printPicFinish' || method === 'printPicEnd') held.delete(id);
  const r = batcher.call<T>(method, args, out);
  if (method === 'exportBegin' || method === 'mergeBegin' || method === 'printPicBegin') held.add(id);
  try {
    const v = await r;
    if (method === 'batchOpen') held.add(String(v));
    return v;
  } catch (e) {
    if (method === 'exportBegin' || method === 'mergeBegin' || method === 'printPicBegin') held.delete(id);
    throw e;
  } finally { recycleBatch(); }
}
export const muBatch = <T,>(method: string, ...args: unknown[]) => batchCall<T>(method, args);
/** a call whose finished file is written to a temp file by the engine */
export const muFile = <T,>(method: string, ...args: unknown[]) => editor.call<T>(method, args, true);
export const muBatchFile = <T,>(method: string, ...args: unknown[]) => batchCall<T>(method, args, true);
