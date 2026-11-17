// A generated layered file (PLAN 7.8): one page, four coloured squares on four layers - Walls
// (black), Furniture (red, OFF in the file), Grid (blue, listed under Walls), Notes (green, locked)
// - each with a word beside it on its own layer. Invented content only.
import * as mupdf from 'mupdf';

export function layered() {
  const d = new mupdf.PDFDocument();
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const mk = (name) => { const g = d.newDictionary(); g.put('Type', d.newName('OCG')); g.put('Name', d.newString(name)); return d.addObject(g); };
  const walls = mk('Walls'), furn = mk('Furniture'), grid = mk('Grid'), notes = mk('Notes');
  const props = d.newDictionary();
  props.put('L1', walls); props.put('L2', furn); props.put('L3', grid); props.put('L4', notes);
  const res = d.newDictionary();
  res.put('Properties', props);
  const fonts = d.newDictionary(); fonts.put('F1', font); res.put('Font', fonts);
  const word = (x, t) => `BT /F1 14 Tf 0.5 g ${x} 170 Td (${t}) Tj ET `;
  const content = `/OC /L1 BDC 0 0 0 rg 50 50 100 100 re f ${word(50, 'WALLSWORD')} EMC /OC /L2 BDC 1 0 0 rg 200 50 100 100 re f ${word(200, 'FURNWORD')} EMC /OC /L3 BDC 0 0 1 rg 350 50 100 100 re f ${word(350, 'GRIDWORD')} EMC /OC /L4 BDC 0 1 0 rg 500 50 60 100 re f ${word(480, 'NOTESWORD')} EMC`;
  d.insertPage(-1, d.addPage([0, 0, 600, 200], 0, res, content));
  const ocp = d.newDictionary();
  const arr = (...x) => { const a = d.newArray(); for (const y of x) a.push(y); return a; };
  ocp.put('OCGs', arr(walls, furn, grid, notes));
  const D = d.newDictionary();
  D.put('Order', arr(walls, arr(grid), furn, notes));
  D.put('OFF', arr(furn));
  D.put('Locked', arr(notes));
  ocp.put('D', D);
  d.getTrailer().get('Root').put('OCProperties', ocp);
  return d.saveToBuffer('').asUint8Array().slice();
}
