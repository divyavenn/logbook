import { useEffect, useRef } from 'react';
import { replaceEntrySelection, selectedEntryRanges, type EntryRange, type SelectionEdit } from './entrySelection';

export function useRangeEditing(key: string, wholeListSelected: () => boolean, replace: (edit: SelectionEdit) => void,
  copy?: (clipboard: DataTransfer, ranges: EntryRange[]) => boolean): void {
  const current = useRef({ wholeListSelected, replace, copy });
  current.current = { wholeListSelected, replace, copy };
  useEffect(() => {
    const apply = (event: CustomEvent<SelectionEdit>) => current.current.replace(event.detail);
    const ownedSelection = (event: Event) => {
      if (current.current.wholeListSelected() || event.defaultPrevented) return [];
      const ranges = selectedEntryRanges();
      return ranges.length >= 2 && ranges[0].key === key ? ranges : [];
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const deleting = event.key === 'Backspace' || event.key === 'Delete';
      const typing = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (!deleting && !typing) return;
      const ranges = ownedSelection(event);
      if (!ranges.length) return;
      event.preventDefault(); event.stopPropagation();
      replaceEntrySelection(ranges, typing ? event.key : '');
    };
    const beforeinput = (event: Event) => {
      if (!(event instanceof InputEvent) || event.isComposing) return;
      if (!['deleteContentBackward', 'deleteContentForward', 'insertText'].includes(event.inputType)) return;
      const ranges = ownedSelection(event);
      if (!ranges.length) return;
      event.preventDefault(); event.stopPropagation();
      replaceEntrySelection(ranges, event.inputType === 'insertText' ? event.data ?? '' : '');
    };
    const clipboard = (event: ClipboardEvent) => {
      const ranges = ownedSelection(event);
      if (!ranges.length || !event.clipboardData) return;
      event.preventDefault(); event.stopPropagation();
      if (event.type === 'paste') {
        replaceEntrySelection(ranges, event.clipboardData.getData('text/plain'), event.clipboardData.getData('text/html'));
        return;
      }
      // Whole entries copy as themselves; a part of them copies as its text.
      if (!current.current.copy?.(event.clipboardData, ranges)) {
        event.clipboardData.setData('text/plain', ranges.map(range => range.text).join('\n'));
        event.clipboardData.setData('text/html', ranges.map(range => range.html).join(''));
      }
      if (event.type === 'cut') replaceEntrySelection(ranges);
    };
    window.addEventListener('still-replace-entry-selection', apply);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('beforeinput', beforeinput, true);
    const clipboardEvents = ['copy', 'cut', 'paste'] as const;
    for (const type of clipboardEvents) document.addEventListener(type, clipboard, true);
    return () => {
      window.removeEventListener('still-replace-entry-selection', apply);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('beforeinput', beforeinput, true);
      for (const type of clipboardEvents) document.removeEventListener(type, clipboard, true);
    };
  }, [key]);
}
