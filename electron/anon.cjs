// A report as it leaves the PC anonymously (the public build's report receiver): no user or PC
// name, no paths or file names, the time to the hour. What the person typed in "Report a problem"
// goes as typed - they wrote it for the developer - except their own user and PC names.
'use strict';

const FILE_EXT = 'pdf|docx?|xlsx?|xlsm|csv|txt|png|jpe?g|tiff?|bmp|gif|dwg|dxf|zip|json|md|html?|pptx?|msg|eml';

/** paths and file names out of a piece of text (and the user / PC names, wherever they show).
 *  who.words: names known to be private on this PC - the recent files' names and folders - taken
 *  out first, whole, spaces and all (a name with spaces can't be told from the words around it) */
function scrub(text, { user = '', pc = '', words = [] } = {}) {
  let s = String(text || '');
  // 1. the names this PC knows are private: longest first ("Tower B GA.pdf" before "Tower B")
  const known = [...new Set((words || []).map((w) => String(w || '').trim()).filter((w) => w.length >= 3))].sort((a, b) => b.length - a.length);
  for (const w of known) s = s.split(w).join(/\.[a-z0-9]{2,5}$/i.test(w) ? '<file>' : '<name>');
  s = replaceNames(s, { user, pc });
  // 2. the app's own files: their place on this PC goes, the code location stays
  s = s.replace(/\b[A-Za-z]:[\\/][^"'|*?\r\n]*?[\\/]resources[\\/]app(?:\.old)?[\\/]/gi, '<app>/');
  // 3. every other path, to the end of the path: up to a quote, a bracket that closes the line,
  //    or the end of the line (spaces included - "C:\Users\John Smith\Bids\BOQ rev 3.pdf")
  s = s.replace(/file:\/\/\/?[^\s"'<>)]*/gi, '<path>');
  // (a name already taken out in 1 - "<name>" - can sit inside a path: the path goes on through it)
  s = s.replace(/\b[A-Za-z]:[\\/][^"'|*?\r\n]*/g, '<path>');
  s = s.replace(/\\\\[^"'|*?\r\n\\]+\\[^"'|*?\r\n]*/g, '<path>');
  s = s.replace(/(^|[\s"'(=])\/(?:home|Users|tmp|mnt|media|var|private|Volumes|sessions)\/[^"'\r\n]*/g, '$1<path>');
  // 4. a file name on its own: in quotes whole, else with up to six words before it ("Tower B GA.pdf")
  s = s.replace(new RegExp(`(["'])[^"'\\r\\n]{1,200}?\\.(?:${FILE_EXT})\\1`, 'gi'), '$1<file>$1');
  s = s.replace(new RegExp(`(?:[^\\s"'<>/\\\\:]+ ){0,6}[^\\s"'<>/\\\\:]+\\.(?:${FILE_EXT})\\b`, 'gi'), '<file>');
  return s;
}

/** the report as it is sent: only these fields, scrubbed, cut to size */
function anonymize(rep, who = {}) {
  const r = rep || {};
  const cut = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  const hour = (t) => { const d = new Date(t || Date.now()); d.setUTCMinutes(0, 0, 0); return isNaN(d) ? undefined : d.toISOString(); };
  const out = {
    kind: r.kind === 'problem' ? 'problem' : 'crash',
    app: cut(r.app, 40),
    version: cut(r.version, 20),
    runtime: cut(r.runtime, 20),
    windows: cut(r.windows, 40),
    arch: cut(r.arch, 10),
    memoryMB: r.memoryMB && typeof r.memoryMB === 'object' ? { total: Number(r.memoryMB.total) || 0, free: Number(r.memoryMB.free) || 0 } : undefined,
    uptimeMin: Number.isFinite(r.uptimeMin) ? r.uptimeMin : undefined,
    time: hour(r.time),
    where: cut(scrub(r.where, who), 200),
    message: r.message != null ? cut(scrub(r.message, who), 2000) : undefined,
    stack: r.stack ? cut(scrub(r.stack, who), 8000) : undefined,
    // (the person's own words: as typed - only their user and PC names come out)
    text: r.text != null ? cut(replaceNames(String(r.text), who), 20000) : undefined,
    openFiles: Number.isFinite(r.openFiles) ? r.openFiles : undefined,
    log: r.log ? cut(scrub(String(r.log).split('\n').slice(-120).join('\n'), who), 30000) : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k];
  return out;
}
function replaceNames(s, { user = '', pc = '' } = {}) {
  for (const [name, mark] of [[user, '<user>'], [pc, '<pc>']]) {
    const n = String(name || '').trim();
    if (n.length >= 2) s = s.split(n).join(mark);
  }
  return s;
}

module.exports = { scrub, anonymize };
