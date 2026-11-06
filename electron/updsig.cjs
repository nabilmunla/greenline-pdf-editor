// Updates are trusted only when latest.json is signed with the publisher's key (Ed25519).
// The updates folder is a share many people can write to: before 0.8.2 whoever could write
// there could also change the checksums in latest.json and have every PC install their program.
// Now latest.json carries "signed" (the JSON text the app goes by) and "signature" (of exactly
// those bytes); the key that makes signatures stays with the developer copy (keys/, never in the
// source zip or on the share). Older copies read the plain fields beside them, as before.
'use strict';
const crypto = require('crypto');

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlcN5QOaoQ7xNgeV4p70wyE/8MXF+35lpkRK/scT58gs=
-----END PUBLIC KEY-----
`;

/** latest.json as read from the folder -> { latest } (the signed part) or { err } */
function verifyLatest(j, key = PUBLIC_KEY) {
  if (!j || typeof j !== 'object' || typeof j.signed !== 'string' || typeof j.signature !== 'string') return { err: 'latest.json is not signed by the publisher' };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(j.signed, 'utf8'), crypto.createPublicKey(key), Buffer.from(j.signature, 'base64')); } catch (_) { ok = false; }
  if (!ok) return { err: "latest.json's signature doesn't match - it was changed after it was published" };
  try { return { latest: JSON.parse(j.signed) }; } catch (_) { return { err: 'latest.json: the signed part is not valid' }; }
}

/** the publisher's side (scripts/sign-latest.mjs, tests) */
function signLatest(payload, privateKeyPem) {
  const signed = JSON.stringify(payload, null, 2);
  const signature = crypto.sign(null, Buffer.from(signed, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { ...payload, signed, signature };
}

module.exports = { verifyLatest, signLatest, PUBLIC_KEY };
