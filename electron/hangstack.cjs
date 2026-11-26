'use strict';
// 14.7: the window stopped answering - what was it running? The renderer's JavaScript call stack
// (webContents.mainFrame.collectJavaScriptCallStack) goes into the log under "window not
// responding", trimmed and with the person's names and paths taken out like the rest of the log.
// Before this, a freeze left one line and no clue (the Comments-list freeze, 25 Nov 2026).
const { scrub } = require('./anon.cjs');

const MAX_FRAMES = 40;
const MAX_CHARS = 4000;

/** the stack as it goes into the log ('' when there is nothing to say) */
function stackForLog(raw, who) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const lines = raw.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  let keep = lines.slice(0, MAX_FRAMES);
  if (lines.length > keep.length) keep.push(`    (${lines.length - keep.length} more frames)`);
  let s = scrub(keep.join('\n'), who || {});
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS - 20) + '\n    (cut)';
  return s;
}

module.exports = { stackForLog, MAX_FRAMES, MAX_CHARS };
