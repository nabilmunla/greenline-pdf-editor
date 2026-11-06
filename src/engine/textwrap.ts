// Text box line breaking - the same in the engine (what is saved) and in the typing box
// (what you see while typing), so the text doesn't jump when typing ends.

/** lines of `text` wrapped at word breaks to `width` (words longer than a line are broken) */
export function wrapText(text: string, width: number, w: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let line = '';
    for (const word of para.split(/(?<= )/)) {
      if (!line || w((line + word).trimEnd()) <= width) { line += word; if (w(line.trimEnd()) <= width) continue; }
      else { out.push(line.trimEnd()); line = word; if (w(line.trimEnd()) <= width) continue; }
      // a word longer than the line: break it
      let cut = '';
      for (const ch of line) {
        if (cut && w(cut + ch) > width) { out.push(cut); cut = ''; }
        cut += ch;
      }
      line = cut;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** padding inside a text box's border (pt); a typewriter (no box) has 1 pt all round */
export const TEXT_PAD = { x: 3, top: 2.5, bottom: 2 };
export const TYPE_PAD = { x: 1, top: 1, bottom: 1 };
/** the narrowest a box that fits its text gets (text area, in font sizes) */
export const AUTO_MIN = 1.2;
