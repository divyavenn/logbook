import { domText, domTextOffset } from './textSelection';

export type EntryRange = { key: string; id: string; from: number; to: number; text: string; html: string };
export type SelectionEdit = {
  ranges: EntryRange[]; text: string; html: string; historyKey: ReturnType<typeof crypto.randomUUID>;
  focus?: () => void;
};

declare global {
  interface WindowEventMap {
    'still-replace-entry-selection': CustomEvent<SelectionEdit>;
  }
}

// Capture every boundary before any outline changes its DOM. Different dates
// remain separate outlines, but participate in the same selection gesture.
export function selectedEntryRanges(): EntryRange[] {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
  const range = selection.getRangeAt(0);
  const entries: EntryRange[] = [];
  for (const item of document.querySelectorAll<HTMLElement>('li[data-outline-key][data-item-id]')) {
    if (item.offsetParent === null || item.closest('[aria-hidden="true"]')) continue;
    const content = item.querySelector<HTMLElement>(':scope > div > [role="group"], :scope > div [contenteditable="true"]');
    if (!content || content.closest('li') !== item || !range.intersectsNode(content)) continue;
    const text = domText(content);
    const from = content.contains(range.startContainer) ? domTextOffset(content, range.startContainer, range.startOffset) : 0;
    const to = content.contains(range.endContainer) ? domTextOffset(content, range.endContainer, range.endOffset) : text.length;
    const selected = document.createRange();
    selected.selectNodeContents(content);
    if (content.contains(range.startContainer)) selected.setStart(range.startContainer, range.startOffset);
    if (content.contains(range.endContainer)) selected.setEnd(range.endContainer, range.endOffset);
    const fragment = document.createElement('div');
    fragment.append(selected.cloneContents());
    entries.push({ key: item.dataset.outlineKey!, id: item.dataset.itemId!, from, to, text: text.slice(from, to), html: fragment.innerHTML });
  }
  return entries;
}

// Entries a selection of the written page spans. A selection anchored inside
// an open entry belongs to that editor, which keeps it to itself.
export function spannedEntries(key: string): EntryRange[] {
  const ranges = selectedEntryRanges();
  if (ranges.length < 2 || ranges[0].key !== key) return [];
  const native = window.getSelection();
  const anchored = native && [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')]
    .some(editor => editor.contains(native.anchorNode) || editor.contains(native.focusNode));
  return anchored ? [] : ranges;
}

export function replaceEntrySelection(ranges: EntryRange[], text = '', html = '') {
  const detail: SelectionEdit = { ranges, text, html, historyKey: crypto.randomUUID() };
  window.dispatchEvent(new CustomEvent('still-replace-entry-selection', { detail }));
  window.getSelection()?.removeAllRanges();
  detail.focus?.();
}
