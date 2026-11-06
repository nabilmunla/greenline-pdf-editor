// AI panel against a local stand-in for the Claude and OpenAI APIs (same request/streaming
// formats), so everything up to the network is tested here. xvfb-run -a node tests/e2e-ai.mjs
import { _electron as electron } from 'playwright';
import http from 'node:http';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-ai');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
for (const f of ['tests/data/long-spec.pdf', 'tests/data/scan.pdf']) copyFileSync(f, join(TMP, f.split('/').pop()));
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-ai'), { recursive: true, force: true });

// ---------------------------------------------------------------- the stand-in API
const seen = [];
let aborted = 0;
const sse = (res, events, ms = 15) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  res.on('close', () => { if (i < events.length) aborted++; });
  const tick = () => { if (res.destroyed) return; if (i >= events.length) { res.end(); return; } const [ev, data] = events[i++]; res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); setTimeout(tick, ms); };
  tick();
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const anth = req.headers['x-api-key'];
    const oai = (req.headers.authorization || '').replace(/^Bearer /, '');
    const key = anth || oai;
    if (key !== 'sk-ant-test' && key !== 'sk-oai-test') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); return; }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: anth ? [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }] : [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }, { id: 'tts-1' }] }));
      return;
    }
    const j = JSON.parse(body || '{}');
    seen.push({ url: req.url, headers: req.headers, body: j });
    const sys = (j.system || j.instructions || '');
    const answer = /translate/i.test(sys)
      ? '=== Page 1 ===\nيجب على المقاول تقديم جميع العمالة والمعدات.\n\n| البند | الكمية |\n|---|---|\n| خرسانة | 120 |'
      : 'The contractor must provide **all labour** [p. 2]. See also [pp. 3-4].\n\n- first point\n- second point';
    const parts = answer.match(/[\s\S]{1,12}/g);
    // a question with SLOWLY in it streams slowly (time to leave the panel and stop it)
    const ms = /SLOWLY/.test(body) ? 400 : 15;
    if (req.url === '/v1/messages') {
      sse(res, [['message_start', { type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 1 } } }], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ...parts.map((t) => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }]),
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }], ['message_stop', { type: 'message_stop' }]], ms);
    } else if (req.url === '/v1/responses') {
      sse(res, [['response.created', { type: 'response.created' }], ...parts.map((t) => ['response.output_text.delta', { type: 'response.output_text.delta', delta: t }]), ['response.completed', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 900, output_tokens: 30 } } }]]);
    } else { res.writeHead(404); res.end(); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let app, win;
const E = (fn, arg) => win.evaluate(fn, arg);
const until = async (fn, ms = 30000, what = 'condition') => {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(100); }
  throw new Error('timed out waiting for ' + what);
};
const ok = (c, m) => { if (!c) throw new Error(m); };
async function step(name, fn) {
  const t = Date.now();
  try { const info = await fn(); results.push({ ok: true }); console.log(`PASS ${name} (${Date.now() - t} ms)${info ? ' – ' + info : ''}`); }
  catch (e) { results.push({ ok: false }); console.log(`FAIL ${name}: ${e.message}`); await win.screenshot({ path: join(TMP, 'fail-' + name.replace(/\W+/g, '_').slice(0, 50) + '.png') }).catch(() => {}); }
}

app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--password-store=basic', '--profile=ai', join(TMP, 'long-spec.pdf')], env: { ...process.env, PDFED_AI_ANTHROPIC: base, PDFED_AI_OPENAI: base } });
win = await app.firstWindow();
win.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await app.evaluate(({ dialog }) => {
  globalThis.__q = { save: [] };
  dialog.showSaveDialog = async () => { const f = globalThis.__q.save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  dialog.showMessageBox = async () => ({ response: 0 });
});
await until(() => E(() => window.__gcc?.active()?.pages.length > 0), 30000, 'file open');
const panel = () => win.locator('.ai-panel');
const lastAnswer = () => panel().locator('.msg.assistant').last();

await step('AI tab opens the panel; a wrong key is refused, the right one kept (encrypted)', async () => {
  await win.locator('.rtab', { hasText: 'AI' }).click();
  await win.locator('.ribbon .rb', { hasText: 'Ask about this file' }).click();
  await panel().waitFor();
  await until(() => panel().locator('.ai-note button', { hasText: 'Add key' }).count(), 10000, 'add key offered');
  await panel().locator('.ai-note button', { hasText: 'Add key' }).click();
  const keysDlg = () => win.locator('.modal', { hasText: 'AI keys' });
  const inp = keysDlg().locator('.keyrow').nth(0).locator('input[type=password]');
  await inp.fill('sk-ant-wrong');
  await keysDlg().locator('.keyrow').nth(0).locator('button', { hasText: 'Save key' }).click();
  await until(() => keysDlg().locator('.err').count(), 10000, 'error shown');
  const err = await keysDlg().locator('.err').first().textContent();
  ok(/refused the API key/.test(err), err);
  await inp.fill('sk-ant-test');
  await keysDlg().locator('.keyrow').nth(0).locator('button', { hasText: 'Save key' }).click();
  await until(() => keysDlg().locator('.keystate.ok').count(), 10000, 'key saved');
  // a wrong key pasted over a working one: refused, and the working one stays
  await inp.fill('sk-ant-typo');
  await keysDlg().locator('.keyrow').nth(0).locator('button', { hasText: 'Save key' }).click();
  await until(async () => /refused/.test((await keysDlg().locator('.err').first().textContent()) || '') && !(await keysDlg().locator('button', { hasText: 'Checking' }).count()), 10000, 'second error');
  ok(await keysDlg().locator('.keyrow').nth(0).locator('.keystate.ok').count(), 'the saved key was dropped by a failed replacement');
  await inp.fill('');
  await keysDlg().locator('button', { hasText: 'Done' }).click();
  await until(() => panel().locator('.ai-input textarea').count(), 10000, 'ask view');
  const s = JSON.parse(readFileSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-ai', 'settings.json'), 'utf8'));
  ok(s.aiKeys && s.aiKeys.anthropic && !JSON.stringify(s).includes('sk-ant-test'), 'key stored encrypted');
  return 'error: ' + err.slice(0, 60);
});

await step('ask about this page: the page goes as a PDF, answer streams with page links', async () => {
  await E(() => window.__gcc.viewer().goTo(1));
  await sleep(400);
  await panel().locator('.ai-input select').selectOption('page');
  await panel().locator('.ai-input textarea').fill('Who provides the labour?');
  await panel().locator('.ai-input textarea').press('Enter');
  await until(() => lastAnswer().locator('.cite').count(), 20000, 'answer with citations');
  await until(async () => !(await lastAnswer().locator('.busyline').count()), 10000, 'finished');
  const b = seen[seen.length - 1];
  ok(b.url === '/v1/messages' && b.headers['anthropic-version'] === '2023-06-01', 'headers');
  const c = b.body.messages[0].content;
  ok(c.some((x) => x.type === 'document' && x.source.media_type === 'application/pdf' && x.source.data.length > 1000), 'pdf part');
  ok(c[c.length - 1].type === 'text' && /Who provides/.test(c[c.length - 1].text), 'question last');
  ok(c.some((x) => x.cache_control), 'context cached');
  ok(/claude-sonnet-5-5/.test(b.body.model) && b.body.stream === true, 'model/stream');
  const sent = await panel().locator('.sent-h').last().textContent();
  ok(/page 2 as a PDF/.test(sent), sent);
  // a citation jumps to its page
  await lastAnswer().locator('.cite').first().click();
  await sleep(500);
  const pg = await E(() => window.__gcc.viewer().page());
  ok(pg === 1, 'went to page 2, got ' + (pg + 1));
  return sent.trim();
});

await step('follow-up keeps the conversation and does not resend the pages', async () => {
  await panel().locator('.ai-input textarea').fill('And the plant?');
  await panel().locator('.ai-input textarea').press('Enter');
  await until(async () => (await panel().locator('.msg.assistant').count()) === 2 && !(await lastAnswer().locator('.busyline').count()), 20000, 'second answer');
  const m = seen[seen.length - 1].body.messages;
  ok(m.length === 3 && m[1].role === 'assistant' && m[2].content.length === 1 && m[2].content[0].text === 'And the plant?', JSON.stringify(m.map((x) => x.role)));
  return '3 messages, context sent once';
});

await step('whole 1,500-page file: text with page numbers, the most relevant pages within the budget', async () => {
  await panel().locator('button', { hasText: 'New' }).click();
  await panel().locator('.ai-input select').selectOption('all');
  await panel().locator('.ai-input textarea').fill('What does clause 9 say about materials?');
  const t = Date.now();
  await panel().locator('.ai-input textarea').press('Enter');
  await until(async () => (await panel().locator('.msg.assistant').count()) === 1 && (await lastAnswer().locator('.cite').count()), 60000, 'answer');
  const c = seen[seen.length - 1].body.messages[0].content;
  const txt = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  const pages = (txt.match(/=== Page \d+/g) || []).length;
  ok(pages > 10 && txt.length < 400000, `pages ${pages}, ${txt.length} chars`);
  const sent = await panel().locator('.sent-h').last().textContent();
  return `${Date.now() - t} ms; ${sent.trim()}`;
});

await step('Stop while the pages are read: nothing is sent', async () => {
  await panel().locator('button', { hasText: 'New' }).click();
  await panel().locator('.ai-input select').selectOption('all');
  const before = seen.length;
  await panel().locator('.ai-input textarea').fill('Which clauses mention retention?');
  await panel().locator('.ai-input textarea').press('Enter');
  await panel().locator('.ai-input button[title=Stop]').click({ timeout: 5000 });
  await until(async () => !(await lastAnswer().locator('.busyline').count()), 30000, 'stopped');
  await sleep(500);
  const err = (await lastAnswer().locator('.err').textContent().catch(() => '')) || '';
  ok(seen.length === before, `a request went out (${seen.length - before}) – ${err}`);
  ok(/nothing was sent/.test(err), err);
  return err;
});

await step('leave the panel mid-answer: on return it is still streaming, and Stop stops it', async () => {
  await panel().locator('button', { hasText: 'New' }).click();
  await panel().locator('.ai-input select').selectOption('page');
  await panel().locator('.ai-input textarea').fill('Answer SLOWLY please');
  await panel().locator('.ai-input textarea').press('Enter');
  await until(async () => /Writing/.test((await lastAnswer().locator('.busyline').textContent().catch(() => '')) || ''), 20000, 'streaming');
  await panel().locator('button[title=Close]').click();
  await sleep(1300);
  await win.locator('.ribbon .rb', { hasText: 'Ask about this file' }).click();
  const len = async () => ((await lastAnswer().locator('.rich').textContent().catch(() => '')) || '').length;
  const a = await len();
  await sleep(1300);
  const b = await len();
  ok(b > a, `the answer stopped growing after coming back (${a} -> ${b})`);
  const ab = aborted;
  await panel().locator('.ai-input button[title=Stop]').click();
  await until(async () => !(await lastAnswer().locator('.busyline').count()), 10000, 'stopped');
  await until(() => aborted > ab, 5000, 'request aborted at the server');
  ok(await lastAnswer().locator('.ans-tools', { hasText: 'stopped' }).count(), 'shown as stopped');
  // the list kept to the end while it streamed; scrolled up, typing doesn't pull it down
  return `${a} -> ${b} chars, aborted`;
});

await step('ChatGPT: Responses API format, streams too', async () => {
  await panel().locator('.ai-provider button', { hasText: 'ChatGPT' }).click();
  await panel().locator('.ai-note button', { hasText: 'Add key' }).click();
  const kd = win.locator('.modal', { hasText: 'AI keys' });
  await kd.locator('.keyrow').nth(1).locator('input[type=password]').fill('sk-oai-test');
  await kd.locator('.keyrow').nth(1).locator('button', { hasText: 'Save key' }).click();
  await until(() => kd.locator('.keyrow').nth(1).locator('.keystate.ok').count(), 10000, 'key saved');
  await kd.locator('button', { hasText: 'Done' }).click();
  await until(() => panel().locator('.ai-input textarea').count(), 10000, 'ask view');
  const opts = await panel().locator('.ai-row .ai-model option').allTextContents();
  ok(!opts.some((o) => /tts/.test(o)), 'non-chat models filtered: ' + opts.join('|'));
  await panel().locator('.ai-input select').selectOption('page');
  await panel().locator('.ai-input textarea').fill('Summarise this page');
  await panel().locator('.ai-input textarea').press('Enter');
  await until(async () => { const b = seen[seen.length - 1]; return b.url === '/v1/responses' && !(await lastAnswer().locator('.busyline').count()) && (await lastAnswer().locator('.cite').count()); }, 20000, 'answer');
  const b = seen[seen.length - 1];
  ok(b.headers.authorization === 'Bearer sk-oai-test' && b.body.instructions && b.body.stream, 'request');
  const c = b.body.input[0].content;
  ok(c.some((x) => x.type === 'input_file' && /^data:application\/pdf;base64,/.test(x.file_data)) && c[c.length - 1].type === 'input_text', JSON.stringify(c.map((x) => x.type)));
  return opts.join(' | ');
});

await step('translate this page into Arabic: right-to-left, save as PDF with real Arabic text', async () => {
  await panel().locator('.ai-provider button', { hasText: 'Claude' }).click();
  await panel().locator('.ai-tabs button', { hasText: 'Translate' }).click();
  await panel().locator('.ai-engine button', { hasText: 'Claude' }).click();
  await panel().locator('.tr-into').selectOption('Arabic').catch(() => {});
  await panel().locator('button', { hasText: /Translate page/ }).click();
  await until(() => panel().locator('.tr-out .rich[dir=rtl]').count(), 20000, 'arabic shown');
  await until(async () => !(await panel().locator('.tr-out .busyline').count()), 20000, 'done');
  const sys = seen[seen.length - 1].body.system;
  ok(/into Arabic/.test(sys), 'target language in instructions');
  const out = join(TMP, 'translated.pdf');
  await app.evaluate((_e, f) => { globalThis.__q.save.push(f); }, out);
  await panel().locator('button', { hasText: 'Save as PDF' }).click();
  await until(() => existsSync(out), 20000, 'pdf saved');
  await sleep(300);
  const d = mupdf.Document.openDocument(readFileSync(out), 'application/pdf');
  const text = d.loadPage(0).toStructuredText().asText();
  ok(/[؀-ۿ]{3,}/.test(text) && /120/.test(text), 'arabic text in pdf: ' + JSON.stringify(text.slice(0, 120)));
  return JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 90));
});

await step('a scanned page goes as a PDF (the AI sees the picture)', async () => {
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'scan.pdf'));
  await until(() => E(() => window.__gcc.active()?.name === 'scan.pdf'), 20000, 'scan open');
  await win.locator('.rtab', { hasText: 'AI' }).click();
  await win.locator('.ribbon .rb', { hasText: 'Ask about this file' }).click();
  await panel().locator('.ai-input textarea').fill('What is the amount?');
  await panel().locator('.ai-input textarea').press('Enter');
  await until(async () => !(await lastAnswer().locator('.busyline').count()) && (await lastAnswer().locator('.cite').count()), 20000, 'answer');
  const c = seen[seen.length - 1].body.messages[0].content;
  ok(c.some((x) => x.type === 'document'), 'pdf sent');
  // the answer cites pages 2-4 of a one-page file: shown, but not live
  const dead = await lastAnswer().locator('.cite.nopage').count();
  const live = await lastAnswer().locator('.cite:not(.nopage)').count();
  ok(dead >= 1 && live === 0 && await lastAnswer().locator('.cite.nopage').first().isDisabled(), `${dead} disabled, ${live} live`);
  return `${dead} out-of-range citations disabled`;
});

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
server.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
