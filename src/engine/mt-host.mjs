// Offline translation engine (its own background process): Mozilla's Firefox Translations
// (Bergamot) runtime + models, everything on this PC. Started only when used.
//
// Messages from the main process (process.parentPort):
//   { id, type: 'load', wasm, glue, models: [{ from, to, files: { model, lex, vocab | srcvocab+trgvocab } }] }
//      one model, or two for a pivot through English (e.g. fr -> en -> ar)
//   { id, type: 'translate', texts: string[] }
// Answers { id, ok, value | error }.
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const port = process.parentPort;

/** Bergamot wants each file at a given memory alignment */
const ALIGN = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };
/** decoder settings as Firefox uses them (greedy, int8) */
const CONFIG = `
beam-size: 1
normalize: 1.0
word-penalty: 0
max-length-break: 128
mini-batch-words: 1024
workspace: 128
max-length-factor: 2.0
skip-cost: true
cpu-threads: 0
quiet: true
quiet-translation: true
gemm-precision: int8shiftAlphaAll
alignment: soft
`;

let B = null; // the runtime
let service = null;
let models = [];
let loadedKey = '';
let runtimeFiles = '';

async function runtime(wasm, glue) {
  if (B && runtimeFiles === wasm + '|' + glue) return B;
  const src = readFileSync(glue, 'utf8');
  const loadBergamot = runInThisContext(`(function () {\n${src}\nreturn loadBergamot;\n})()`, { filename: glue });
  const log = console.log;
  console.log = () => {}; // the loader announces which gemm it uses
  try {
    B = await new Promise((resolve, reject) => {
      const m = loadBergamot({
        INITIAL_MEMORY: 234_291_200,
        wasmBinary: readFileSync(wasm),
        print: () => {},
        printErr: () => {},
        onAbort: (r) => reject(new Error('Translation engine stopped: ' + r)),
        onRuntimeInitialized: () => resolve(m),
      });
    });
  } finally { console.log = log; }
  runtimeFiles = wasm + '|' + glue;
  service = new B.BlockingService({ cacheSize: 0 });
  return B;
}

function loadModel(spec) {
  const mem = (role, file) => {
    const bytes = readFileSync(file);
    const a = new B.AlignedMemory(bytes.byteLength, ALIGN[role]);
    a.getByteArrayView().set(bytes);
    return a;
  };
  const vocabs = new B.AlignedMemoryList();
  if (spec.files.vocab) vocabs.push_back(mem('vocab', spec.files.vocab));
  else { vocabs.push_back(mem('srcvocab', spec.files.srcvocab)); vocabs.push_back(mem('trgvocab', spec.files.trgvocab)); }
  return new B.TranslationModel(spec.from, spec.to, CONFIG, mem('model', spec.files.model), mem('lex', spec.files.lex), vocabs, null);
}

const handlers = {
  async load({ wasm, glue, models: specs }) {
    const key = specs.map((s) => `${s.from}-${s.to}:${s.files.model}`).join('|');
    if (key === loadedKey && models.length) return true;
    // one route per process (loading a second model into a used runtime is not safe):
    // a different language pair means a fresh process, which the main process arranges
    if (models.length) throw new Error('RESTART');
    await runtime(wasm, glue);
    models = specs.map(loadModel);
    loadedKey = key;
    return true;
  },
  translate({ texts }) {
    if (!models.length) throw new Error('No language loaded');
    const out = [...texts];
    const at = [];
    const edges = [];
    const v = new B.VectorString();
    const opts = new B.VectorResponseOptions();
    let res = null;
    try {
      texts.forEach((t, i) => {
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t);
        if (!m[2]) return;
        at.push(i);
        edges.push([m[1], m[3]]);
        v.push_back(m[2]);
        opts.push_back({ qualityScores: false, alignment: false, html: false });
      });
      if (!at.length) return out;
      res = models.length === 1 ? service.translate(models[0], v, opts) : service.translateViaPivoting(models[0], models[1], v, opts);
      at.forEach((pos, k) => { out[pos] = edges[k][0] + res.get(k).getTranslatedText() + edges[k][1]; });
      return out;
    } finally {
      v.delete();
      opts.delete();
      res?.delete?.();
    }
  },
};

let chain = Promise.resolve();
port.on('message', (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      const h = handlers[msg.type];
      if (!h) throw new Error('unknown ' + msg.type);
      port.postMessage({ id: msg.id, ok: true, value: await h(msg) });
    } catch (err) {
      port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
});
port.postMessage({ type: 'ready' });
