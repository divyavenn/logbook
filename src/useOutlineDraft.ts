import { useCallback, useEffect, useRef, useState } from 'react';
import { registerDraftFlush } from './JournalContext';
import { freshDraft as fresh, hasDraftChanges, readDraft, type Draft } from './entryDrafts';
import { siblingEntries as siblings } from './entryTree';
import { storage } from './storage';
import type { OutlineDocument } from './outlineDocument';
import type { OutlineChange } from './entryChanges';
import type { EntryKind, OutlineItem } from './types';

type DraftContext = {
  key: string; documentStore: OutlineDocument; items: OutlineItem[]; defaultKind: EntryKind;
  composer: boolean; day?: string; activeTag: string | null;
};

export function useOutlineDraft({ key, documentStore, items, defaultKind, composer, day, activeTag }: DraftContext) {
  const mounted = useRef(true);
  const blank = (rows: OutlineItem[], active: boolean, parentId: number | null = null, afterId?: number | null, draftKind: EntryKind = defaultKind): Draft =>
    ({ ...fresh(rows, active, draftKind, parentId, afterId), hiddenTags: activeTag ? [activeTag] : [] });
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const stored = readDraft(key, blank(items, composer), items);
      if (hasDraftChanges(stored) || documentStore.hasPending(stored.id)) {
        stored.id = documentStore.resolve(stored.id ?? null);
        stored.parentId = documentStore.resolve(stored.parentId ?? null);
        stored.afterId = documentStore.resolve(stored.afterId ?? null);
        stored.beforeId = documentStore.resolve(stored.beforeId ?? null);
        const row = items.find(item => item.id === stored.id);
        return { ...stored, revision: stored.revision ?? row?.revision ?? null, active: true };
      }
      for (const row of items) {
        const rowKind = row.kind;
        const edit = storage.getItem(`still-edit-${rowKind}-${row.id}`);
        if (edit !== null) return { ...blank(items, true), kind: rowKind, mode: 'edit', id: row.id, revision: row.revision, content: edit, saved: row.content, parentId: row.parent_id };
      }
      const oldTask = defaultKind === 'tasks' ? storage.getItem('still-task-draft') : null;
      if (oldTask) return { ...blank(items, true), content: oldTask };
    } catch { /* Keep the journal usable if old local draft metadata is malformed. */ }
    return blank(items, composer);
  });
  const current = useRef(draft);
  const records = useRef(items);
  records.current = items;
  const [saving, setSaving] = useState(false);
  const previouslyComposer = useRef(composer);
  const persist = useCallback((next: Draft) => {
    current.current = next;
    if (next.active) storage.setItem(key, JSON.stringify(next));
    else storage.removeItem(key);
    if (mounted.current) setDraft(next);
  }, [key]);
  useEffect(() => {
    const value = current.current;
    if (defaultKind !== 'tasks' || !composer || !value.active || value.mode !== 'new' || value.placement !== 'tail' ||
        value.id !== null || value.parentId !== null || value.content.trim() || value.tags.length) return;
    const afterId = siblings(items, null).at(-1)?.id ?? null;
    if (value.afterId !== afterId) persist({ ...value, afterId });
  }, [items, defaultKind, composer, persist]);
  const stageDraft = useCallback((historyKey?: string) => {
    const value = current.current;
    if (!value.active || !hasDraftChanges(value)) return value.id;
    if (!value.content.trim() && !value.tags.length) {
      // Emptying an entry while filtering drops the tag that listed it, and
      // only removes the entry when no other tag keeps it.
      const remaining = activeTag ? value.savedTags.filter(tag => tag !== activeTag) : [];
      if (value.id !== null) documentStore.enqueue([remaining.length
        ? { kind: value.kind, id: value.id, type: 'update', content: '', tags: remaining, allow_empty: true }
        : { kind: value.kind, id: value.id, type: 'delete' }], historyKey ?? value.clientId);
      persist({ ...value, id: null, revision: null, saved: '', savedTags: [] });
      return null;
    }
    const id = value.id ?? documentStore.allocate();
    const content = { id, kind: value.kind, content: value.content, tags: value.tags };
    const change: OutlineChange = value.id === null
      ? { ...content, type: 'create', date: day, client_id: value.clientId, parent_id: value.parentId, after_id: value.afterId, before_id: value.beforeId }
      : { ...content, type: 'update' };
    documentStore.enqueue([change], historyKey ?? value.clientId);
    persist({ ...value, id, saved: value.content, savedTags: value.tags });
    return id;
  }, [activeTag, day, documentStore, persist]);
  const save = useCallback(() => {
    const id = stageDraft();
    if (mounted.current) setSaving(true);
    return documentStore.flush().then(() => documentStore.resolve(id)).finally(() => { if (mounted.current) setSaving(false); });
  }, [documentStore, stageDraft]);
  useEffect(() => {
    const retry = () => { void documentStore.flush().catch(() => {}); };
    retry();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [documentStore]);

  useEffect(() => registerDraftFlush(save), [save]);
  useEffect(() => {
    if (draft.kind !== 'notes' || !draft.active || draft.mode === 'edit') return;
    const timeout = setTimeout(() => { void save().catch(() => {}); }, 700);
    return () => clearTimeout(timeout);
  }, [draft.content, draft.tags, draft.active, draft.mode, draft.kind, save]);
  useEffect(() => {
    if (!composer) {
      const value = current.current;
      const emptyNewDraft = value.active && value.mode === 'new' && value.id === null && !value.content.trim() && !value.tags.length;
      if (emptyNewDraft) {
        persist({ ...value, active: false });
      } else if (previouslyComposer.current && defaultKind === 'notes') {
        setDraft(previous => ({ ...previous, active: false }));
        void save().then(() => persist(blank(records.current, false))).catch(() => {
          current.current = { ...current.current, active: false };
          setDraft(current.current);
          // Keep the unsaved local copy for the earlier-day recovery worker.
        });
      }
    }
    previouslyComposer.current = composer;
  }, [composer, defaultKind, persist, save]);
  useEffect(() => {
    mounted.current = true;
    const flush = () => { void save().catch(() => {}); };
    window.addEventListener('pagehide', flush);
    return () => { mounted.current = false; window.removeEventListener('pagehide', flush); flush(); };
  }, [save]);
  return { blank, draft, current, records, persist, stageDraft, save, saving };
}
