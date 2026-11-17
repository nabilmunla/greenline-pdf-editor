// The R set (PLAN Phase 7, Rule R): files that are NOT a drawing set, or only partly one. Every
// drawing feature must find nothing (or only what is really there), say so, change nothing and never
// throw on them. Shared by the feature tests.
//
//   import { ensure } from './rset.mjs';  const R = ensure();  R.longSpec, R.scan, R.mixed, ...
//
// longSpec and scan are in tests/data; the rest is generated into tests/tmp-sets/ when missing (or
// older than the generator).
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { write, SET_FILES } from './gen/sheetset.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const DATA = here('./data/');
export const TMP = here('./tmp-sets/');
const GEN = here('./gen/sheetset.mjs');

export const paths = {
  /** 1,500 pages of specification text (time-bounded features) */
  longSpec: resolve(DATA, 'long-spec.pdf'),
  /** pages with no text at all */
  scan: resolve(DATA, 'scan.pdf'),
  /** 12 A1 sheets + 30 A4 spec pages + 12 A3 sheets (with truth) */
  mixed: resolve(TMP, SET_FILES.mixed + '.pdf'),
  /** a single sheet */
  onePage: resolve(TMP, SET_FILES.onepage + '.pdf'),
  /** 8 A3 sheets, AES-256, password "test" */
  password: resolve(TMP, SET_FILES.password + '.pdf'),
  /** the first 60 % of the bytes of set A (broken: the cross-reference table is gone) */
  cutShort: resolve(TMP, 'cut-short.pdf'),
  /** the drawing sets themselves (with truth) */
  setA: resolve(TMP, SET_FILES.A + '.pdf'),
  setB: resolve(TMP, SET_FILES.B + '.pdf'),
};
export const PASSWORD = 'test';
/** the truth JSON next to a generated file */
export const truthOf = (pdf) => JSON.parse(readFileSync(pdf.replace(/\.pdf$/, '.truth.json'), 'utf8'));

/** make the generated files that are missing (or older than the generator); returns the paths */
export function ensure() {
  const gen = statSync(GEN).mtimeMs;
  const stale = (f) => !existsSync(f) || statSync(f).mtimeMs < gen;
  mkdirSync(TMP, { recursive: true });
  for (const [name, key] of [['A', 'setA'], ['B', 'setB'], ['mixed', 'mixed'], ['onepage', 'onePage'], ['password', 'password']]) if (stale(paths[key])) write(name, TMP);
  if (stale(paths.cutShort)) { const b = readFileSync(paths.setA); writeFileSync(paths.cutShort, b.subarray(0, Math.floor(b.length * 0.6))); }
  return paths;
}
