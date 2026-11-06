// Where new versions come from: a folder (the company share, as always) or the web.
//   - a folder path: <folder>\latest.json, <folder>\<package>
//   - a GitHub repository (https://github.com/<owner>/<repo>): the newest release -
//     releases/latest/download/latest.json, and each package from the release of its own version
//     (releases/download/v<version>/<file>), so a release published between the check and the
//     download can't hand over another version's file
//   - any other http(s) address: <address>/latest.json, <address>/<file>
// Whatever the place, nothing is installed unless latest.json carries the publisher's signature
// and the package matches its SHA-256 (updsig.cjs, updater.cjs).
'use strict';

const isWeb = (src) => /^https?:\/\//i.test(String(src || '').trim());

/** { owner, repo } for a GitHub repository address, else null */
function github(src) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(String(src || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}
const base = (src) => String(src).trim().replace(/\/+$/, '') + '/';
const gh = (g) => `https://github.com/${g.owner}/${g.repo}`;

function latestUrl(src) {
  const g = github(src);
  return g ? `${gh(g)}/releases/latest/download/latest.json` : base(src) + 'latest.json';
}
function fileUrl(src, version, file) {
  const name = encodeURIComponent(String(file).split(/[\\/]/).pop());
  const g = github(src);
  return g ? `${gh(g)}/releases/download/v${encodeURIComponent(version)}/${name}` : base(src) + name;
}
/** where a person downloads a version's setup by hand */
function releasePage(src, version) {
  const g = github(src);
  if (g) return version ? `${gh(g)}/releases/tag/v${encodeURIComponent(version)}` : `${gh(g)}/releases/latest`;
  return String(src).trim();
}
/** a new GitHub issue with the report's text filled in ('' when the updates come from elsewhere) */
function issueUrl(src, title, body) {
  const g = github(src);
  if (!g) return '';
  const u = (b) => `${gh(g)}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
  // (an address too long is refused by the browser or by GitHub: the body is cut to fit)
  let b = String(body);
  while (b.length > 200 && u(b).length > 7000) b = b.slice(0, Math.floor(b.length * 0.8)) + '\n…';
  return u(b);
}

module.exports = { isWeb, github, latestUrl, fileUrl, releasePage, issueUrl };
