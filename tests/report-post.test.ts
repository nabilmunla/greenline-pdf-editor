// PLAN 13.2.5 (F34) and 13.2.6 (F17), the report job run for real (electron/update-worker.cjs post)
// against a stand-in receiver:
// - F34: the public build's reportEndpoint is the receiver's bare address, but the receiver takes
//   reports only at /report: every report was refused. Sent to /report now (not doubled when the
//   address already ends in it).
// - F17: the person's own words went out with only the user and PC names taken out - paths and file
//   names in them were sent, although the Report a problem window says they are taken out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const posts: { url: string; body: Record<string, unknown> }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { posts.push({ url: req.url || '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); res.writeHead(200); res.end('Thanks'); });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const dirs: string[] = [];
after(() => { server.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const TEXT = 'Saving failed for C:\\Jobs\\Tower X\\plan-X-100.pdf and \\\\fileserver\\tenders\\boq.xlsx, also /home/sam/work/spec.pdf - "Level 3 sections.pdf" froze too. The ruler looks upside down.';

async function sendOne(endpoint: string) {
  const q = mkdtempSync(join(tmpdir(), 'rep-q-'));
  dirs.push(q);
  writeFileSync(join(q, 'r1.json'), JSON.stringify({ kind: 'problem', time: new Date().toISOString(), version: '0.13.2', text: TEXT }));
  posts.length = 0;
  await new Promise<void>((resolve) => execFile(process.execPath, [join(import.meta.dirname, '..', 'electron', 'update-worker.cjs'), 'post', endpoint, q, '0', ''], () => resolve()));
  return posts.slice();
}

test('F34: a bare receiver address gets the report at /report', async () => {
  const p = await sendOne(base);
  assert.equal(p.length, 1, 'one report sent');
  assert.equal(p[0].url, '/report');
});

test('F34: an address that already ends in /report is not doubled', async () => {
  const p = await sendOne(base + '/report');
  assert.equal(p[0].url, '/report');
});

test('F17: paths and file names in the person\'s words are taken out, the rest is kept', async () => {
  const [p] = await sendOne(base);
  const t = String(p.body.text);
  for (const leak of ['Jobs', 'Tower X', 'plan-X-100', 'fileserver', 'tenders', 'boq.xlsx', '/home/sam', 'work/', 'spec.pdf', 'Level 3 sections']) assert.ok(!t.includes(leak), `"${leak}" is not sent: ${t}`);
  assert.ok(t.includes('The ruler looks upside down.') && t.startsWith('Saving failed for'), 'their own words are kept: ' + t);
});

test('F17 (review): web links are taken out too (a SharePoint address carries the company name)', async () => {
  const { scrubText } = await import('../electron/anon.cjs');
  const t = scrubText('It broke after I opened https://contoso-my.sharepoint.com/personal/sam/Documents/Tender%20X/plan.pdf?web=1 yesterday.', {});
  assert.equal(t, 'It broke after I opened <link> yesterday.');
});

test('F17 (review): a long paste with no spaces is scrubbed quickly', async () => {
  const { anonymize } = await import('../electron/anon.cjs');
  const t0 = performance.now();
  const out = anonymize({ kind: 'problem', time: new Date().toISOString(), text: 'x'.repeat(300_000) }, {});
  const ms = performance.now() - t0;
  assert.ok(String(out.text).length <= 20000);
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});

test('sweep S1: a queue file that holds plain JSON null (not a report) is skipped, the reports after it still go', async () => {
  const q = mkdtempSync(join(tmpdir(), 'rep-q-'));
  dirs.push(q);
  writeFileSync(join(q, '0000.json'), 'null');
  writeFileSync(join(q, 'r1.json'), JSON.stringify({ kind: 'problem', time: new Date().toISOString(), version: '0.13.2', text: 'hello' }));
  posts.length = 0;
  await new Promise<void>((resolve) => execFile(process.execPath, [join(import.meta.dirname, '..', 'electron', 'update-worker.cjs'), 'post', base, q, '0', ''], () => resolve()));
  assert.equal(posts.length, 1, 'the report after it was sent');
});

test('sweep S2: a file name with spaces in a path goes whole, the words after it stay', async () => {
  const { scrubText } = await import('../electron/anon.cjs');
  assert.equal(scrubText('Saved C:\\Work\\Tower B GA Plan Rev 3.pdf and then it broke', { user: 'Nabil', pc: 'DESK1' }), 'Saved <path> and then it broke');
  assert.equal(scrubText('Opened C:\\Users\\Nabil\\Bids\\BOQ rev 3.pdf', { user: 'Nabil', pc: 'DESK1' }), 'Opened <path>');
});
