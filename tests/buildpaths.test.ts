// Nothing shipped may hold the build machine's paths (its home folder
// names the account). scripts/buildpaths.py is run at the end of a publish; it reads every entry
// of a zip itself (an unzip that skipped entries could have passed files it never looked at).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const run = (...files: string[]) => spawnSync('python3', ['scripts/buildpaths.py', '--needle', '/home/builder', '--needle', 'C:\\Users\\builder', ...files], { encoding: 'utf8' });

test('a shipped file holding the build machine\'s home path fails the publish; clean files pass', () => {
  const d = mkdtempSync(join(tmpdir(), 'bp-'));
  try {
    const clean = join(d, 'app.zip'), dirty = join(d, 'app2.zip'), exe = join(d, 'x.exe'), exe16 = join(d, 'y.exe'), broken = join(d, 'bad.zip');
    writeFileSync(clean, zipSync({ 'a.js': strToU8('console.log(1)'), 'deep/b.wasm': new Uint8Array(5000) }));
    writeFileSync(dirty, zipSync({ 'a.js': strToU8('ok'), 'deep/b.js': strToU8('at /home/builder/src/app/x.ts:3') }));
    writeFileSync(exe, Buffer.concat([Buffer.alloc(100), Buffer.from('panic in /home/builder/go/pkg/mod/x.go'), Buffer.alloc(100)]));
    writeFileSync(exe16, Buffer.concat([Buffer.alloc(10), Buffer.from('C:\\Users\\builder\\AppData', 'utf16le')]));
    writeFileSync(broken, Buffer.concat([zipSync({ 'a.js': strToU8('ok') }).subarray(0, 40)]));
    assert.equal(run(clean).status, 0, run(clean).stdout + run(clean).stderr);
    const r = run(clean, dirty, exe, exe16);
    assert.notEqual(r.status, 0);
    for (const s of ['app2.zip!deep/b.js', 'x.exe', 'y.exe']) assert.match(r.stdout + r.stderr, new RegExp(s.replace(/[.!/]/g, '\\$&')));
    assert.notEqual(run(broken).status, 0, 'a zip that can\'t be read whole fails too');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
