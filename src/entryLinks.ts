import type { EntryKind } from './types';

// A link to one entry. It lives in the fragment, so it never leaves the page
// it names: no server has to know the shape of it, and it survives a reload
// with no network. The signature comes from the server with the entry, and is
// what lets whoever holds the link read that entry without the password.
const ENTRY_LINK = /^(?:[^#]*)#e\/(notes|tasks)\/([0-9]+)\/([0-9a-f]{16})$/;
// The same address found in the middle of written text, to know which entries
// a page's links point at.
export const ENTRY_LINK_PATTERN = /\bhttps?:\/\/\S*#e\/(?:notes|tasks)\/[0-9]+\/[0-9a-f]{16}\b/gu;
export type EntryLink = { kind: EntryKind; id: number; signature: string };
// Dispatched on window when a link inside an entry is followed, so the page
// can go there itself instead of opening a second copy of the journal.
export const ENTRY_LINK_EVENT = 'still-entry-link';

export function parseEntryLink(value: string): EntryLink | null {
  const match = ENTRY_LINK.exec(value.trim());
  if (!match) return null;
  return { kind: match[1] as EntryKind, id: Number(match[2]), signature: match[3] };
}

export function entryLinkPath(link: EntryLink): string {
  return `#e/${link.kind}/${link.id}/${link.signature}`;
}

// The whole address, because the point of copying one is to send it.
export function entryLinkUrl(link: EntryLink): string {
  return new URL(entryLinkPath(link), window.location.origin).href;
}

// What a bare link reads as: a glimpse of the entry it points at. A few words
// only, and the pill they sit in fades their tail, which says there is more
// there without spelling out that it has been cut.
const LABEL_WORDS = 4;
export function entryLinkLabel(content: string): string {
  const words = content.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return 'entry';
  return words.slice(0, LABEL_WORDS).join(' ');
}

declare global {
  interface WindowEventMap {
    [ENTRY_LINK_EVENT]: CustomEvent<{ kind: EntryKind; id: number }>;
  }
}
