// Right panel: ask Claude or ChatGPT about the open PDF, or have it translated.
// Opt-in: nothing is sent until Send / Translate is pressed, and every answer shows exactly
// which pages went with it.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { gcc, baseName, type AiMessage, type AiProvider } from './api';
import { Ico } from './icons';
import { Modal } from './Modal';
import type { PdfDoc } from './doc';
import type { Settings } from './App';
import { PROVIDERS, buildContext, pageTexts, ask, blocks, inline, isRtl, SYSTEM_ASK, systemTranslate, translationHtml, type Context, type Run, type Scope } from './ai';

export interface AiSettings {
  /** asking: Claude or ChatGPT */
  provider?: AiProvider;
  models?: Partial<Record<AiProvider, string>>;
  lang?: string;
  /** old setting (translate with 'ai' = the asking provider, or 'offline') */
  engine?: 'ai' | 'offline';
  /** translating: on this PC, or Claude / ChatGPT */
  trEngine?: 'offline' | AiProvider;
}

interface Props {
  doc: PdfDoc;
  page: number;
  pageSel: number[];
  goTo(p: number): void;
  tab: 'ask' | 'translate';
  setTab(t: 'ask' | 'translate'): void;
  settings: Settings;
  saveSettings(p: Partial<Settings>): void;
  toast(t: string, k?: 'ok' | 'err' | 'info', a?: { label: string; run: () => void }, ms?: number): number;
  openFile(file: string, name: string): Promise<unknown>;
  onClose(): void;
  /** open the AI keys window */
  onKeys(): void;
}

interface Msg { role: 'user' | 'assistant'; text: string; ctx?: Context; error?: string; busy?: string; usage?: Record<string, number> | null; stop?: string; provider?: AiProvider }
/** a conversation: the request in flight lives here too, not in the panel - leaving the panel
 *  (or switching files) and coming back finds the answer still streaming and Stop still working */
interface Chat { msgs: Msg[]; api: AiMessage[]; scopeKey: string; provider: AiProvider | null; run: Run | null; stopped: boolean }
/** conversations per open file (kept while the tab is open) */
const chats = new Map<string, Chat>();
const chatOf = (id: string) => { let c = chats.get(id); if (!c) { c = { msgs: [], api: [], scopeKey: '', provider: null, run: null, stopped: false }; chats.set(id, c); } return c; };
/** a translation (per file), with its run: Stop works from any panel showing it */
interface Tr {
  text: string; pages: number[]; lang: string; busy?: string; error?: string; provider?: AiProvider; offline: boolean; model: string; from: string;
  /** pages finished, and how much of the text they make up (a retry carries on after them) */
  done: number[]; doneLen: number;
  run: Run | null; stopped: boolean;
}
const translations = new Map<string, Tr>();
/** panels showing a file's conversation or translation repaint when it changes */
const subs = new Map<string, Set<() => void>>();
const pending = new Set<string>();
/** repaint whatever shows this file's AI work (streamed text comes in many small pieces: one
 *  repaint per 40 ms is plenty) */
function notify(id: string, now = false) {
  if (now) { pending.delete(id); subs.get(id)?.forEach((f) => f()); return; }
  if (pending.has(id)) return;
  pending.add(id);
  setTimeout(() => { if (pending.delete(id)) subs.get(id)?.forEach((f) => f()); }, 40);
}
function useAiRedraw(id: string) {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    let set = subs.get(id);
    if (!set) subs.set(id, (set = new Set()));
    set.add(f);
    return () => { set!.delete(f); };
  }, [id]);
}
/** a translation running for any file (a language pack update waits for it) */
const translating = () => [...translations.values()].some((t) => t.busy);
/** a tab closed: its conversations go (each question kept the pages it was asked about), and
 *  anything still being asked or translated for it is stopped */
export function forgetAiFor(docId: string) {
  const c = chats.get(docId);
  if (c) { c.stopped = true; c.run?.cancel(); }
  const t = translations.get(docId);
  if (t) { t.stopped = true; t.run?.cancel(); }
  chats.delete(docId);
  translations.delete(docId);
  subs.delete(docId);
}
const STOPPED = '\u0000stopped';
const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const LANG_CODES: Record<string, string> = { Arabic: 'ar', English: 'en', French: 'fr', Hindi: 'hi', Urdu: 'ur', 'Chinese (Simplified)': 'zh', Spanish: 'es', German: 'de', Italian: 'it', Turkish: 'tr', Russian: 'ru', Malayalam: 'ml', Tamil: 'ta', Bengali: 'bn', Filipino: 'tl', Persian: 'fa', Portuguese: 'pt', Greek: 'el', Japanese: 'ja', Korean: 'ko' };
const LANGS = Object.keys(LANG_CODES);
const fmtK = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
const pagesTxt = (ps: number[]) => {
  if (!ps.length) return 'no pages';
  const s = [...ps].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    runs.push(j > i ? `${s[i] + 1}–${s[j] + 1}` : String(s[i] + 1));
    i = j;
  }
  return (s.length === 1 ? 'page ' : 'pages ') + (runs.length > 8 ? runs.slice(0, 8).join(', ') + ` … (${s.length} in all)` : runs.join(', '));
};

/** text typed in the panel stays there (Delete must not delete markups) */
const ownKeys = (e: React.KeyboardEvent) => {
  const k = e.key.toLowerCase();
  if (e.ctrlKey && ['s', 'w', 'o', 'p', 'tab'].includes(k)) return;
  e.stopPropagation();
};

/** selecting several pages in the Pages panel switches the panel to "selected pages" (and back) */
function useSelFollow(sel: number[], kind: string, set: (k: 'page' | 'pages' | 'all') => void) {
  const key = sel.length > 1 ? 'many' : 'one';
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (key === 'many') set('pages');
    else if (kind === 'pages') set('page');
  }, [key, sel.join(',')]);
}

/** the provider's own model list (falls back to the built-in names) */
function useModels(provider: AiProvider, hasKey: boolean) {
  const [models, setModels] = useState<{ id: string; label: string }[]>(PROVIDERS[provider].models);
  useEffect(() => {
    setModels(PROVIDERS[provider].models);
    if (!hasKey) return;
    let live = true;
    gcc.aiModels(provider).then((list) => {
      if (!live || !list.length) return;
      const ok = list.filter((m) => provider === 'anthropic' ? /^claude-/.test(m.id) : /^(gpt|o\d|chatgpt)/.test(m.id) && !/(audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct)/.test(m.id));
      const known = PROVIDERS[provider].models.filter((m) => ok.some((x) => x.id === m.id));
      const rest = ok.filter((m) => !known.some((k) => k.id === m.id)).map((m) => ({ id: m.id, label: m.name }));
      if (known.length || rest.length) setModels([...known, ...rest]);
    }).catch(() => { /* keep the built-in list */ });
    return () => { live = false; };
  }, [provider, hasKey]);
  return models;
}

type Keys = { anthropic: boolean; openai: boolean; secure: boolean };
/** saved AI keys (refreshed when the AI keys window changes them) */
function useKeys(): Keys | null {
  const [keys, setKeys] = useState<Keys | null>(null);
  useEffect(() => {
    const load = () => void gcc.aiKeys().then(setKeys);
    load();
    window.addEventListener('gcc-ai-keys', load);
    return () => window.removeEventListener('gcc-ai-keys', load);
  }, []);
  return keys;
}

function ModelPick({ provider, ai, saveAi, hasKey }: { provider: AiProvider; ai: AiSettings; saveAi(p: Partial<AiSettings>): void; hasKey: boolean }) {
  const models = useModels(provider, hasKey);
  const model = ai.models?.[provider] || PROVIDERS[provider].models[0].id;
  return (
    <select className="input sm grow ai-model" value={model} onChange={(e) => saveAi({ models: { ...(ai.models || {}), [provider]: e.target.value } })} title="Model">
      {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
      {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select>
  );
}

/** a key is needed for this provider: one line and a button to the AI keys window */
function NeedKey({ provider, onKeys, what }: { provider: AiProvider; onKeys(): void; what: string }) {
  return (
    <div className="ai-note">
      <p className="hint"><b>{PROVIDERS[provider].name}</b> needs an API key from your company's account to {what}.</p>
      <button className="btn sm" onClick={onKeys}><Ico n="key" size={13} /> Add key…</button>
    </div>
  );
}

export function AiPanel(p: Props) {
  const ai: AiSettings = (p.settings as Settings & { ai?: AiSettings }).ai || {};
  const keys = useKeys();
  const saveAi = (patch: Partial<AiSettings>) => p.saveSettings({ ai: { ...ai, ...patch } } as Partial<Settings>);
  // asking: Claude or ChatGPT
  const provider: AiProvider = ai.provider || (keys && !keys.anthropic && keys.openai ? 'openai' : 'anthropic');
  const model = ai.models?.[provider] || PROVIDERS[provider].models[0].id;
  const hasKey = !!keys?.[provider];
  // translating: on this PC, or Claude / ChatGPT (an older setting "ai" meant the provider above)
  const engine: 'offline' | AiProvider = ai.trEngine || (ai.engine === 'offline' ? 'offline' : ai.engine === 'ai' ? provider : keys && (keys.anthropic || keys.openai) ? provider : 'offline');
  const trModel = engine === 'offline' ? '' : ai.models?.[engine] || PROVIDERS[engine].models[0].id;
  return (
    <div className="props ai-panel">
      <div className="side-head ai-head">
        <div className="seg ai-tabs">
          <button className={p.tab === 'ask' ? 'on' : ''} onClick={() => p.setTab('ask')}><Ico n="ai" size={13} /> Ask</button>
          <button className={p.tab === 'translate' ? 'on' : ''} onClick={() => p.setTab('translate')}><Ico n="translate" size={13} /> Translate</button>
        </div>
        <span className="hrow">
          <button className="x" title="AI keys" onClick={p.onKeys}><Ico n="key" size={14} /></button>
          <button className="x" title="Close" onClick={p.onClose}><Ico n="close" size={13} /></button>
        </span>
      </div>
      {p.tab === 'ask' ? (
        <>
          <div className="ai-row">
            <div className="seg ai-provider" title="Who answers your questions">
              {(['anthropic', 'openai'] as AiProvider[]).map((k) => (
                <button key={k} className={provider === k ? 'on' : ''} onClick={() => saveAi({ provider: k })}>{PROVIDERS[k].name}</button>
              ))}
            </div>
            <ModelPick provider={provider} ai={ai} saveAi={saveAi} hasKey={hasKey} />
          </div>
          {!keys ? null : hasKey ? <AskView {...p} provider={provider} model={model} />
            : <div className="ai-list"><NeedKey provider={provider} onKeys={p.onKeys} what="answer questions about your files" /></div>}
        </>
      ) : (
        <TranslateView {...p} engine={engine} setEngine={(e) => saveAi({ trEngine: e })} model={trModel} hasKey={engine !== 'offline' && !!keys?.[engine]}
          lang={ai.lang || 'Arabic'} setLang={(l) => saveAi({ lang: l })} modelPick={engine === 'offline' ? null : <ModelPick provider={engine} ai={ai} saveAi={saveAi} hasKey={!!keys?.[engine]} />} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- keys

/** AI keys: one per provider, stored encrypted on this PC (works without a file open) */
export function AiKeysDialog({ onClose }: { onClose(): void }) {
  const keys = useKeys();
  return (
    <Modal title="AI keys" onClose={onClose} sub="Only needed to ask questions about a file, or to translate with Claude or ChatGPT. Translating on this PC needs no key."
      actions={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="keyrows">
        {(['anthropic', 'openai'] as AiProvider[]).map((k) => <KeyRow key={k} provider={k} keys={keys} />)}
      </div>
      {keys && !keys.secure && <p className="hint err">Windows key protection is not available on this PC, so a key can't be stored safely.</p>}
      <p className="hint">Keys are stored encrypted on this PC (Windows protection). What leaves the PC: only the pages listed with a question or translation, sent when you press Send or Translate – nothing in the background. Use is billed per question to your company's API account.</p>
    </Modal>
  );
}

function KeyRow({ provider, keys }: { provider: AiProvider; keys: Keys | null }) {
  const P = PROVIDERS[provider];
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const has = !!keys?.[provider];
  const changed = () => window.dispatchEvent(new Event('gcc-ai-keys'));
  const save = async () => {
    setErr('');
    setBusy(true);
    try {
      // tried with the service first: if it fails, the key saved before stays
      await gcc.aiSetKey(provider, key.trim(), true);
      setKey('');
      changed();
    } catch (e) { setErr(String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  };
  return (
    <div className="keyrow">
      <div className="keyrow-h">
        <b>{P.name}</b>
        <span className={'keystate' + (has ? ' ok' : '')}>{keys == null ? '' : has ? '✓ Key saved on this PC' : 'No key'}</span>
        {has && <button className="btn xs" onClick={async () => { await gcc.aiSetKey(provider, ''); changed(); }}>Remove</button>}
      </div>
      <div className="hrow">
        <input className="input grow" type="password" placeholder={has ? 'Paste a new key to replace it' : P.keyHint} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { ownKeys(e); if (e.key === 'Enter' && key.trim()) void save(); }} />
        <button className="btn" disabled={!key.trim() || busy} onClick={() => void save()}>{busy ? 'Checking…' : 'Save key'}</button>
      </div>
      {err && <p className="hint err">{err}</p>}
      <p className="hint">Get one at <a href="#" onClick={(e) => { e.preventDefault(); void gcc.openLink(P.keyUrl); }}>{P.keyUrl.replace(/^https:\/\//, '')}</a> (billed by {provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}).</p>
    </div>
  );
}

// ---------------------------------------------------------------- answers

/** an answer or translation, drawn from its light Markdown. Only redrawn when its text changes
 *  (a long conversation doesn't re-read every answer while the next one streams in) */
const Rich = memo(function Rich({ text, goTo, pages }: { text: string; goTo(p: number): void; pages: number }) {
  const bl = useMemo(() => blocks(text), [text]);
  // a page that isn't in the file (the model got it wrong, or pages were removed since) is
  // shown, but can't be clicked
  const pageBtn = (n: number, cls: string, label: ReactNode, key: number) => n >= 1 && n <= pages
    ? <button key={key} className={cls} title={'Go to page ' + n} onClick={() => goTo(n - 1)}>{label}</button>
    : <button key={key} className={cls + ' nopage'} disabled title={`There is no page ${n} in this file (${pages} page${pages === 1 ? '' : 's'})`}>{label}</button>;
  const inl = (s: string): ReactNode[] => inline(s).map((x, i) => x.k === 'b' ? <b key={i}>{x.text}</b> : x.k === 'c' ? <code key={i}>{x.text}</code> : x.k === 'cite'
    ? pageBtn(x.page, 'cite', <>p.{x.label}</>, i)
    : <span key={i}>{x.text}</span>);
  return (
    <div className="rich" dir={isRtl(text) ? 'rtl' : 'auto'}>
      {bl.map((b, i) => {
        if (b.k === 'page') return pageBtn(b.n, 'pghead', <>Page {b.n}</>, i);
        if (b.k === 'h') return <div key={i} className={'h' + b.level}>{inl(b.text)}</div>;
        if (b.k === 'p') return <p key={i}>{inl(b.text)}</p>;
        if (b.k === 'ul') return <ul key={i}>{b.items.map((x, j) => <li key={j}>{inl(x)}</li>)}</ul>;
        if (b.k === 'ol') return <ol key={i} start={b.start && b.start !== 1 ? b.start : undefined}>{b.items.map((x, j) => <li key={j}>{inl(x)}</li>)}</ol>;
        if (b.k === 'table') return <div key={i} className="tblwrap"><table>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => (j ? <td key={k}>{inl(c)}</td> : <th key={k}>{inl(c)}</th>))}</tr>)}</table></div>;
        return b.k === 'code' ? <pre key={i}>{b.text}</pre> : null;
      })}
    </div>
  );
});

function Sent({ ctx, goTo }: { ctx: Context; goTo(p: number): void }) {
  const [open, setOpen] = useState(false);
  const what = ctx.mode === 'pdf'
    ? `${pagesTxt(ctx.pages)} as a PDF (${ctx.bytes < 1e6 ? Math.max(1, Math.round(ctx.bytes / 1e3)) + ' KB' : (ctx.bytes / 1e6).toFixed(1) + ' MB'})`
    : `text of ${ctx.pages.length - ctx.images.length} page${ctx.pages.length - ctx.images.length === 1 ? '' : 's'}` + (ctx.trimmed ? ` (the most related; ${ctx.trimmed} left out)` : '') + (ctx.images.length ? ` + ${ctx.images.length} page picture${ctx.images.length > 1 ? 's' : ''}` : '');
  return (
    <div className="sent">
      <button className="sent-h" onClick={() => setOpen(!open)} title="What was sent with the question">
        <Ico n={open ? 'chev' : 'chevr'} size={12} /> Sent: {what} · ≈{fmtK(ctx.estTokens)} tokens
      </button>
      {open && (
        <div className="sent-b">
          {ctx.pages.slice(0, 300).map((pg) => <button key={pg} className={'chip' + (ctx.images.includes(pg) ? ' img' : '')} onClick={() => goTo(pg)} title={ctx.images.includes(pg) ? 'Sent as a picture' : 'Sent'}>{pg + 1}</button>)}
          {ctx.pages.length > 300 && <span className="faint"> …</span>}
          {ctx.note && <div className="faint">{ctx.note}</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- ask

function AskView(p: Props & { provider: AiProvider; model: string }) {
  const { doc } = p;
  const chat = useMemo(() => chatOf(doc.id), [doc.id]);
  useAiRedraw(doc.id);
  const [q, setQ] = useState('');
  const [scopeKind, setScopeKind] = useState<'page' | 'pages' | 'all'>(p.pageSel.length > 1 ? 'pages' : doc.pages.length <= 20 ? 'all' : 'page');
  useSelFollow(p.pageSel, scopeKind, setScopeKind);
  const list = useRef<HTMLDivElement>(null);
  const busy = chat.msgs.some((m) => m.busy);
  // keep to the newest message while the list is at its end; reading further up, it stays put
  // (typing a follow-up or clicking a page link doesn't yank the answer away)
  const atEnd = useRef(true);
  const seen = useRef(-1);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const grew = chat.msgs.length !== seen.current;
    seen.current = chat.msgs.length;
    if (grew || atEnd.current) { el.scrollTop = el.scrollHeight; atEnd.current = true; }
  });
  useEffect(() => { seen.current = -1; }, [doc.id]);

  const scope = (): Scope => scopeKind === 'page' ? { kind: 'page', page: p.page } : scopeKind === 'pages' && p.pageSel.length ? { kind: 'pages', pages: p.pageSel } : scopeKind === 'pages' ? { kind: 'page', page: p.page } : { kind: 'all' };
  // the pages sent and the file as it was: a change to the file (pages added or removed, OCR, an
  // edit, undo) sends the pages again rather than answering from the old text
  const scopeKey = () => { const s = scope(); return (s.kind === 'page' ? 'p' + s.page : s.kind === 'pages' ? 's' + [...s.pages].sort((a, b) => a - b).join(',') : 'all') + '|' + doc.baseRev + '|' + doc.pages.length; };

  const send = async (question = q.trim()) => {
    if (!question || busy) return;
    setQ('');
    const id = doc.id;
    const key = scopeKey();
    const fresh = !chat.api.length || chat.scopeKey !== key || chat.provider !== p.provider;
    const user: Msg = { role: 'user', text: question };
    const ans: Msg = { role: 'assistant', text: '', busy: 'Preparing…', provider: p.provider };
    chat.msgs.push(user, ans);
    chat.stopped = false;
    notify(id, true);
    try {
      if (fresh) {
        const ctx = await buildContext(doc, scope(), question, p.page, (m) => { if (!chat.stopped) { ans.busy = m; notify(id); } });
        // Stop while the pages were being read: nothing goes out
        if (chat.stopped) throw new Error(STOPPED);
        user.ctx = ctx;
        chat.api = [{ role: 'user', parts: [...ctx.parts, { t: 'text', text: 'Question: ' + question }], cache: true }];
        chat.scopeKey = key;
        chat.provider = p.provider;
      } else chat.api.push({ role: 'user', parts: [{ t: 'text', text: question }] });
      ans.busy = 'Asking ' + PROVIDERS[p.provider].name + '…';
      notify(id, true);
      const r = ask(p.provider, p.model, SYSTEM_ASK, chat.api, (all) => { ans.text = all; ans.busy = 'Writing…'; notify(id); });
      chat.run = r;
      const out = await r.done;
      ans.text = out.text;
      ans.usage = out.usage;
      ans.stop = out.stop;
      chat.api.push({ role: 'assistant', parts: [{ t: 'text', text: out.text || '(no answer)' }] });
    } catch (e) {
      ans.error = (e as Error)?.message === STOPPED ? 'Stopped – nothing was sent.' : errText(e);
      // the question can be asked again
      if (chat.api.length && chat.api[chat.api.length - 1].role === 'user') { chat.api.pop(); if (!chat.api.length) chat.scopeKey = ''; }
    } finally {
      ans.busy = undefined;
      chat.run = null;
      notify(id, true);
    }
  };
  const stop = () => { chat.stopped = true; chat.run?.cancel(); };
  const clear = () => { chat.msgs = []; chat.api = []; chat.scopeKey = ''; notify(doc.id, true); };
  const n = doc.pages.length;

  return (
    <>
      <div className="ai-list" ref={list} onScroll={(e) => { const el = e.currentTarget; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {!chat.msgs.length && (
          <div className="ai-empty">
            <p>Ask about <b>{doc.name}</b> – answers point to the pages they come from.</p>
            <div className="ai-sugg">
              {['Summarise this document', 'List the key dates and deadlines', 'What are the payment terms and retention?', 'List the concrete grades and where they are specified', 'What is missing or unclear for pricing?'].map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {chat.msgs.map((m, i) => (
          <div key={i} className={'msg ' + m.role}>
            {m.role === 'user' ? <div className="bubble" dir="auto">{m.text}</div> : (
              <div className="answer">
                {m.text && <Rich text={m.text} goTo={p.goTo} pages={n} />}
                {m.busy && <div className="faint busyline"><span className="spin" /> {m.busy}</div>}
                {m.error && <div className="hint err">{m.error}</div>}
                {!m.busy && !m.error && !m.text && <div className="faint">{m.stop === 'stopped' ? '(stopped before any answer)' : '(no answer' + (m.stop && m.stop !== 'end_turn' && m.stop !== 'completed' ? ' – ' + m.stop.replace(/_/g, ' ') : '') + ')'}</div>}
                {!m.busy && !m.error && m.text && (
                  <div className="ans-tools">
                    <button className="btn xs" onClick={() => void gcc.copyText(m.text).then(() => p.toast('Answer copied.', 'ok'))}><Ico n="copy" size={12} /> Copy</button>
                    {m.stop === 'max_tokens' && <span className="faint">(answer cut short – ask "continue")</span>}
                    {m.stop === 'stopped' && <span className="faint">(stopped)</span>}
                    {m.usage && <span className="faint">{PROVIDERS[m.provider || p.provider].name} · {fmtK((m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0))} in / {fmtK(m.usage.output_tokens || 0)} out</span>}
                  </div>
                )}
              </div>
            )}
            {m.ctx && <Sent ctx={m.ctx} goTo={p.goTo} />}
          </div>
        ))}
      </div>
      <div className="ai-input">
        <div className="hrow scope">
          <span className="faint">Send</span>
          <select className="input xs" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as never)} disabled={busy}>
            <option value="page">this page ({p.page + 1})</option>
            <option value="pages" disabled={p.pageSel.length < 2}>selected pages{p.pageSel.length > 1 ? ` (${p.pageSel.length})` : ' (select in Pages panel)'}</option>
            <option value="all">whole file ({n} page{n > 1 ? 's' : ''})</option>
          </select>
          <span className="faint">to {PROVIDERS[p.provider].name}</span>
          {chat.msgs.length > 0 && <button className="btn xs" style={{ marginLeft: 'auto' }} disabled={busy} onClick={clear} title="Start a new conversation">New</button>}
        </div>
        <div className="hrow">
          <textarea className="input ta" rows={2} placeholder="Ask about this file… (Enter to send)" value={q} onChange={(e) => setQ(e.target.value)} dir="auto"
            onKeyDown={(e) => { ownKeys(e); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          {busy
            ? <button className="btn icon" title="Stop" onClick={stop}><Ico n="stop" size={16} /></button>
            : <button className="btn primary icon" title="Send" disabled={!q.trim()} onClick={() => void send()}><Ico n="send" size={16} /></button>}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- translate

const CHUNK = 4; // pages per request (AI)

/** PDF page text -> paragraphs (lines of one paragraph joined; headings, list items and table rows kept apart) */
export function paragraphs(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const out: string[] = [];
  let cur = '';
  const flush = () => { if (cur) out.push(cur); cur = ''; };
  for (const l of lines) {
    if (!l) { flush(); continue; }
    const starts = /^([-•*▪●]|\(?[0-9]+(\.[0-9]+)*[.)]?\s|\(?[a-z][.)]\s|[A-Z][A-Z0-9 &/-]{3,}$)/.test(l);
    if (!cur) { cur = l; continue; }
    // the previous line ended a sentence, or this one starts a new item: new paragraph
    if (starts || /[.:;!?؟]$/.test(cur) || cur.length < 40) { flush(); cur = l; }
    else cur += (cur.endsWith('-') ? '' : ' ') + l;
  }
  flush();
  return out;
}

function TranslateView(p: Props & { engine: 'offline' | AiProvider; setEngine(e: 'offline' | AiProvider): void; model: string; hasKey: boolean; lang: string; setLang(l: string): void; modelPick: ReactNode }) {
  const { doc } = p;
  useAiRedraw(doc.id);
  const [, force] = useState(0);
  const tr = translations.get(doc.id);
  const [scopeKind, setScopeKind] = useState<'page' | 'pages' | 'all'>(p.pageSel.length > 1 ? 'pages' : 'page');
  useSelFollow(p.pageSel, scopeKind, setScopeKind);
  const [from, setFrom] = useState<'auto' | string>('auto');
  const [mt, setMt] = useState<{ ok: boolean; installed?: boolean; download?: number; error?: string; update?: { download: number } | null; retry?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const [installing, setInstalling] = useState<string>('');
  const n = doc.pages.length;
  const pages = scopeKind === 'page' ? [p.page] : scopeKind === 'pages' && p.pageSel.length ? [...p.pageSel].sort((a, b) => a - b) : scopeKind === 'all' ? doc.pages.map((_, i) => i) : [p.page];
  const to = LANG_CODES[p.lang] || 'ar';
  const offline = p.engine === 'offline';
  const provider: AiProvider = offline ? 'anthropic' : (p.engine as AiProvider);

  /** source language: as chosen, or guessed from the text of the first page */
  const sourceOf = async (ps = pages): Promise<string> => {
    if (from !== 'auto') return from;
    const t = (await pageTexts(doc, ps.slice(0, 3))).values();
    const all = [...t].join(' ');
    return isRtl(all) ? 'ar' : 'en';
  };
  // offline: is this language pair on the PC? (the page text can fail to come - the engine
  // restarting, the file closing: that is said, with Try again, not left on "Checking…")
  useEffect(() => {
    if (!offline) return;
    let live = true;
    setMt(null);
    void (async () => {
      const src = await sourceOf();
      if (src === to) { if (live) setMt({ ok: false, error: 'The text is already in ' + p.lang + '.' }); return; }
      const st = await gcc.mtStatus(src, to);
      if (live) setMt(st);
    })().catch((e) => { if (live) setMt({ ok: false, error: 'Could not check the language pack: ' + errText(e), retry: true }); });
    return () => { live = false; };
  }, [offline, to, from, doc.id, pages.join(','), retry]);
  // a progress message can arrive after the download has already finished or failed: ignore it
  // then, or the panel would show "Downloading…" for good
  const downloading = useRef(false);
  useEffect(() => gcc.onMtProgress((_pair, done, total) => { if (downloading.current) setInstalling(total ? `Downloading the language pack… ${Math.round((done / total) * 100)}% of ${(total / 1e6).toFixed(0)} MB` : 'Downloading…'); }), []);

  const install = async () => {
    if (downloading.current) return;
    // a running translation would lose its engine under it
    if (translating()) { p.toast('Wait for the translation to finish (or stop it), then update the language pack.', 'info'); return; }
    downloading.current = true;
    setInstalling('Starting the download…');
    const src = await sourceOf().catch(() => 'en');
    try { await gcc.mtInstall(src, to); setMt(await gcc.mtStatus(src, to)); p.toast('Language pack installed – translation now works without internet.', 'ok'); }
    catch (e) { p.toast(errText(e), 'err', undefined, 9000); }
    finally { downloading.current = false; setInstalling(''); }
  };

  // the runs keep to the translation they belong to (the file's, in the map), not to this view:
  // switching panels or files leaves them going, and Stop reaches them from any view of it
  const id = doc.id;
  const finish = (t: Tr, pg: number[], text: string) => { t.text = text; t.doneLen = text.length; t.done.push(...pg); };
  const goOffline = async (t: Tr, todo: number[]) => {
    const src = t.from;
    const texts = await pageTexts(doc, todo);
    for (let i = 0; i < todo.length && !t.stopped; i++) {
      const pg = todo[i];
      t.busy = `Translating page ${pg + 1}` + (t.pages.length > 1 ? ` (${t.done.length + 1} of ${t.pages.length})…` : '…');
      notify(id, true);
      const paras = paragraphs(texts.get(pg) || '');
      let body: string;
      if (!paras.join('').replace(/\s/g, '').length) body = '(No text on this page – it is a scan or a drawing. Run OCR (OCR tab) first, or translate it with Claude/ChatGPT, which can read pictures.)';
      // (into the translation's own language: Continue after the language box was changed put
      // the remaining pages into the new language under the old one's title)
      else body = (await gcc.mtTranslate(src, LANG_CODES[t.lang] || 'ar', paras)).join('\n\n');
      if (t.stopped) break;
      finish(t, [pg], t.text + (t.text ? '\n\n' : '') + `=== Page ${pg + 1} ===\n` + body);
      notify(id, true);
    }
  };
  const goAi = async (t: Tr, todo: number[]) => {
    for (let i = 0; i < todo.length && !t.stopped; i += CHUNK) {
      const chunk = todo.slice(i, i + CHUNK);
      const label = chunk.length > 1 ? `pages ${chunk[0] + 1}–${chunk[chunk.length - 1] + 1}` : `page ${chunk[0] + 1}`;
      t.busy = `Translating ${label}` + (t.pages.length > CHUNK ? ` (${Math.min(t.done.length + chunk.length, t.pages.length)} of ${t.pages.length})…` : '…');
      notify(id, true);
      const ctx = await buildContext(doc, { kind: 'pages', pages: chunk }, '', chunk[0]);
      if (t.stopped) break;
      const before = t.text;
      const r = ask(t.provider!, t.model, systemTranslate(t.lang), [{ role: 'user', parts: [...ctx.parts, { t: 'text', text: `Translate ${label} into ${t.lang}. Start each page with its heading "=== Page N ===" (N = the document's page number).` }] }], (all) => { t.text = before + (before ? '\n\n' : '') + all; notify(id); }, 8192);
      t.run = r;
      const out = await r.done;
      t.run = null;
      // stopped part way: what came is shown, but the pages count as not done (Continue
      // translates them again rather than leaving them half done)
      if (out.stop === 'stopped') { t.text = before + (before ? '\n\n' : '') + out.text; break; }
      let text = before + (before ? '\n\n' : '') + out.text;
      if (out.stop === 'max_tokens') text += `\n\n(The translation of ${label} was cut short – translate it on its own to get all of it.)`;
      finish(t, chunk, text);
    }
  };
  /** again: a new translation; resume: the same one, after the pages already done (nothing is
   *  sent or billed twice) */
  const go = async (resume = false) => {
    const old = translations.get(id);
    let t: Tr;
    if (resume && old && !old.busy) {
      t = old;
      t.text = t.text.slice(0, t.doneLen);
      t.error = undefined;
      t.stopped = false;
    } else {
      if (!offline && pages.length > 30) {
        const r = await gcc.confirm({ message: `Translate ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}?`, detail: `That is about ${Math.ceil(pages.length / CHUNK)} requests to ${PROVIDERS[provider].name}, billed to your API account. It can take a while; you can stop it at any time and keep what is done.`, buttons: ['Translate', 'Cancel'] });
        if (r !== 0) return;
      }
      if (translations.get(id)?.busy) return;
      t = { text: '', pages, lang: p.lang, provider: offline ? undefined : provider, offline, model: p.model, from: '', done: [], doneLen: 0, run: null, stopped: false };
    }
    t.busy = 'Starting…';
    translations.set(id, t);
    notify(id, true);
    const todo = t.pages.filter((pg) => !t.done.includes(pg));
    try {
      if (t.offline) {
        if (!t.from) t.from = await sourceOf(t.pages);
        await goOffline(t, todo);
      } else await goAi(t, todo);
    } catch (e) {
      const m = errText(e);
      t.error = m === 'NOT_INSTALLED' ? 'The language pack is not on this PC yet – download it first.' : m;
    } finally {
      t.busy = undefined;
      t.run = null;
      notify(id, true);
      force((x) => x + 1);
    }
  };
  const stopTr = () => { const t = translations.get(id); if (t) { t.stopped = true; t.run?.cancel(); notify(id, true); } };

  const htmlFile = async (t: Tr) => {
    const title = `${doc.name.replace(/\.pdf$/i, '')} – ${t.lang}`;
    return { title, f: await gcc.htmlToPdf(translationHtml(title, t.text, t.lang + (t.offline ? ' (offline)' : '')), title + '.pdf') };
  };
  // (a folder that can't be written to, or a file open in another program: said, not swallowed)
  const savePdf = async () => {
    if (!tr) return;
    try {
      const { title, f } = await htmlFile(tr);
      const target = await gcc.saveDialog({ title: 'Save the translation', name: title + '.pdf', path: doc.path ? doc.path.replace(/[^\\/]*$/, '') + title + '.pdf' : undefined });
      if (!target) { void gcc.dropTemp([f]); return; }
      await gcc.commit(f, target, { noBackup: true });
      p.toast('Saved ' + baseName(target), 'ok', { label: 'Open', run: () => void p.openFile(target, baseName(target)) });
    } catch (e) { p.toast('Could not save the translation: ' + errText(e), 'err', undefined, 9000); }
  };
  const openTab = async () => {
    if (!tr) return;
    try { const { title, f } = await htmlFile(tr); await p.openFile(f, title + '.pdf'); }
    catch (e) { p.toast('Could not open the translation: ' + errText(e), 'err', undefined, 9000); }
  };
  const left = tr && !tr.busy && (tr.error || tr.stopped) ? tr.pages.filter((pg) => !tr.done.includes(pg)) : [];

  const canGo = offline ? !!mt?.ok && !!mt.installed && !installing : p.hasKey;
  return (
    <>
      <div className="props-body">
        <div className="prow"><span className="plab">With</span>
          <div className="seg ai-engine">
            <button className={offline ? 'on' : ''} onClick={() => p.setEngine('offline')} disabled={!!tr?.busy} title="Translation models on this PC – free, nothing leaves the PC">On this PC</button>
            {(['anthropic', 'openai'] as AiProvider[]).map((k) => (
              <button key={k} className={p.engine === k ? 'on' : ''} onClick={() => p.setEngine(k)} disabled={!!tr?.busy} title={`Better wording, reads scans and drawings – billed to your ${PROVIDERS[k].name} API account`}>{PROVIDERS[k].name}</button>
            ))}
          </div>
        </div>
        {offline
          ? <p className="hint">Free and private – nothing leaves this PC. Plainer wording; pages need text (scans: run OCR first).</p>
          : <div className="prow"><span className="plab">Model</span>{p.modelPick}</div>}
        {!offline && !p.hasKey && <NeedKey provider={provider} onKeys={p.onKeys} what="translate" />}
        <div className="prow"><span className="plab">Pages</span>
          <select className="input sm grow tr-pages" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as never)} disabled={!!tr?.busy}>
            <option value="page">this page ({p.page + 1})</option>
            <option value="pages" disabled={p.pageSel.length < 2}>selected pages{p.pageSel.length > 1 ? ` (${p.pageSel.length})` : ''}</option>
            <option value="all">whole file ({n})</option>
          </select>
        </div>
        {offline && (
          <div className="prow"><span className="plab">From</span>
            <select className="input sm grow tr-from" value={from} onChange={(e) => setFrom(e.target.value)} disabled={!!tr?.busy}>
              <option value="auto">automatic (Arabic / English)</option>
              {LANGS.map((l) => <option key={l} value={LANG_CODES[l]}>{l}</option>)}
            </select>
          </div>
        )}
        <div className="prow"><span className="plab">Into</span>
          <select className="input sm grow tr-into" value={p.lang} onChange={(e) => p.setLang(e.target.value)} disabled={!!tr?.busy}>
            {LANGS.map((l) => <option key={l}>{l}</option>)}
          </select>
        </div>
        {offline && (
          <div className="mt-state">
            {installing ? <div className="faint busyline"><span className="spin" /> {installing}</div>
              : !mt ? <div className="faint busyline"><span className="spin" /> Checking…</div>
              : !mt.ok ? <div className="hrow"><p className="hint err">{mt.error}</p>{mt.retry && <button className="btn xs" onClick={() => setRetry((x) => x + 1)}>Try again</button>}</div>
              : !mt.installed ? (
                <div className="hrow"><button className="btn" onClick={() => void install()}>Download language pack ({Math.max(1, Math.round((mt.download || 0) / 1e6))} MB, once)</button></div>
              ) : mt.update ? (
                <div className="hrow"><span className="hint">Language pack on this PC. A newer version is out.</span><button className="btn xs" onClick={() => void install()}>Update ({Math.max(1, Math.round(mt.update.download / 1e6))} MB)</button></div>
              ) : <p className="hint">Language pack on this PC – translation runs offline.</p>}
          </div>
        )}
        <div className="hrow">
          {tr?.busy
            ? <button className="btn" onClick={stopTr}><Ico n="stop" size={14} /> Stop</button>
            : <button className="btn primary" disabled={!canGo} onClick={() => void go()}><Ico n="translate" size={15} /> Translate {pages.length > 1 ? pages.length + ' pages' : 'page ' + (pages[0] + 1)}</button>}
          {left.length > 0 && left.length < tr!.pages.length && !installing
            && <button className="btn" onClick={() => void go(true)} title="Carry on with the pages not translated yet (the finished ones are kept, not sent again)">Continue ({left.length} page{left.length > 1 ? 's' : ''} left)</button>}
          <span className="faint">{offline ? 'on this PC' : 'with ' + PROVIDERS[provider].name}</span>
        </div>
        {tr && (
          <div className="tr-out">
            {tr.busy && <div className="faint busyline"><span className="spin" /> {tr.busy}</div>}
            {tr.error && <div className="hint err">{tr.error}</div>}
            {!tr.busy && tr.text && (
              <div className="hrow">
                <button className="btn xs" onClick={() => void gcc.copyText(tr.text.replace(/^=+\s*Page\s+(\d+)\s*=+$/gim, '— Page $1 —')).then(() => p.toast('Translation copied.', 'ok'))}><Ico n="copy" size={12} /> Copy</button>
                <button className="btn xs" onClick={() => void savePdf()}>Save as PDF…</button>
                <button className="btn xs" onClick={() => void openTab()}>Open as new tab</button>
              </div>
            )}
            {tr.text && <Rich text={tr.text} goTo={p.goTo} pages={n} />}
            <p className="hint">Machine translation – check figures and contract wording before relying on it.</p>
          </div>
        )}
      </div>
    </>
  );
}
