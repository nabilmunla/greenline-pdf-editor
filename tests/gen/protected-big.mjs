// A generated big file that is protected (permissions only: it opens without a password) or
// signed (its form says so: /SigFlags 3) - PLAN 10.7. Three pages of invented text, then filler: one
// random (incompressible) stream written over and over in an update appended to the file, so a
// 1.1 GB file is made in a few seconds and never whole in memory. For the protected kind the filler
// is the stream as MuPDF encrypted it (AES-256: one key for the whole file, so every copy decrypts).
// Invented content only.
import * as mupdf from 'mupdf';
import { openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const text = (s) => Buffer.from(s, 'latin1');

/**
 * Writes `path`: `kind` 'protected' or 'signed', about `bytes` long. Returns { path, size, pages: 3 }.
 */
export function makeProtectedBig(path, bytes, kind = 'protected') {
  // the small start: three pages and one 2 MB filler stream (random bytes) hung from the catalog
  const d = new mupdf.PDFDocument();
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, `BT /F1 24 Tf 72 700 Td (PROTECTED PAGE ${i + 1}) Tj ET 72 600 200 100 re S`));
  const FILL = 2 * 1024 * 1024;
  const blob = d.addStream(randomBytes(FILL), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] });
  d.getTrailer().get('Root').put('GCCFill', d.newArray());
  d.getTrailer().get('Root').get('GCCFill').push(blob);
  if (kind === 'signed') {
    const f = d.newDictionary();
    f.put('SigFlags', 3);
    f.put('Fields', d.newArray());
    d.getTrailer().get('Root').put('AcroForm', f);
  }
  const base = Buffer.from(d.saveToBuffer(kind === 'protected' ? 'encrypt=aes-256,owner-password=owner-x,permissions=-9' : '').asUint8Array());
  const blobNum = blob.asIndirect();
  // the stream's bytes as they stand in the file
  const hdr = base.indexOf(text(`\n${blobNum} 0 obj`));
  const st = base.indexOf(text('stream\n'), hdr) + 7;
  const len = Number(/\/Length (\d+)/.exec(base.subarray(hdr, st).toString('latin1'))[1]);
  const raw = base.subarray(st, st + len);
  // the tail of the base: Root, Encrypt, ID, Size, startxref
  const tail = base.subarray(Math.max(0, base.length - 4096)).toString('latin1');
  const trailer = tail.slice(tail.lastIndexOf('trailer'));
  const size = Number(/\/Size (\d+)/.exec(trailer)[1]);
  const root = /\/Root (\d+) 0 R/.exec(trailer)[1];
  // (the rest of the trailer as it is - the /Encrypt dictionary stands in it)
  const rest = /trailer\s*<<([\s\S]*)>>\s*startxref/.exec(trailer)[1].replace(/\/Size \d+/, '').replace(/\/Root \d+ 0 R/, '');
  const prev = Number(/startxref\s+(\d+)/.exec(trailer)[1]);
  const pages = `${d.getTrailer().get('Root').get('Pages').asIndirect()} 0 R`;
  // the update: K copies of the stream, then the catalog again with them listed
  const each = len + 80;
  const K = Math.max(1, Math.ceil((bytes - base.length) / each));
  const fd = openSync(path, 'w');
  let pos = 0;
  const put = (b) => { for (let w = 0; w < b.length;) w += writeSync(fd, b, w, b.length - w); pos += b.length; };
  put(base);
  const offs = [];
  for (let k = 0; k < K; k++) {
    offs.push(pos);
    put(text(`${size + k} 0 obj\n<</Type/XObject/Subtype/Form/BBox[0 0 1 1]/Length ${len}>>\nstream\n`));
    put(raw);
    put(text('\nendstream\nendobj\n'));
  }
  const catAt = pos;
  const refs = offs.map((_, k) => `${size + k} 0 R`).join(' ');
  put(text(`${root} 0 obj\n<</Type/Catalog/Pages ${pages}${kind === 'signed' ? '/AcroForm<</SigFlags 3/Fields[]>>' : ''}/GCCFill[${refs}]>>\nendobj\n`));
  const xref = pos;
  let x = `xref\n${root} 1\n${String(catAt).padStart(10, '0')} 00000 n\r\n${size} ${K}\n`;
  for (const o of offs) x += `${String(o).padStart(10, '0')} 00000 n\r\n`;
  x += `trailer\n<</Size ${size + K}/Root ${root} 0 R${rest}/Prev ${prev}>>\nstartxref\n${xref}\n%%EOF\n`;
  put(text(x));
  closeSync(fd);
  return { path, size: pos, pages: 3 };
}
