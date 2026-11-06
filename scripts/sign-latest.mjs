// Sign latest.json for the updates folder:  node scripts/sign-latest.mjs <latest.json> [key.pem]
// (key: keys/update-signing-key.pem - the developer copy only; see electron/updsig.cjs)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { signLatest, verifyLatest } = require(resolve(ROOT, 'electron', 'updsig.cjs'));
// (--check: only that the key is there and is the one the app trusts - publish.py asks before it
// builds anything, so a missing key no longer leaves a finished-looking folder with latest.json unsigned)
const check = process.argv[2] === '--check';
const [file, keyArg] = check ? ['', process.argv[3]] : process.argv.slice(2);
// (PDFED_SIGNING_KEY: a key kept outside the source folder - e.g. building the public copy)
const keyFile = keyArg || process.env.PDFED_SIGNING_KEY || resolve(ROOT, 'keys', 'update-signing-key.pem');
if (!existsSync(keyFile)) { console.error('No signing key at ' + keyFile + ' - updates must be signed (see NOTES.md, "Update signing").'); process.exit(1); }
if (check) {
  let back;
  try { back = verifyLatest(signLatest({ version: '0.0.0-check' }, readFileSync(keyFile, 'utf8'))); } catch (e) { back = { err: String(e && e.message || e) }; }
  if (!back.latest) { console.error('The signing key at ' + keyFile + " isn't the one the app trusts (" + back.err + ').'); process.exit(1); }
  console.log('signing key: OK');
  process.exit(0);
}
const j = JSON.parse(readFileSync(file, 'utf8'));
delete j.signed; delete j.signature;
const out = signLatest(j, readFileSync(keyFile, 'utf8'));
const back = verifyLatest(out);
if (!back.latest) { console.error('signature check failed: ' + back.err + ' (is the key the one the app trusts?)'); process.exit(1); }
writeFileSync(file, JSON.stringify(out, null, 2));
console.log('signed', file);
