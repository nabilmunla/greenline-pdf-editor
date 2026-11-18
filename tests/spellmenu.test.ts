// PLAN 8.2: the right-click menu of a text box - spelling suggestions, Add to dictionary, then Cut /
// Copy / Paste / Select all (electron/spellmenu.cjs; main pops it up as a native menu)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { spellMenu, labelsOf } = createRequire(import.meta.url)('../electron/spellmenu.cjs') as {
  spellMenu: (p: unknown, a: { replace: (w: string) => void; addWord: (w: string) => void }) => Array<{ label?: string; type?: string; role?: string; enabled?: boolean; click?: () => void }> | null;
  labelsOf: (t: unknown[]) => string[];
};

const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const fake = () => {
  const calls: string[] = [];
  return { calls, act: { replace: (w: string) => calls.push('replace:' + w), addWord: (w: string) => calls.push('add:' + w) } };
};
const EDIT = ['Cut', 'Copy', 'Paste', 'Select all'];

test('a misspelled word: 5 suggestions, Add to dictionary, a separator, the four edit items', () => {
  const { act } = fake();
  const t = spellMenu({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech', 'tea', 'ten', 'tee', 'tel', 'tew'], editFlags: flags }, act)!;
  assert.deepEqual(labelsOf(t), ['the', 'tech', 'tea', 'ten', 'tee', 'Add to dictionary', '-', ...EDIT]);
  assert.deepEqual(t.slice(-4).map((i) => i.role), ['cut', 'copy', 'paste', 'selectAll']);
});

test('clicking a suggestion replaces the word; Add to dictionary adds it', () => {
  const { calls, act } = fake();
  const t = spellMenu({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], editFlags: flags }, act)!;
  t[0].click!();
  assert.deepEqual(calls, ['replace:the']);
  t[2].click!();
  assert.deepEqual(calls, ['replace:the', 'add:teh']);
  assert.equal(t[2].label, 'Add to dictionary');
});

test('no word: the edit items only', () => {
  const t = spellMenu({ isEditable: true, misspelledWord: '', dictionarySuggestions: [], editFlags: flags }, fake().act)!;
  assert.deepEqual(labelsOf(t), EDIT);
});

test('a misspelled word with no suggestions: a greyed "No suggestions", then the rest', () => {
  const t = spellMenu({ isEditable: true, misspelledWord: 'qwzx', dictionarySuggestions: [], editFlags: flags }, fake().act)!;
  assert.deepEqual(labelsOf(t), ['No suggestions', 'Add to dictionary', '-', ...EDIT]);
  assert.equal(t[0].enabled, false);
  assert.equal(t[0].click, undefined);
  assert.notEqual(t[1].enabled, false);
});

test('not editable: no menu at all', () => {
  assert.equal(spellMenu({ isEditable: false, misspelledWord: 'teh', dictionarySuggestions: ['the'], editFlags: flags }, fake().act), null);
  assert.equal(spellMenu({}, fake().act), null);
});

test('the edit items follow the edit flags (nothing to paste: Paste greyed)', () => {
  const t = spellMenu({ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true } }, fake().act)!;
  assert.deepEqual(t.map((i) => i.enabled), [false, false, false, true]);
  const u = spellMenu({ isEditable: true, editFlags: flags }, fake().act)!;
  assert.deepEqual(u.map((i) => i.enabled), [true, true, true, true]);
  const v = spellMenu({ isEditable: true }, fake().act)!; // no flags given: all greyed, never throws
  assert.deepEqual(v.map((i) => i.enabled), [false, false, false, false]);
});
