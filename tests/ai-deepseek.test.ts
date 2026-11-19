// DeepSeek as the third provider (PLAN 12): what a model may be given, and what the panel says when it is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
(globalThis as any).window = { gcc: {}, addEventListener() {} };

test('PLAN 12: DeepSeek is a provider with its key page and the three fallback models', async () => {
  const { PROVIDERS, PROVIDER_IDS } = await import('../src/ui/ai');
  assert.deepEqual(PROVIDER_IDS, ['anthropic', 'openai', 'deepseek']);
  const d = PROVIDERS.deepseek;
  assert.equal(d.name, 'DeepSeek');
  assert.equal(d.keyUrl, 'https://platform.deepseek.com/api_keys');
  assert.deepEqual(d.models.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']);
  assert.ok(d.dataLine && /DeepSeek/.test(d.dataLine), 'a line saying where the data goes');
  // the first model is the one a new person gets: text only, so no picture can reach it unasked
  assert.equal(d.models[0].id, 'deepseek-v4-flash');
});

test('PLAN 12: only the vision model takes pictures; DeepSeek takes no PDF; the others are as before', async () => {
  const { capsOf } = await import('../src/ui/ai');
  assert.deepEqual(capsOf('deepseek', 'deepseek-v4-flash-vision-exp'), { pdf: false, images: true });
  assert.deepEqual(capsOf('deepseek', 'deepseek-v4-flash'), { pdf: false, images: false });
  assert.deepEqual(capsOf('deepseek', 'deepseek-v4-pro'), { pdf: false, images: false });
  assert.deepEqual(capsOf('deepseek', 'some-new-model'), { pdf: false, images: false }, 'an unknown model gets text only');
  assert.deepEqual(capsOf('anthropic', 'claude-sonnet-5-5'), { pdf: true, images: true });
  assert.deepEqual(capsOf('openai', 'gpt-6.1-sol'), { pdf: true, images: true });
});

test('PLAN 12: the notice names the model, the pages left out, and the model to choose', async () => {
  const { textOnlyNotice } = await import('../src/ui/ai');
  const one = textOnlyNotice('deepseek', 'deepseek-v4-flash', [4]);
  assert.match(one, /^deepseek-v4-flash reads text only, so only the text of the pages was sent\./);
  assert.match(one, /1 picture-only page \(drawings or scans\) was not sent: page 5\./);
  assert.match(one, /choose DeepSeek V4 Flash Vision in the model list/);
  const many = textOnlyNotice('deepseek', 'deepseek-v4-pro', [0, 1, 2]);
  assert.match(many, /3 picture-only pages .* were not sent: pages 1, 2, 3\./);
  const none = textOnlyNotice('deepseek', 'deepseek-v4-flash', []);
  assert.match(none, /Pictures in the pages were not sent\./);
  const long = textOnlyNotice('deepseek', 'deepseek-v4-flash', Array.from({ length: 30 }, (_, i) => i));
  assert.match(long, /pages 1, 2, .*, 20, …\./);
});

test('PLAN 12: the app text names no other PDF program (company names: the export scan); the settings line is Fable\'s', async () => {
  const { PROVIDERS } = await import('../src/ui/ai');
  const files = ['src/ui/ai.ts', 'src/ui/AiPanel.tsx', 'src/ui/Ribbon.tsx', 'src/ui/ToolSearch.tsx'].map((f) => readFileSync(f, 'utf8'));
  const text = files.join('\n');
  for (const w of ['Foxit', 'Acrobat', 'Bluebeam', 'Adobe']) assert.ok(!text.includes(w), w + ' in the app text');
  assert.ok(!text.includes('FABLE-TEXT'), 'no placeholder left');
  const line = PROVIDERS.deepseek.dataLine || '';
  for (const w of ["DeepSeek's servers", 'in China', 'their own key']) assert.ok(line.includes(w), w + ' in the settings line');
});
