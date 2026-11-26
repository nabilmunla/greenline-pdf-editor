// The menu a text box shows on right-click: spelling suggestions for a misspelled word, "Add to
// dictionary", then Cut / Copy / Paste / Select all. Pure: it takes what Electron's `context-menu`
// event gives (`params`) and two actions, and returns a menu template (or null where no menu is
// wanted). main.cjs pops it up as a native menu - a menu drawn in the page would take the keyboard
// from the text box, and the boxes finish typing when they lose it.

const MAX_SUGGESTIONS = 5;

/**
 * @param {{ isEditable?: boolean, selectionText?: string, misspelledWord?: string, dictionarySuggestions?: string[],
 *           editFlags?: { canCut?: boolean, canCopy?: boolean, canPaste?: boolean, canSelectAll?: boolean } }} params
 * @param {{ replace: (word: string) => void, addWord: (word: string) => void }} act
 * @returns {Array<Record<string, unknown>> | null}
 */
function spellMenu(params, act) {
  if (!params) return null;
  // (text selected where it can't be typed in - a label, a panel, a message: Copy alone. The page
  // itself never asks: the viewer keeps its own right-click menus - 14.4)
  if (!params.isEditable) return params.selectionText && String(params.selectionText).trim() ? [{ label: 'Copy', role: 'copy' }] : null;
  const flags = params.editFlags || {};
  const items = [];
  const word = params.misspelledWord || '';
  if (word) {
    const list = (params.dictionarySuggestions || []).filter((s) => typeof s === 'string' && s).slice(0, MAX_SUGGESTIONS);
    if (list.length) for (const s of list) items.push({ label: s, click: () => act.replace(s) });
    else items.push({ label: 'No suggestions', enabled: false });
    items.push({ label: 'Add to dictionary', click: () => act.addWord(word) });
    items.push({ type: 'separator' });
  }
  items.push({ label: 'Cut', role: 'cut', enabled: !!flags.canCut });
  items.push({ label: 'Copy', role: 'copy', enabled: !!flags.canCopy });
  items.push({ label: 'Paste', role: 'paste', enabled: !!flags.canPaste });
  items.push({ label: 'Select all', role: 'selectAll', enabled: !!flags.canSelectAll });
  return items;
}

/** the menu's labels in order, a separator as '-' (what the tests read back) */
const labelsOf = (template) => template.map((i) => (i.type === 'separator' ? '-' : String(i.label)));

module.exports = { spellMenu, labelsOf, MAX_SUGGESTIONS };
