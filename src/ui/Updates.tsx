// Updates: the card that offers a new version (bottom right) and the Updates part of Settings.
import { useEffect, useState } from 'react';
import { gcc, type UpdateState, type UpdatedInfo, type ReportStatus, type NoteGroups } from './api';
import { Ico } from './icons';
import { newerVersion } from './pagesel';
import releaseNotes from '../../release-notes.json';
import { APP_NAME } from './brand';

/** this app's own notes for a version (shipped with it): groups, or one plain list (up to 0.5.0) */
export function notesOf(version: string): NoteGroups | null {
  const n = (releaseNotes as Record<string, string[] | NoteGroups>)[version];
  if (!n) return null;
  if (Array.isArray(n)) return { '': n };
  // (groups named "Public: ..." are the public build's own - its copy of this file has them merged in)
  const own = Object.fromEntries(Object.entries(n).filter(([k]) => !k.startsWith('Public: ')));
  return Object.keys(own).length ? own : null;
}
/** every version with notes, newest first */
export const noteVersions = (): string[] => Object.keys(releaseNotes).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

/** "What's new": a few short lines per group (TLDR) */
export function WhatsNew({ groups, compact }: { groups: NoteGroups; compact?: boolean }) {
  return (
    <div className={'whatsnew' + (compact ? ' compact' : '')}>
      {Object.entries(groups).filter(([, v]) => v.length).map(([k, v]) => (
        <div key={k} className="wn-group">
          {k && <div className="wn-head">{k}</div>}
          <ul>{v.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}
/** a "What's new" link that opens the notes in place (optional reading) */
function NotesToggle({ groups }: { groups: NoteGroups | null }) {
  const [open, setOpen] = useState(false);
  if (!groups || !Object.values(groups).some((v) => v.length)) return null;
  return (
    <>
      <button className="link up-wn" aria-expanded={open} onClick={() => setOpen(!open)}>What's new {open ? '▴' : '▾'}</button>
      {open && <WhatsNew groups={groups} compact />}
    </>
  );
}

const mb = (n?: number) => Math.max(1, Math.round((n || 0) / 1e6)) + ' MB';
function ago(t: number) {
  if (!t) return 'not checked yet';
  const d = new Date(t), now = new Date();
  // (day/month and 24-hour like every other date in the app - not the PC's own format)
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'checked today ' + hm;
  return 'checked ' + d.toLocaleDateString('en-GB') + ' ' + hm;
}

/** the update state, kept current */
export function useUpdates() {
  const [u, setU] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    void gcc.updateGet().then((s) => { if (live) setU(s); });
    const off = gcc.onUpdate((s) => setU(s));
    return () => { live = false; off(); };
  }, []);
  return u;
}


/** bottom-right card: "0.4.1 is available" → downloading → "ready, restart" (or "updated to …") */
/** "Restart now" and the like: the update program is checked first (a few seconds) - one click */
function RestartBtn({ now, label, primary, title }: { now: boolean; label: string; primary?: boolean; title?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className={'btn sm' + (primary ? ' primary' : '')} title={title} disabled={busy} onClick={async () => { setBusy(true); try { await gcc.updateRestart(now); } finally { setBusy(false); } }}>
      {busy && primary ? 'Checking…' : label}
    </button>
  );
}

export function UpdateCard({ u, updated, onDone }: { u: UpdateState | null; updated: UpdatedInfo | null; onDone(): void }) {
  if (updated) {
    return (
      <div className="upcard" role="status">
        <div className="up-head"><Ico n="check" size={16} /><b>{updated.back ? `Back to version ${updated.to}` : `Updated to ${updated.to}`}</b></div>
        {!updated.back && <NotesToggle groups={notesOf(updated.to) || updated.groups || (updated.notes.length ? { '': updated.notes } : null)} />}
        <div className="up-btns"><button className="btn sm primary" onClick={onDone}>OK</button></div>
      </div>
    );
  }
  if (!u || !u.show || !['available', 'downloading', 'ready', 'error', 'blocked', 'setup'].includes(u.state) || !u.available) return null;
  const admin = u.scope === 'machine' ? <p className="up-sub">Windows will ask for admin rights to finish.</p> : null;
  return (
    <div className="upcard" role="status">
      {u.state === 'available' && (
        <>
          <div className="up-head"><Ico n="download" size={16} /><b>{APP_NAME} {u.available} is available</b></div>
          <p className="up-sub">You have {u.version}.</p>
          <NotesToggle groups={u.groups || (u.notes?.length ? { '': u.notes } : null)} />
          <div className="up-btns">
            <button className="btn sm" onClick={() => void gcc.updateLater()}>Later</button>
            <button className="btn sm primary" onClick={() => void gcc.updateDownload()}>Update ({mb(u.size)})</button>
          </div>
        </>
      )}
      {u.state === 'downloading' && (
        <>
          <div className="up-head"><Ico n="download" size={16} /><b>Getting {u.available}…</b></div>
          {/* (a progress bar a screen reader knows; the number is not read out each time it moves -
              the card is a live region, and it changed several times a second) */}
          <div className="up-bar" role="progressbar" aria-label={`Getting ${u.available}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((u.pct || 0) * 100)}><i style={{ width: Math.round((u.pct || 0) * 100) + '%' }} /></div>
          <div className="up-btns"><span className="up-sub grow" aria-hidden="true">{Math.round((u.pct || 0) * 100)}% of {mb(u.size)}</span><button className="btn sm" onClick={() => void gcc.updateCancel()}>Cancel</button></div>
        </>
      )}
      {u.state === 'ready' && (
        <>
          <div className="up-head"><Ico n="check" size={16} /><b>{u.available} is ready</b></div>
          <p className="up-sub">{APP_NAME} restarts to finish and reopens your files. You're asked to save changes first.</p>
          {admin}
          <div className="up-btns">
            <RestartBtn now={false} label="When I close it" />
            <RestartBtn now primary label="Restart now" />
          </div>
        </>
      )}
      {u.state === 'blocked' && (
        <>
          {u.err === 'unfinished' ? <>
            <div className="up-head err"><Ico n="warn" size={16} /><b>The update to {u.available} didn't finish</b></div>
            <p className="up-sub">{APP_NAME} started again on {u.version}. Nothing was lost. Try again - or, if it keeps failing (the antivirus or Windows stopping it), close {APP_NAME} and run <b>{setupName(u)}</b>{fromWhere(u)}: your files and settings stay.</p>
          </> : <>
            <div className="up-head err"><Ico n="warn" size={16} /><b>{APP_NAME} can't update itself on this PC</b></div>
            <p className="up-sub">Your antivirus or Windows stopped its update program, so nothing was closed or changed. Install {u.available} with the setup instead: close {APP_NAME}, then run <b>{setupName(u)}</b>{fromWhere(u)} - your files and settings stay.</p>
          </>}
          <div className="up-btns">
            <button className="btn sm" onClick={() => void gcc.updateLater()}>Later</button>
            <RestartBtn now label="Try again" title="After IT has allowed it" />
            <SetupBtn u={u} />
          </div>
        </>
      )}
      {u.state === 'setup' && (
        <>
          <div className="up-head"><Ico n="download" size={16} /><b>{APP_NAME} {u.available} is available</b></div>
          <p className="up-sub">This version installs with its setup, not by itself (it brings a new version of its built-in browser). Close {APP_NAME}, then run <b>{setupName(u)}</b>{fromWhere(u)} - your files and settings stay.</p>
          {admin}
          <NotesToggle groups={u.groups || (u.notes?.length ? { '': u.notes } : null)} />
          <div className="up-btns">
            <button className="btn sm" onClick={() => void gcc.updateLater()}>Later</button>
            <SetupBtn u={u} />
          </div>
        </>
      )}
      {u.state === 'error' && (
        <>
          <div className="up-head err"><Ico n="warn" size={16} /><b>Couldn't get {u.available}</b></div>
          <p className="up-sub">{u.err} Your current version is unchanged.</p>
          <div className="up-btns">
            <button className="btn sm" onClick={() => void gcc.updateLater()}>Later</button>
            <button className="btn sm primary" onClick={() => void gcc.updateDownload()}>Try again</button>
          </div>
        </>
      )}
    </div>
  );
}

/** the setup to run by hand when the update program is blocked */
/** where the setup of a version is: the updates folder, or (updates from the web) its download page */
const fromWhere = (u: UpdateState) => (!u.setupPath ? '' : u.web ? ' from its download page' : ' from the updates folder');
function SetupBtn({ u }: { u: UpdateState }) {
  if (!u.setupPath) return null;
  return u.web
    ? <button className="btn sm primary" onClick={() => void gcc.openLink(u.setupPath!)}>Open the download page</button>
    : <button className="btn sm primary" onClick={() => void gcc.showInFolder(u.setupPath!)}>Show the setup</button>;
}
const setupName = (u: UpdateState) => (u.setupPath && /\.exe$/i.test(u.setupPath) ? u.setupPath.split(/[\\/]/).pop() : `${APP_NAME} Setup ${u.available}.exe`);

function statusLine(u: UpdateState): string {
  switch (u.state) {
    case 'checking': return 'Checking…';
    case 'none': return 'You have the newest version (' + ago(u.checked) + ').';
    case 'available': return `Version ${u.available} is available.`;
    case 'downloading': return `Getting ${u.available}… ${Math.round((u.pct || 0) * 100)}%`;
    case 'ready': return u.pendingAtExit ? `Version ${u.available} is installed when you close ${APP_NAME}.` : `Version ${u.available} is ready.`;
    case 'error': return 'Problem: ' + (u.err || 'unknown');
    case 'blocked': return u.err === 'unfinished'
      ? `The update to ${u.available} didn't finish - try again, or install it with "${setupName(u)}"${fromWhere(u) || ' from the updates folder'}.`
      : `Version ${u.available} is downloaded, but this PC doesn't let ${APP_NAME} run its update program (antivirus) - install it with "${setupName(u)}"${fromWhere(u) || ' from the updates folder'}.`;
    case 'setup': return `Version ${u.available} is available - it installs with "${setupName(u)}"${fromWhere(u) || ' from the updates folder'} (run it by hand; it can't update itself).`;
    case 'off': return 'No updates folder: this copy doesn\'t look for new versions.';
    case 'unreachable': return u.web ? 'The update server can\'t be reached right now (no internet?).' : 'The updates folder can\'t be reached from this PC right now (normal away from the company network).';
    case 'empty': return u.web ? 'Nothing has been published there yet.' : 'Nothing has been published in that folder yet.';
    default: return u.checked ? 'Last ' + ago(u.checked) + '.' : 'Not checked yet.';
  }
}

/** Settings → Updates */
export function UpdatesSection({ toast }: { toast(t: string, k?: 'ok' | 'err' | 'info'): void }) {
  const u = useUpdates();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { if (u && src === null) setSrc(u.source); }, [u, src]);
  if (!u) return null;
  const commit = async (v: string) => {
    if (v.trim() === u.source) return;
    const s = await gcc.updateSource(v.trim());
    setSrc(s.source);
  };
  const browse = async () => {
    const d = await gcc.dirDialog({ title: 'Folder where new versions are published', dir: src || undefined });
    if (d) { setSrc(d); await commit(d); }
  };
  const where = u.scope === 'machine' ? 'for everyone on this PC' : 'for you';
  return (
    <div className="row"><label>Updates</label>
      {u.installed ? (
        <>
          <p className="hint">Version {u.version}, installed {where} in {u.dir}</p>
          <div className="hrow">
            <input className="input" value={src ?? ''} placeholder="No automatic updates" spellCheck={false}
              onChange={(e) => setSrc(e.target.value)} onBlur={(e) => void commit(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void commit((e.target as HTMLInputElement).value); }} />
            <button className="btn sm" onClick={() => void browse()}>Browse…</button>
          </div>
          <p className="hint">{u.web ? 'The web address new versions are published at.' : 'The shared folder where new versions are published.'} {APP_NAME} asks before downloading anything.
            {u.ownSource && u.setupSource && u.setupSource !== u.source && <> <button className="link" onClick={async () => { const s = await gcc.updateSource(null); setSrc(s.source); }}>Use the installer's folder</button></>}
            {u.defaultSource && u.defaultSource !== u.source && <> <button className="link" onClick={async () => { const s = await gcc.updateSource(u.defaultSource!); setSrc(s.source); }}>Use the download page (default)</button></>}
          </p>
          <div className="hrow">
            <button className="btn sm" disabled={!u.source || u.state === 'checking' || u.state === 'downloading'} onClick={async () => { await commit(src ?? ''); await gcc.updateCheck(); }}>Check now</button>
            {u.state === 'available' && <button className="btn sm primary" onClick={() => void gcc.updateDownload()}>Update ({mb(u.size)})</button>}
            {(u.state === 'ready' || u.state === 'blocked') && !u.pendingAtExit && <RestartBtn now primary label={u.state === 'blocked' ? 'Try again' : 'Restart now'} />}
            {u.state === 'setup' && <SetupBtn u={u} />}
            <span className="hint up-status">{statusLine(u)}</span>
          </div>
          {u.previous && u.previous !== u.version && (() => {
            // after going back, the version kept is the newer one just left: the button says where it
            // really goes (it said "Go back to" the newer version)
            const fwd = newerVersion(u.previous!, u.version);
            return (
              <div className="hrow">
                <button className="btn sm" onClick={async () => {
                  const r = await gcc.confirm(fwd
                    ? { message: `Return to version ${u.previous}?`, detail: `${APP_NAME} restarts with version ${u.previous} - the newer one you went back from. You're asked to save changes first.`, buttons: ['Return to it', 'Cancel'] }
                    : { message: `Go back to version ${u.previous}?`, detail: `${APP_NAME} restarts with the version you had before this update. You're asked to save changes first.`, buttons: ['Go back', 'Cancel'] });
                  const back = r === 0 ? await gcc.updateRollback() : true;
                  if (back !== true) toast(back === 'blocked' ? `This PC doesn't let ${APP_NAME} run its update program (antivirus), so it can't switch versions by itself. Run the setup of the version you want instead.` : `There is no other version to ${fwd ? 'return' : 'go back'} to.`, 'err');
                }}>{fwd ? 'Return to' : 'Go back to'} {u.previous}</button>
                <span className="hint">{fwd ? 'The newer version you went back from.' : "If something in this version doesn't work for you."}</span>
              </div>
            );
          })()}
        </>
      ) : (
        <p className="hint">Version {u.version}. This copy wasn't installed with {APP_NAME} Setup, so it doesn't update itself. New versions come with the setup.</p>
      )}
    </div>
  );
}

/** Settings → Help: report a problem; reports still waiting on this PC */
export function ReportsRow({ onReport, onWhatsNew }: { onReport(): void; onWhatsNew(): void }) {
  const [st, setSt] = useState<ReportStatus | null>(null);
  useEffect(() => {
    let live = true;
    const get = () => void gcc.reportStatus().then((x) => { if (live) setSt(x); }).catch(() => {});
    get();
    const off = gcc.onReports(get);
    return () => { live = false; off(); };
  }, []);
  return (
    <div className="row"><label>Help</label>
      <div className="hrow">
        <button className="btn sm" onClick={onWhatsNew}>What's new</button>
        <button className="btn sm" onClick={onReport}><Ico n="report" size={15} /> Report a problem…</button>
        <span className="hint up-status">
          {!st ? '' : st.waiting > 0
            ? `${st.waiting} report${st.waiting === 1 ? '' : 's'} waiting on this PC${st.state === 'failed' ? (st.anon ? ' - sent once the internet can be reached' : " - the reports folder can't be reached right now") : st.state === 'nofolder' ? ' - no updates folder set' : ''}.`
            : st.anon ? 'Report a problem sends your words to the developer, anonymously.' : st.folder ? 'Reports go to ' + st.folder + '.' : st.state === 'web' ? 'Reports stay on this PC; Report a problem opens an issue on GitHub.' : 'No updates folder: reports stay on this PC.'}
        </span>
        {st && st.waiting > 0 && <button className="btn sm" onClick={() => void gcc.reportOpenQueue()}>Show them</button>}
      </div>
      {st?.anon ? <AnonReports st={st} set={setSt} /> : <p className="hint">{st?.state === 'web' ? 'Crash reports are kept on this PC only (nothing is sent by itself).' : 'Crashes are reported by themselves (once per kind a day), the same way.'}</p>}
    </div>
  );
}

/** public build: anonymous reports - the crash-report switch (off until turned on) and what is sent */
function AnonReports({ st, set }: { st: ReportStatus; set(s: ReportStatus): void }) {
  const [example, setExample] = useState<string | null>(null);
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={!!st.crashes} onChange={async (e) => set(await gcc.reportCrashSharing(e.target.checked))} />
        <span>Send anonymous crash reports (off until you turn it on; only crashes from then on are sent)</span>
      </label>
      <details className="hint anon-what">
        <summary>What's sent, and where</summary>
        <p><b>Sent:</b> the app and Windows versions, memory, what went wrong (the error and the app's recent log) - and for Report a problem, the words you type and the picture of the window if you keep it.</p>
        <p><b>Taken out first:</b> your Windows user name, the PC's name, every file name, folder and path. The time is rounded to the hour.</p>
        <p><b>Never sent:</b> your PDF files. (The picture of the window, if you keep it in Report a problem, shows whatever is on screen - untick it when that's private.)</p>
        <p><b>Where:</b> the developer's own small receiver, hosted on Cloudflare - no analytics or crash-reporting company. Like any web host, Cloudflare sees your internet address; the receiver doesn't keep it. Read only by the developer, deleted after 6 months. Crash reports aren't kept on this PC either unless the box above is ticked.</p>
        <button className="btn sm" onClick={async () => setExample(example === null ? await gcc.reportPreview() : null)}>{example === null ? 'Show an example' : 'Hide the example'}</button>
        {example !== null && <pre className="anon-example">{example}</pre>}
      </details>
    </>
  );
}
