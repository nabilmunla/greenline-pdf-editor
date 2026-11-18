// The notice for a protected or signed file over 1.2 GB (PLAN 10.7b): its saves can run out of memory.
import type { LockedBig } from '../engine/mu';

/** shown once, when such a file is opened (the same place as the damaged-file notice) */
export function lockedBigNotice(name: string, kind: LockedBig): string {
  const is = kind === 'both' ? 'protected and digitally signed' : kind === 'protected' ? 'protected' : 'digitally signed';
  const copy = kind === 'both' ? 'an unprotected, unsigned copy' : kind === 'protected' ? 'an unprotected copy' : 'an unsigned copy';
  return `${name} is ${is} and over 1.2 GB. You can view it and mark it up, but saving it may fail. To keep your work, print the pages you need to a PDF, or ask for ${copy}.`;
}
