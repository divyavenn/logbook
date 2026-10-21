import { domText, domTextOffset } from './textSelection';

export type EntryRange = { key: string; id: string; from: number; to: number; length: number; text: string; html: string };
export type SelectionEdit = {
  ranges: EntryRange[]; text: string; html: string; historyKey: ReturnType<typeof crypto.randomUUID>;
  focus?: () => void;
};

declare global {
  interface WindowEventMap {
    'still-replace-entry-selection': CustomEvent<SelectionEdit>;
  }
}

// Entries the selection covers from end to end, rather than partly. Selecting
// all of an entry's text selects the entry itself, the same as one entry does.
// This runs on every selection change, so it reads boundaries only and copies
// nothing.
export type EntryBounds = { key: string; id: string };
export function wholeSelectedEntries(): EntryBounds[] {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
  const range = selection.getRangeAt(0);
  const whole: EntryBounds[] = [];
  const probe = document.createRange();
  for (const item of document.querySelectorAll<HTMLElement>('li[data-outline-key][data-item-id]')) {
    if (item.offsetParent === null || item.closest('[aria-hidden="true"]')) continue;
    const content = item.querySelector<HTMLElement>(':scope > div > [role="group"], :scope > div [contenteditable="true"]');
    if (!content || content.closest('li') !== item || !content.textContent?.length) continue;
    // Boundary comparison only: copying the contents to measure them would
    // disturb the editor holding the selection being measured.
    probe.selectNodeContents(content);
    if (range.compareBoundaryPoints(Range.START_TO_START, probe) > 0) continue;
    if (range.compareBoundaryPoints(Range.END_TO_END, probe) < 0) continue;
    whole.push({ key: item.dataset.outlineKey!, id: item.dataset.itemId! });
  }
  return whole.length >= 2 ? whole : [];
}

// One listener and one pass for every outline on the page: each only has to
// pick out its own rows.
const watchers = new Set<(ranges: EntryBounds[]) => void>();
let scheduled: ReturnType<typeof setTimeout> | null = null;
const publishSelection = () => {
  scheduled = null;
  const whole = wholeSelectedEntries();
  for (const watcher of watchers) watcher(whole);
};
const scheduleSelection = () => {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(publishSelection, 100);
};
export function watchWholeSelection(watcher: (ranges: EntryBounds[]) => void): () => void {
  if (!watchers.size) document.addEventListener('selectionchange', scheduleSelection);
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
    if (!watchers.size) {
      document.removeEventListener('selectionchange', scheduleSelection);
      if (scheduled) { clearTimeout(scheduled); scheduled = null; }
    }
  };
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
    entries.push({ key: item.dataset.outlineKey!, id: item.dataset.itemId!, from, to, length: text.length, text: text.slice(from, to), html: fragment.innerHTML });
  }
  return entries;
}

export function replaceEntrySelection(ranges: EntryRange[], text = '', html = '') {
  const detail: SelectionEdit = { ranges, text, html, historyKey: crypto.randomUUID() };
  window.dispatchEvent(new CustomEvent('still-replace-entry-selection', { detail }));
  window.getSelection()?.removeAllRanges();
  detail.focus?.();
}
