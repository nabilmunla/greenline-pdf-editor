// Test stand-in for Mozilla's bergamot-translator.js loader: same API surface, no real model.
// "Translates" by tagging each text with the target language; checks the files it is given.
function loadBergamot(Module) {
  if (!Module.wasmBinary || !Module.wasmBinary.length) throw new Error('no wasm');
  class AlignedMemory { constructor(size, align) { this.size = size; this.align = align; this.buf = new Uint8Array(size); } getByteArrayView() { return this.buf; } }
  class List { constructor() { this.items = []; } push_back(x) { this.items.push(x); } delete() {} get(k) { return this.items[k]; } size() { return this.items.length; } }
  class TranslationModel {
    constructor(from, to, config, model, lex, vocabs) {
      const head = String.fromCharCode(...model.buf.slice(0, 9));
      if (head !== 'FAKEMODEL') throw new Error('bad model file');
      if (!/gemm-precision/.test(config) || vocabs.items.length < 1 || model.align !== 256 || lex.align !== 64) throw new Error('bad setup');
      this.from = from; this.to = to;
    }
  }
  const respond = (to, texts) => ({ get: (k) => ({ getTranslatedText: () => '[' + to + '] ' + texts.items[k] }), delete() {} });
  class BlockingService {
    translate(m, texts, opts) { if (opts.items.length !== texts.items.length) throw new Error('opts'); return respond(m.to, texts); }
    translateViaPivoting(a, b, texts) { return respond(a.to + '>' + b.to, texts); }
  }
  Object.assign(Module, { AlignedMemory, AlignedMemoryList: List, VectorString: List, VectorResponseOptions: List, TranslationModel, BlockingService });
  setTimeout(() => Module.onRuntimeInitialized(), 10);
  return Module;
}
