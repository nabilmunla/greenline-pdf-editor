// Loaded before MuPDF.js (the engine bundle's first import; tests import it first too).
// MuPDF.js builds its WebAssembly module on this object, which leaves two cheap journal
// functions reachable (where the undo journal is, how many steps it has): MuPDF.js's own
// getJournal() also reads every step's name, each found by walking the list from the start -
// with 2,000 undo steps each markup took 20 ms more, growing with the square of the steps.
// mu.ts uses them when they are there and getJournal() when not (MuPDF.js loaded first).
globalThis.$libmupdf_wasm_Module ??= {};
