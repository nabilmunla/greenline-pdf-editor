// The notice after a company copy moved to Greenline (electron/updater.cjs adopt / moveToFeed; words: movedtext.ts).
// Shown once: closing it in any way marks it seen.
import { useEffect, useState } from 'react';
import { gcc } from './api';
import { Modal } from './Modal';
import { MOVED_BACK, MOVED_BODY, MOVED_OK, MOVED_TITLE } from './movedtext';

export function MovedDlg({ close }: { close(): void }) {
  const [back, setBack] = useState('');
  useEffect(() => { let live = true; void gcc.updateGet().then((u) => { if (live) setBack(u.previousOld ? u.previous || '' : ''); }).catch(() => {}); return () => { live = false; }; }, []);
  const done = () => { void gcc.updateMovedDone().catch(() => {}); close(); };
  return (
    <Modal title={MOVED_TITLE} onClose={done} actions={<button className="btn primary" autoFocus onClick={done}>{MOVED_OK}</button>}>
      <p className="count-text">{MOVED_BODY}</p>
      {back && <p className="count-text">{MOVED_BACK(back)}</p>}
    </Modal>
  );
}
