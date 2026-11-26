'use strict';
// "Is there a file here?" for the window (the replace check before writing new files). A network
// share the person didn't choose is refused without being looked at: looking would make Windows
// send the person's sign-in to that server (DeepSeek 0.13.2 #6). Local paths are looked at as
// before - the replace check needs them, wherever the person sends new files.

/** a share path: \\server\x, //server/x, \\?\UNC\server\x */
const isShare = (s) => /^[\\/]{2}/.test(s);

function existsFor(p, isChosen, exists) {
  if (typeof p !== 'string' || !p) return false;
  if (isShare(p) && !isChosen(p)) throw new Error('not a place you chose: ' + p);
  return exists(p);
}

module.exports = { existsFor };
