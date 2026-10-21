import { editEntries } from './api';
import { entryKind } from './apiDecoders';
import { siblingEntries } from './entryTree';
import { preserveRecovery, readStored, storage } from './storage';
import { boolean, integer, nullable, object, positiveId, strings, text, type Decoder } from './validation';
import type { DocumentChange } from './entryChanges';
import type { EntryKind, OutlineItem } from './types';
import entryPolicy from '../shared/entry-policy.json';

export type Draft = {
  active: boolean; mode: 'new' | 'edit'; id: number | null; content: string; saved: string;
  kind: EntryKind; clientId: string; requestId: string; revision: number | null;
  parentId: number | null; afterId: number | null; beforeId?: number | null;
  placement: 'tail' | 'after'; hiddenTags: string[]; tags: string[]; savedTags: string[];
};
export function freshDraft(rows: OutlineItem[], active: boolean, kind: EntryKind, parentId: number | null = null, afterId?: number | null): Draft {
  return { tags: [], savedTags: [], hiddenTags: [], active, mode: 'new', id: null, content: '', saved: '',
    clientId: crypto.randomUUID(), requestId: crypto.randomUUID(), revision: null, parentId,
    placement: afterId === undefined ? 'tail' : 'after', kind,
    afterId: afterId === undefined ? siblingEntries(rows, parentId).at(-1)?.id ?? null : afterId };
}
export function hasDraftChanges(draft: Draft): boolean {
  return draft.content !== draft.saved || JSON.stringify(draft.tags) !== JSON.stringify(draft.savedTags);
}
const localId = (value: unknown): number => {
  const id = integer(value);
  if (id === 0) throw new Error('An entry ID cannot be zero.');
  return id;
};
const requestId = (value: unknown): string => {
  const id = text(value);
  if (!id || id.length > entryPolicy.max_client_id_length) throw new Error('Invalid saved request ID.');
  return id;
};
export function readDraft(key: string, fallback: Draft, entries: OutlineItem[] = []): Draft {
  return readStored(key, value => {
    const row = object(value);
    function field<T>(name: string, decode: Decoder<T>, defaultValue: T): T {
      if (row[name] === undefined) return defaultValue;
      try { return decode(row[name]); }
      catch (error) {
        const raw = storage.getItem(key);
        if (raw !== null) preserveRecovery(key, raw, error);
        return defaultValue;
      }
    }
    const id = field('id', value => nullable(value, localId), fallback.id);
    const saved = entries.find(entry => entry.id === id);
    return {
      active: field('active', boolean, fallback.active),
      mode: field('mode', value => { if (value === 'new' || value === 'edit') return value; throw new Error('Invalid draft mode.'); }, fallback.mode),
      id,
      content: field('content', text, fallback.content), saved: field('saved', text, fallback.saved),
      kind: field('kind', value => entryKind(value, saved?.kind ?? fallback.kind), saved?.kind ?? fallback.kind),
      clientId: field('clientId', requestId, fallback.clientId), requestId: field('requestId', requestId, fallback.requestId),
      revision: field('revision', value => nullable(value, positiveId), fallback.revision),
      parentId: field('parentId', value => nullable(value, localId), saved?.parent_id ?? fallback.parentId),
      afterId: field('afterId', value => nullable(value, localId), fallback.afterId),
      beforeId: field('beforeId', value => nullable(value, localId), fallback.beforeId ?? null),
      placement: field('placement', value => { if (value === 'tail' || value === 'after') return value; throw new Error('Invalid draft position.'); }, fallback.placement),
      hiddenTags: field('hiddenTags', strings, fallback.hiddenTags),
      tags: field('tags', strings, fallback.tags), savedTags: field('savedTags', strings, fallback.savedTags),
    };
  }, fallback);
}

let recovery: Promise<boolean> | null = null;
// Save drafts from earlier days even when their editors are no longer on screen.
export function recoverEarlierDrafts(today: string): Promise<boolean> {
  if (recovery) return recovery;
  recovery = (async () => {
    let changed = false;
    for (const key of storage.keys()) {
      if (!/^still-draft-\d{4}-\d{2}-\d{2}$/.test(key) || key === `still-draft-${today}`) continue;
      try {
        const draft = readDraft(key, freshDraft([], false, 'notes'));
        // The edit queue must resolve new entry IDs before this draft can be sent.
        if ([draft.id, draft.parentId, draft.afterId, draft.beforeId].some(id => id != null && id < 0)) continue;
        if (!hasDraftChanges(draft)) { storage.removeItem(key); continue; }
        storage.setItem(key, JSON.stringify(draft));
        let change: DocumentChange;
        if (!draft.content.trim() && !draft.tags.length) {
          if (draft.id === null) continue;
          change = { kind: draft.kind, id: draft.id, delete: true, expected_revision: draft.revision };
        } else if (draft.id === null) {
          change = { kind: draft.kind, content: draft.content, tags: draft.tags, date: key.slice('still-draft-'.length),
            client_id: draft.clientId, parent_id: draft.parentId, after_id: draft.afterId, before_id: draft.beforeId };
        } else {
          change = { kind: draft.kind, id: draft.id, content: draft.content, tags: draft.tags, expected_revision: draft.revision };
        }
        await editEntries([change], draft.requestId);
        changed = true;
        // An editor may have saved newer text while this request was running.
        if (storage.getItem(key) === JSON.stringify(draft)) storage.removeItem(key);
      } catch (error) { console.error('Could not recover an earlier draft. Its saved copy was kept.', key, error); }
    }
    return changed;
  })().finally(() => { recovery = null; });
  return recovery;
}
