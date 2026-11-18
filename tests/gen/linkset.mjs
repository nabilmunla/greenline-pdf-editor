// A generated link-heavy sheet set (PLAN 10.3): `pages` sheets of `links` links each, every link
// its own object - web links with their own actions, links to the next sheet (destinations of
// their own) and, on every sheet, one link to a shared action (a GoTo to sheet 1) and one to a
// shared destination (the last sheet): one object each, used by every sheet. That is how a
// hyperlinked CAD set is made (a real one: 225,000 links). Written as text, without MuPDF, so the
// test's engine memory holds none of it. Invented content only.
//
//   node tests/gen/linkset.mjs OUT.pdf PAGES LINKS
import { openSync, writeSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** writes the set to `file`; returns its size, the links per kind, and the objects */
export function makeLinkSet(file, pages, links) {
  const fd = openSync(file, 'w');
  let pos = 0;
  const offs = [];
  let buf = [], bufLen = 0;
  const put = (s) => { buf.push(s); bufLen += s.length; pos += s.length; if (bufLen > 4 << 20) flush(); };
  const flush = () => { if (buf.length) writeSync(fd, Buffer.from(buf.join(''), 'latin1')); buf = []; bufLen = 0; };
  const obj = (n, body) => { offs[n] = pos; put(`${n} 0 obj\n${body}\nendobj\n`); };
  // numbering: 1 catalog, 2 page tree, 3 font, 4 shared action, 5 shared destination,
  // then per sheet: page, content, its links
  const per = 2 + links;
  const pageNo = (i) => 6 + i * per;
  const counts = { web: 0, next: 0, sharedAction: 0, sharedDest: 0 };
  try {
    put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${pageNo(i)} 0 R`).join(' ')}] >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    obj(4, `<< /S /GoTo /D [${pageNo(0)} 0 R /Fit] >>`);
    obj(5, `[${pageNo(pages - 1)} 0 R /Fit]`);
    for (let i = 0; i < pages; i++) {
      const p = pageNo(i);
      const annots = Array.from({ length: links }, (_, k) => `${p + 2 + k} 0 R`).join(' ');
      obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1191 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${p + 1} 0 R /Annots [${annots}] >>`);
      const c = `BT /F1 40 Tf 80 760 Td (SHEET ${i + 1}) Tj ET 0 0 1 RG 2 w 60 60 1071 640 re S`;
      offs[p + 1] = pos;
      put(`${p + 1} 0 obj\n<< /Length ${c.length} >>\nstream\n${c}\nendstream\nendobj\n`);
      for (let k = 0; k < links; k++) {
        const x = 20 + (k % 100) * 11, y = 20 + Math.floor(k / 100) % 70 * 11;
        let to;
        if (k === 0) { to = '/A 4 0 R'; counts.sharedAction++; }
        else if (k === 1) { to = '/Dest 5 0 R'; counts.sharedDest++; }
        else if (k % 10 === 2) { to = `/Dest [${pageNo((i + 1) % pages)} 0 R /XYZ 0 842 0]`; counts.next++; }
        else { to = `/A << /S /URI /URI (https://example.com/sheet/${i + 1}/${k}) >>`; counts.web++; }
        obj(p + 2 + k, `<< /Type /Annot /Subtype /Link /Rect [${x} ${y} ${x + 9} ${y + 9}] /Border [0 0 0] ${to} >>`);
      }
    }
    const n = 6 + pages * per;
    const xref = pos;
    put(`xref\n0 ${n}\n0000000000 65535 f \n`);
    for (let k = 1; k < n; k++) put(String(offs[k]).padStart(10, '0') + ' 00000 n \n');
    put(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    flush();
    return { size: pos, objects: n, links: pages * links, counts };
  } finally { closeSync(fd); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, pages, links] = process.argv.slice(2);
  const r = makeLinkSet(out, Number(pages), Number(links));
  console.log(`${out}: ${pages} sheets, ${r.links} links, ${(r.size / 1e6).toFixed(1)} MB`);
}
