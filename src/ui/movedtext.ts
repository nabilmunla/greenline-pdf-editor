// The notice a company copy sees once, after it moved to Greenline (PLAN 11.1; wording: PLAN 11.4, Fable's).
// Audited 18 Nov (0.13.0). The same sentence is the first line of the update card's notes on the share (publish.py --bridge).
// Nothing here names a share, an edition or a GitHub path, and nothing promises a new icon or shortcut name:
// those stay "PDF Editor" until a Greenline setup is run some day (PLAN 11, the user's answer of 18 Nov).
export const MOVED_TITLE = 'This is now Greenline PDF Editor';
export const MOVED_BODY = 'PDF Editor is now Greenline PDF Editor: the same app under a new name. Your files, your settings and the way PDFs open stay the same. Updates now come from the internet. The shortcut and its icon keep the old name, PDF Editor.';
/** only where Settings › Updates offers going back (kept 30 days after the move) */
export const MOVED_BACK = (v: string) => `If something is not right, you can go back to version ${v} for the next 30 days: Settings › Updates › Go back to ${v}.`;
export const MOVED_OK = 'OK';
