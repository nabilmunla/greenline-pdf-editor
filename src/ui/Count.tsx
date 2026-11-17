// The anonymous user counter (Greenline build only): the first-start pop-up and Settings › Privacy.
// The words are in counttext.ts (shared with Rev Radar); electron/count.cjs does the counting.
import { useEffect, useState } from 'react';
import { gcc, type CountState } from './api';
import { Modal } from './Modal';
import { COUNT_BODY, COUNT_HINT, COUNT_KEEP, COUNT_OFF, COUNT_SWITCH, COUNT_TITLE } from './counttext';

/** the pop-up: two buttons; closing it any other way is no answer (nothing is sent until it is answered) */
export function CountDlg({ close, fail }: { close(): void; fail(e: unknown): void }) {
  const answer = async (keep: boolean) => {
    try { await gcc.countAnswer(keep); close(); } catch (e) { fail(e); }
  };
  return (
    <Modal title={COUNT_TITLE} onClose={() => {}}
      actions={<><button className="btn" onClick={() => void answer(false)}>{COUNT_OFF}</button><button className="btn primary" autoFocus onClick={() => void answer(true)}>{COUNT_KEEP}</button></>}>
      {COUNT_BODY.map((t, i) => <p key={i} className="count-text">{t}</p>)}
    </Modal>
  );
}

/** Settings › Privacy: the switch (shown only where the counter exists) */
export function PrivacyRow({ fail }: { fail(e: unknown): void }) {
  const [st, setSt] = useState<CountState | null>(null);
  useEffect(() => { let live = true; void gcc.countState().then((x) => { if (live) setSt(x); }).catch(() => {}); return () => { live = false; }; }, []);
  if (!st || !st.active) return null;
  return (
    <div className="row"><label>Privacy</label>
      <label className="check">
        <input type="checkbox" checked={st.on} onChange={async (e) => { const on = e.target.checked; setSt({ ...st, on }); try { setSt(await gcc.countSet(on)); } catch (x) { setSt(st); fail(x); } }} />
        <span>{COUNT_SWITCH}</span>
      </label>
      <p className="hint">{COUNT_HINT}</p>
    </div>
  );
}
