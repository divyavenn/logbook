import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import styled, { keyframes, css } from 'styled-components';
import { useJournalContext, registerDraftFlush } from '../JournalContext';
import { api } from '../api';
import type { EntryKind, OutlineItem } from '../types';
import { VisuallyHidden } from '../styles';
import { MarkdownContent, markdownText, richTextStyles, mergeMarkdown, formatMarkdown, pastedBullet } from '../markdown';
import { RichTextEditor, type RichTextHandle, type TextOffsets, type VerticalDirection } from './RichTextEditor';
import { documentUndo, editDocument, historyShortcutDirection, recordEdit } from '../documentHistory';
import { compactViewport } from '../layout';
import { haptic } from '../haptics';
import { OutlineDocument } from '../outlineDocument';
import { entryError } from '../entryFeedback';

const MAX_LEVELS = 8;
const ENTRY_HOLD_MS = 360;
const ENTRY_MOVE_THRESHOLD = 48;
const OutlineSurface = styled.div`
  position: relative; outline: none;
  --bullet-size: 15px;
  --bullet-row-height: 28px;
  --bullet-padding: 4px 0;
  --bullet-line-height: 1.2;
  --bullet-paragraph-gap: .2em;
  --bullet-marker-offset: .5px;
  @media(pointer: coarse) { --bullet-size: 16px; --bullet-row-height: 44px; --bullet-padding: 10px 0; --bullet-line-height: 1.35; }
  @media ${compactViewport} { --bullet-row-height: 36px; --bullet-padding: 6px 0; --bullet-line-height: 1.3; --bullet-paragraph-gap: .1em; }
`;
const List = styled.ul`list-style: none; padding: 0; margin: 0;`;
const Children = styled(List)<{ $task: boolean }>`
  padding-left: ${({ $task }) => $task ? '28px' : '32px'};
  @media(max-width: 900px) { padding-left: ${({ $task }) => $task ? '20px' : '24px'}; }
  @media(max-width: 440px) { padding-left: 12px; }
  @media ${compactViewport} { padding-left: 9px; }
`;
const popOut = keyframes`0% { opacity: 1; transform: scale(1); } 40% { opacity: .8; transform: scale(1.012); } 100% { opacity: 0; transform: translateY(-3px) scale(.985); }`;
const slideIn = keyframes`from { opacity: 0; transform: translateY(-7px); } to { opacity: 1; transform: translateY(0); }`;
const Row = styled.div`position: relative; display: flex; align-items: flex-start; min-height: var(--bullet-row-height);`;
const Item = styled.li<{ $leaving?: boolean; $arriving?: boolean; $gestureSelected?: boolean; $dragX?: number }>`
  min-width: 0; transform-origin: left center; translate: ${({ $dragX = 0 }) => $dragX ? `${$dragX}px 0` : 'none'};
  ${({ $leaving }) => $leaving && css`animation: ${popOut} 180ms ease-out both; pointer-events: none;`}
  ${({ $arriving }) => $arriving && css`animation: ${slideIn} 280ms cubic-bezier(.2,.7,.3,1) both;`}
  > ${Row} { transition: background-color 120ms ease-out; }
  &[data-drop-position="before"] > ${Row} { box-shadow: 0 -2px 0 var(--link); }
  &[data-drop-position="after"] > ${Row} { box-shadow: 0 2px 0 var(--link); }
  ${({ $gestureSelected }) => $gestureSelected && css`
    user-select: none; -webkit-user-select: none;
    > ${Row} { background: color-mix(in srgb, var(--link) 10%, transparent); border-radius: 6px; }
  `}
  @media(pointer: coarse) { touch-action: pan-y; }
`;
const Branch = styled.div<{ $open: boolean; $editing: boolean }>`
  display: grid; min-height: 0;
  grid-template-rows: ${({ $open }) => $open ? '1fr' : '0fr'};
  opacity: ${({ $open }) => $open ? 1 : 0};
  transform: translateY(${({ $open }) => $open ? '0' : '-3px'});
  visibility: ${({ $open }) => $open ? 'visible' : 'hidden'};
  pointer-events: ${({ $open }) => $open ? 'auto' : 'none'};
  transition-property: grid-template-rows, opacity, transform, visibility;
  transition-duration: 320ms, 240ms, 320ms, 0s;
  transition-timing-function: cubic-bezier(.2, 0, 0, 1);
  transition-delay: ${({ $open }) => $open ? '0s' : '0s, 60ms, 0s, 320ms'};

  > ${Children} { min-height: 0; overflow: hidden; }
  > ${Children} > ${Item} > ${Row} {
    opacity: ${({ $open }) => $open ? 1 : 0};
    transform: translateY(${({ $open }) => $open ? '0' : '-3px'});
    transition-property: opacity, transform;
    transition-duration: 220ms, 280ms;
    transition-timing-function: ease-out;
  }
  ${({ $open }) => $open && css`
    > ${Children} > ${Item}:nth-child(2) > ${Row} { transition-delay: 35ms; }
    > ${Children} > ${Item}:nth-child(3) > ${Row} { transition-delay: 70ms; }
    > ${Children} > ${Item}:nth-child(4) > ${Row} { transition-delay: 105ms; }
    > ${Children} > ${Item}:nth-child(n + 5) > ${Row} { transition-delay: 140ms; }
  `}
  ${({ $editing }) => $editing && css`
    transition: none;
    > ${Children} > ${Item} > ${Row} { transition: none; }
  `}

  @media (prefers-reduced-motion: reduce) {
    transition: none;
    > ${Children} > ${Item} > ${Row} { transition: none; }
  }
`;
const ComposerTarget = styled.button<{ $floating: boolean }>`
  display: block; width: 100%; min-height: var(--bullet-row-height); padding: 0; border: 0; background: transparent;
  ${({ $floating }) => $floating && 'position: absolute; top: 100%; height: 20px; min-height: 20px;'}
  @media(pointer: coarse) { min-height: 44px; }
  @media ${compactViewport} { min-height: 36px; }
`;
const Marker = styled.span<{ $task: boolean }>`
  display: flex; width: 40px; min-width: 40px; height: var(--bullet-row-height); align-items: center; justify-content: center; color: var(--ink);
  &::before { content: ${({ $task }) => $task ? "''" : "'–'"}; font-size: 14px; translate: 0 var(--bullet-marker-offset);
    ${({ $task }) => $task ? 'width: 12px; height: 12px; border: 1.25px solid currentColor; border-radius: 50%;' : ''} }
  @media(pointer: coarse) { width: 44px; min-width: 44px; height: 44px; }
  @media ${compactViewport} { width: 36px; min-width: 36px; height: 36px; }
`;
const DraftItem = styled(Item)<{ $emptyTask: boolean }>`
  ${({ $emptyTask }) => $emptyTask && css`
    > ${Row} > ${Marker} { visibility: hidden; }
    &:focus-within > ${Row} > ${Marker} { visibility: visible; }
  `}
`;
const Checkbox = styled.button<{ $checked?: boolean; $suppressPreview?: boolean }>`
  position: relative; display: flex; align-items: center; justify-content: center; width: 40px; min-width: 40px; height: var(--bullet-row-height);
  border: 0; padding: 0; background: transparent; border-radius: 50%; color: var(--ink);
  transition: transform 120ms ease-out; &:active { transform: scale(0.96); }
  &::before { content: ''; width: 12px; height: 12px; border: 1.25px solid currentColor; border-radius: 50%; translate: 0 var(--bullet-marker-offset); transition-property: background-color, border-color; transition-duration: 120ms; transition-timing-function: ease-out; }
  &::after { content: ''; position: absolute; width: 7px; height: 7px; background: currentColor;
    mask: url('/icons/check-flaticon.svg') center / contain no-repeat;
    -webkit-mask: url('/icons/check-flaticon.svg') center / contain no-repeat;
    opacity: ${({ $checked }) => $checked ? 1 : 0}; scale: ${({ $checked }) => $checked ? 1 : .25}; translate: 0 var(--bullet-marker-offset);
    filter: blur(${({ $checked }) => $checked ? 0 : 4}px);
    transition-property: opacity, scale, filter; transition-duration: 150ms; transition-timing-function: cubic-bezier(.2, 0, 0, 1); }
  @media (hover: hover) {
    ${({ $checked, $suppressPreview }) => !$suppressPreview && css`
      &:hover::before { background: transparent; border-color: var(--link); }
      &:hover::after { opacity: ${$checked ? 0 : 1}; scale: ${$checked ? .25 : 1};
        filter: blur(${$checked ? 4 : 0}px); background: var(--link); }
    `}
  }
  @media(pointer: coarse) { width: 44px; min-width: 44px; height: 44px; }
  @media ${compactViewport} { width: 36px; min-width: 36px; height: 36px; }
`;
const Disclosure = styled.button<{ $open: boolean; $pie: boolean; $done: boolean; $progress: number }>`
  position: relative; width: 40px; min-width: 40px; height: var(--bullet-row-height); padding: 0; border: 0;
  display: grid; place-items: center; background: transparent; border-radius: 4px; color: ${({ $pie, $done }) => $pie && !$done ? 'var(--ink)' : 'var(--muted)'};
  &::before { content: ''; width: 5px; height: 5px; border-right: 1.25px solid currentColor; border-bottom: 1.25px solid currentColor; translate: 0 var(--bullet-marker-offset);
    transform: rotate(${({ $open }) => $open ? '45deg' : '-45deg'}); transition: transform 140ms ease-out; }
  ${({ $pie, $progress }) => $pie && css`
    &::before { --task-progress: ${$progress * 360}deg; width: 12px; height: 12px; border: 1px solid currentColor; border-radius: 50%; transform: none;
      background: conic-gradient(currentColor var(--task-progress), transparent 0); transition: --task-progress 240ms ease-out; }
  `}
  @media(pointer: coarse) { width: 44px; min-width: 44px; height: 44px;
  }
  @media ${compactViewport} { width: 36px; min-width: 36px; height: 36px; }
`;
const Text = styled.div<{ $done?: boolean; $action?: boolean }>`
  ${richTextStyles}; cursor: text;
  flex: ${({ $action }) => $action ? '0 1 auto' : '1'}; min-width: 0; min-height: var(--bullet-row-height); padding: var(--bullet-padding); border: 0; background: transparent; color: var(--ink);
  ${({ $done }) => $done && css`color: var(--muted); text-decoration: line-through; a { color: var(--muted); }`}
  text-align: left; line-height: var(--bullet-line-height); font-size: var(--bullet-size); white-space: pre-wrap; overflow-wrap: anywhere;
  &:focus-visible { outline: none; }
`;
type Draft = {
  active: boolean; mode: 'new' | 'edit'; id: number | null; content: string; saved: string;
  kind: EntryKind;
  clientId: ReturnType<typeof crypto.randomUUID>; requestId: ReturnType<typeof crypto.randomUUID>; revision: number | null;
  parentId: number | null; afterId: number | null; beforeId?: number | null; placement: 'tail' | 'after'; hiddenTag: string | null; tags: string[]; savedTags: string[];
};
type VerticalTarget = { x: number; direction: VerticalDirection };
type EntrySelection = { key: string; dragX: number };
type EntryGesture = {
  pointerId: number; key: string; element: HTMLElement; x: number; y: number; pager: HTMLElement | null; pagerLeft: number;
  armed: boolean; paging: boolean; cancelled: boolean; timer: ReturnType<typeof setTimeout> | null;
};
type Props = {
  kind: EntryKind | 'mixed'; items: OutlineItem[]; day?: string; composer?: boolean;
  archived?: boolean; scope?: string;
  refresh: () => Promise<void>; notify: (message: string) => void;
};
function selectedTextOffsets(element?: HTMLElement, link?: HTMLElement): TextOffsets | undefined {
  if (element && link) {
    const range = document.createRange();
    range.selectNodeContents(element); range.setEndBefore(link);
    const anchor = range.toString().length;
    return { anchor, head: anchor + (link.textContent?.length ?? 0) };
  }
  const selection = window.getSelection();
  if (!element || !selection?.anchorNode || !selection.focusNode ||
      !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  const anchor = range.toString().length;
  range.setEnd(selection.focusNode, selection.focusOffset);
  return { anchor, head: range.toString().length };
}

const sorted = (items: OutlineItem[]) => [...items].sort((a, b) => a.position - b.position || a.id - b.id);
const siblings = (items: OutlineItem[], parentId: number | null) => sorted(items.filter(item => item.parent_id === parentId));
const fresh = (items: OutlineItem[], active: boolean, kind: EntryKind, parentId: number | null = null, afterId?: number | null): Draft => ({
  tags: [], savedTags: [], hiddenTag: null, active, mode: 'new', id: null, content: '', saved: '',
  clientId: crypto.randomUUID(), requestId: crypto.randomUUID(), revision: null, parentId,
  placement: afterId === undefined ? 'tail' : 'after',
  kind,
  afterId: afterId === undefined ? siblings(items, parentId).at(-1)?.id ?? null : afterId,
});

export function Outline({ kind, items: serverItems, day, composer = false, archived = false, scope, refresh }: Props) {
  const defaultKind: EntryKind = kind === 'mixed' ? 'notes' : kind;
  const key = scope ? `still-outline-${kind}-${scope}` : kind === 'tasks' ? 'still-outline-tasks' : `still-draft-${day}`;
  const [documentStore] = useState(() => new OutlineDocument(key));
  const [, renderDocument] = useState(0);
  const items = documentStore.rebase(serverItems);
  const entryKind = (row: OutlineItem): EntryKind => {
    const value = row.kind as string | undefined;
    return value === 'task' || value === 'tasks' ? 'tasks' : value === 'note' || value === 'notes' ? 'notes' : defaultKind;
  };
  const { activeTag, completed, onComplete, reopened, onReopen, target } = useJournalContext();
  const blank = (rows: OutlineItem[], active: boolean, parentId: number | null = null, afterId?: number | null, draftKind: EntryKind = defaultKind): Draft =>
    ({ ...fresh(rows, active, draftKind, parentId, afterId), hiddenTag: activeTag });
  const [expanded, setExpanded] = useState(new Set<number>());
  const [previewed, setPreviewed] = useState(new Set<number>());
  const seenCompleted = useRef(new Set<number>());
  const [collapsed, setCollapsed] = useState(() => {
    const initial = new Set(archived ? items.filter(row => entryKind(row) === 'tasks' && !!row.completed_at).map(row => row.id) : []);
    seenCompleted.current = new Set(initial);
    return initial;
  });
  const [completing, setCompleting] = useState<number | null>(null);
  const [removed, setRemoved] = useState(new Set<number>());
  const [suppressedPreviews, setSuppressedPreviews] = useState(new Set<number>());
  const previewSuppressedAt = useRef(new Map<number, number>());
  const entryGesture = useRef<EntryGesture | null>(null);
  const [entrySelection, setEntrySelection] = useState<EntrySelection | null>(null);
  const entrySelectionRef = useRef<EntrySelection | null>(null);
  const updateEntrySelection = (next: EntrySelection | null) => {
    entrySelectionRef.current = next;
    setEntrySelection(next);
  };
  const suppressClick = useRef(false);
  const draggedEntry = useRef<number | null>(null);
  const dropTarget = useRef<HTMLElement | null>(null);
  const [, setSelectedAll] = useState(false);
  const selectionActive = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const completedIds = new Set(archived ? items.filter(row => entryKind(row) === 'tasks' && !!row.completed_at).map(row => row.id) : []);
    const newlyCompleted = [...completedIds].filter(id => !seenCompleted.current.has(id));
    seenCompleted.current = completedIds;
    setCollapsed(previous => {
      const next = new Set([...previous].filter(id => completedIds.has(id)));
      newlyCompleted.forEach(id => next.add(id));
      return next.size === previous.size && [...next].every(id => previous.has(id)) ? previous : next;
    });
  }, [items, archived]);
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Draft> | null;
      if (stored && (stored.content !== stored.saved || JSON.stringify(stored.tags ?? []) !== JSON.stringify(stored.savedTags ?? []) || documentStore.hasPending(stored.id ?? null)) && typeof stored.content === 'string') {
        stored.id = documentStore.resolve(stored.id ?? null);
        stored.parentId = documentStore.resolve(stored.parentId ?? null);
        stored.afterId = documentStore.resolve(stored.afterId ?? null);
        stored.beforeId = documentStore.resolve(stored.beforeId ?? null);
        const row = items.find(item => item.id === stored.id);
        return { ...blank(items, true), ...stored, placement: stored.placement ?? 'tail', requestId: stored.requestId ?? crypto.randomUUID(), revision: stored.revision ?? row?.revision ?? null,
          kind: stored.kind ?? (row ? entryKind(row) : defaultKind), active: true, parentId: stored.parentId ?? row?.parent_id ?? null };
      }
      for (const row of items) {
        const rowKind = entryKind(row);
        const edit = localStorage.getItem(`still-edit-${rowKind}-${row.id}`);
        if (edit !== null) return { ...blank(items, true), kind: rowKind, mode: 'edit', id: row.id, revision: row.revision, content: edit, saved: row.content, parentId: row.parent_id };
      }
      const oldTask = kind === 'tasks' ? localStorage.getItem('still-task-draft') : null;
      if (oldTask) return { ...blank(items, true), content: oldTask };
    } catch { /* Keep the journal usable if old local draft metadata is malformed. */ }
    return blank(items, composer);
  });
  const current = useRef(draft);
  const records = useRef(items);
  records.current = items;
  useLayoutEffect(() => {
    if (!target || kind !== 'mixed' && target.kind !== kind) return;
    const item = records.current.find(row => row.id === target.id);
    if (!item) return;
    const parents: number[] = [];
    let parent = item.parent_id;
    while (parent !== null) { parents.push(parent); parent = records.current.find(row => row.id === parent)?.parent_id ?? null; }
    setExpanded(previous => new Set([...previous, ...parents]));
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-kind="${target.kind}"][data-item-id="${target.id}"] [role="group"]`);
      row?.scrollIntoView({ block: 'center' }); row?.focus({ preventScroll: true });
    }));
    return () => cancelAnimationFrame(frame);
  }, [target, kind]);
  const mounted = useRef(true);
  const input = useRef<RichTextHandle>(null);
  const pendingSelection = useRef<TextOffsets | undefined>(undefined);
  const pendingVertical = useRef<VerticalTarget | undefined>(undefined);
  const verticalX = useRef<number | null>(null);
  const pendingLinkEdit = useRef(false);
  const lock = useRef(false);
  const actionToken = useRef(0);
  const restoringFocus = useRef(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const previouslyComposer = useRef(composer);
  const persist = useCallback((next: Draft) => {
    current.current = next;
    if (next.active) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
    if (mounted.current) setDraft(next);
  }, [key]);
  useEffect(() => {
    const value = current.current;
    if (kind !== 'tasks' || !composer || !value.active || value.mode !== 'new' || value.placement !== 'tail' ||
        value.id !== null || value.parentId !== null || value.content.trim() || value.tags.length) return;
    const afterId = siblings(items, null).at(-1)?.id ?? null;
    if (value.afterId !== afterId) persist({ ...value, afterId });
  }, [items, kind, composer, persist]);
  const focus = () => {
    if (selectionActive.current) { restoringFocus.current = false; return; }
    if (pendingVertical.current) input.current?.focusAt(pendingVertical.current.x, pendingVertical.current.direction, { preventScroll: false });
    else input.current?.focus({ preventScroll: false }, pendingSelection.current);
    if (pendingLinkEdit.current) input.current?.editLink();
    pendingSelection.current = undefined;
    pendingVertical.current = undefined;
    pendingLinkEdit.current = false;
    restoringFocus.current = false;
  };
  const dismissEmptyDraft = () => {
    if (lock.current) return false;
    const snapshot = current.current;
    if (snapshot.id !== null || snapshot.content.trim() || snapshot.tags.length) return false;
    persist(blank(records.current, false));
    return true;
  };

  documentStore.refresh = refresh;
  documentStore.changed = () => {
    records.current = documentStore.items();
    if (mounted.current) renderDocument(value => value + 1);
  };
  documentStore.remapped = () => {
    const resolve = documentStore.resolve;
    const value = current.current;
    records.current = documentStore.items();
    persist({ ...value, id: resolve(value.id), parentId: resolve(value.parentId),
      afterId: resolve(value.afterId), beforeId: resolve(value.beforeId ?? null) });
    const remap = (ids: Set<number>) => new Set([...ids].map(id => resolve(id)!));
    setExpanded(remap); setCollapsed(remap); setPreviewed(remap); setRemoved(remap);
  };
  documentStore.failed = (error, ids) => {
    for (const id of ids) entryError(error, surface.current?.querySelector<HTMLElement>(`[data-item-id="${id}"]`));
  };
  const stageDraft = useCallback(() => {
    const value = current.current;
    if (!value.active || value.content === value.saved && JSON.stringify(value.tags) === JSON.stringify(value.savedTags)) return value.id;
    if (!value.content.trim() && !value.tags.length) {
      if (value.id !== null) documentStore.enqueue([{ kind: value.kind, id: value.id, delete: true }], value.clientId);
      persist({ ...value, id: null, revision: null, saved: '', savedTags: [] });
      return null;
    }
    const id = value.id ?? documentStore.allocate();
    documentStore.enqueue([{
      id, kind: value.kind, create: value.id === null, content: value.content, tags: value.tags, date: day,
      client_id: value.clientId, parent_id: value.parentId, after_id: value.afterId, before_id: value.beforeId,
    }], value.clientId);
    persist({ ...value, id, saved: value.content, savedTags: value.tags });
    return id;
  }, [day, documentStore, persist]);
  const save = useCallback(() => {
    const id = stageDraft();
    setSaving(true);
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
    const applied = () => { selectionActive.current = false; setSelectedAll(false); setRemoved(new Set()); persist(blank([], composer)); };
    window.addEventListener('still-history-applied', applied);
    return () => window.removeEventListener('still-history-applied', applied);
  }, [composer, persist]);
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
    const onFocus = () => {
      if (defaultKind === 'notes' && composer && !document.querySelector('dialog[open]') && document.activeElement === document.body) input.current?.focus({ preventScroll: true });
    };
    const frame = requestAnimationFrame(() => {
      if (defaultKind === 'notes' && composer) input.current?.focus({ preventScroll: true });
    });
    const flush = () => { void save().catch(() => {}); };
    window.addEventListener('focus', onFocus); window.addEventListener('pagehide', flush);
    return () => {
      mounted.current = false; cancelAnimationFrame(frame);
      if (entryGesture.current?.timer) clearTimeout(entryGesture.current.timer);
      window.removeEventListener('focus', onFocus); window.removeEventListener('pagehide', flush);
      void save().catch(() => {});
    };
  }, [composer, kind, save]);

  const run = async (action: () => Promise<void>, restoreFocus = true) => {
    if (lock.current) return;
    const token = ++actionToken.current;
    lock.current = true; restoringFocus.current = restoreFocus; setBusy(true);
    try { await action(); }
    catch (error) { entryError(error); }
    finally {
      if (actionToken.current === token && mounted.current) {
        lock.current = false;
        flushSync(() => setBusy(false));
        if (restoreFocus) focus();
      }
    }
  };
  const activate = (row: OutlineItem, selection?: TextOffsets, vertical?: VerticalTarget) => {
    const group = siblings(records.current, row.parent_id);
    const index = group.findIndex(item => item.id === row.id);
    restoringFocus.current = true;
    flushSync(() => persist({ ...blank(records.current, true), mode: 'edit', id: row.id, content: row.content, saved: row.content,
      kind: entryKind(row), revision: row.revision, tags: row.tags ?? [], savedTags: row.tags ?? [],
      hiddenTag: activeTag && row.tags?.includes(activeTag) ? activeTag : null,
      parentId: row.parent_id, afterId: group[index - 1]?.id ?? null, beforeId: index === 0 ? group[1]?.id : null }));
    pendingSelection.current = selection;
    pendingVertical.current = vertical;
    focus();
  };
  const select = (row: OutlineItem, element?: HTMLElement, contextLink?: HTMLElement, offsets?: TextOffsets, vertical?: VerticalTarget) => {
    if (lock.current) return;
    if (!vertical) verticalX.current = null;
    const selection = offsets ?? selectedTextOffsets(element, contextLink);
    void save().catch(() => {});
    const latest = records.current.find(item => item.id === documentStore.resolve(row.id));
    if (!latest) return;
    activate(latest, selection, vertical);
    if (contextLink) input.current?.editLink();
  };
  const checkDepth = (id: number | null, parentId: number | null) => {
    let level = 1, ancestor = parentId;
    while (ancestor !== null) { level++; ancestor = records.current.find(item => item.id === ancestor)?.parent_id ?? null; }
    const height = (parent: number): number => Math.max(0, ...records.current.filter(row => row.parent_id === parent).map(row => 1 + height(row.id)));
    if (level + (id === null ? 0 : height(id)) > MAX_LEVELS) throw new Error(`Bullets support up to ${MAX_LEVELS} levels.`);
  };
  const moveDestination = (snapshot: { id: number | null; parentId: number | null; afterId: number | null }, outdent: boolean) => {
    const parent = records.current.find(item => item.id === snapshot.parentId);
    const group = siblings(records.current, snapshot.parentId);
    const index = group.findIndex(item => item.id === snapshot.id);
    const previous = index >= 0 ? group[index - 1] : group.find(item => item.id === snapshot.afterId);
    if (outdent ? !parent : !previous) return null;
    const parentId = outdent ? parent!.parent_id : previous!.id;
    const afterId = outdent ? parent!.id : siblings(records.current, previous!.id).at(-1)?.id ?? null;
    const targetParent = parentId === null ? null : records.current.find(item => item.id === parentId);
    const targetKind: EntryKind = targetParent ? entryKind(targetParent) : defaultKind;
    checkDepth(snapshot.id, parentId);
    return { parentId, afterId, targetKind };
  };
  const move = (outdent: boolean) => {
    const snapshot = current.current;
    const destination = moveDestination(snapshot, outdent);
    if (!destination) return;
    const { parentId, afterId, targetKind } = destination;
    if (snapshot.id !== null) {
      const id = stageDraft();
      if (id !== null) documentStore.enqueue([{ kind: snapshot.kind, id, move: true, parent_id: parentId, after_id: afterId, target_kind: targetKind }]);
    }
    restoringFocus.current = true;
    flushSync(() => {
      if (parentId !== null) setExpanded(previous => new Set([...previous, parentId]));
      persist({ ...current.current, kind: targetKind, parentId, afterId, beforeId: null, placement: 'after' });
    });
    void documentStore.flush().catch(() => {});
  };
  const moveSavedItem = (item: OutlineItem, outdent: boolean) => {
    try {
      stageDraft();
      const latest = records.current.find(row => row.id === item.id);
      if (!latest) return;
      const group = siblings(records.current, latest.parent_id);
      const index = group.findIndex(row => row.id === latest.id);
      const destination = moveDestination({ id: latest.id, parentId: latest.parent_id, afterId: group[index - 1]?.id ?? null }, outdent);
      if (!destination) return;
      documentStore.enqueue([{ kind: entryKind(latest), id: latest.id, move: true,
        parent_id: destination.parentId, after_id: destination.afterId, target_kind: destination.targetKind }]);
      void documentStore.flush().catch(() => {});
    } catch (error) { entryError(error, surface.current?.querySelector(`[data-item-id="${item.id}"]`)); }
  };
  const complete = (id: number) => void run(async () => {
    await save();
    id = documentStore.resolve(id)!;
    const task = records.current.find(row => row.id === id);
    if (!task) return;
    if (task.completed_at) {
      const result = await api<{ reopened: number[]; operation_id: string | null }>(`/tasks/${id}/reopen`, 'POST', { completed_at: task.completed_at, expected_revision: task.revision, record_history: true });
      recordEdit(result.operation_id, crypto.randomUUID());
      onReopen(result.reopened);
      await refresh(); return;
    }
    let finishing = task;
    while (finishing.parent_id !== null) {
      const parent = records.current.find(row => row.id === finishing.parent_id);
      if (!parent || (parent.completed_child_count ?? 0) + 1 !== parent.child_count) break;
      finishing = parent;
    }
    if (finishing.parent_id === null) setCompleting(finishing.id);
    try {
      const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
      const [result] = await Promise.all([api<{ task_ids: number[]; completed_at: string }>(`/tasks/${id}/complete?expected_revision=${task.revision}`, 'POST'), new Promise(resolve => setTimeout(resolve, delay))]);
      onComplete(result.task_ids, id, result.completed_at);
      persist(blank(records.current, composer));
      await refresh();
    } finally { setCompleting(null); }
  }, false);

  const beginBullet = () => {
    void save().catch(() => {});
    restoringFocus.current = true;
    flushSync(() => persist(blank(records.current, true)));
    focus();
  };

  const verticalBoundary = (direction: VerticalDirection, measuredX: number) => {
    const currentElement = surface.current?.querySelector('[contenteditable]')?.closest<HTMLElement>('li[data-outline-key]');
    if (!currentElement) return false;
    const elements = [...document.querySelectorAll<HTMLElement>('li[data-outline-key][data-item-id]')]
      .filter(element => element.offsetParent !== null && getComputedStyle(element).visibility !== 'hidden' &&
        !element.closest('[aria-hidden="true"]') && element.dataset.done !== 'true');
    const index = elements.indexOf(currentElement);
    if (index < 0) return false;
    const step = direction === 'up' ? -1 : 1;
    let adjacent = elements[index + step];
    while (adjacent?.dataset.itemId === 'draft') adjacent = elements[elements.indexOf(adjacent) + step];
    if (!adjacent) { verticalX.current = null; return false; }
    const id = Number(adjacent.dataset.itemId);
    const outlineKey = adjacent.dataset.outlineKey;
    if (!Number.isInteger(id) || !outlineKey) { verticalX.current = null; return false; }
    const x = verticalX.current ?? measuredX;
    window.dispatchEvent(new CustomEvent('still-vertical-entry', { detail: { key: outlineKey, id, x, direction } }));
    return true;
  };

  useEffect(() => {
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; id: number; x: number; direction: VerticalDirection }>).detail;
      if (!detail || detail.key !== key) return;
      const row = records.current.find(item => item.id === detail.id);
      if (!row) return;
      verticalX.current = detail.x;
      select(row, undefined, undefined, undefined, { x: detail.x, direction: detail.direction });
    };
    window.addEventListener('still-vertical-entry', navigate);
    return () => window.removeEventListener('still-vertical-entry', navigate);
  });

  useEffect(() => {
    const append = (event: Event) => { if ((event as CustomEvent<string>).detail === key) beginBullet(); };
    window.addEventListener('still-new-bullet', append);
    return () => window.removeEventListener('still-new-bullet', append);
  });
  const adjacentEntry = (backwards: boolean) => {
    const currentElement = surface.current?.querySelector('[contenteditable]')?.closest('li');
    const elements = [...surface.current?.querySelectorAll<HTMLElement>('li[data-outline-key][data-item-id]') ?? []]
      .filter(el => el.offsetParent !== null && !el.closest('[aria-hidden="true"]') && el.dataset.done !== 'true');
    const index = elements.findIndex(el => el === currentElement);
    const adjacent = elements[index + (backwards ? -1 : 1)];
    return records.current.find(row => row.id === Number(adjacent?.dataset.itemId));
  };
  const boundary = (direction: 'backspace' | 'delete') => {
    if (lock.current) return;
    const backwards = direction === 'backspace';
    if (backwards && current.current.parentId !== null) { shiftDraft(true); return; }
    const other = adjacentEntry(backwards);
    const snapshot = current.current;
    if (!other) {
      if (backwards && !snapshot.content.trim() && !snapshot.tags.length) {
        void save().catch(() => {});
        flushSync(() => persist(blank(records.current, false)));
      }
      return;
    }
    restoringFocus.current = true;
    const ownId = stageDraft();
    if (ownId === null) {
      const offset = backwards ? markdownText(other.content).length : 0;
      activate(other, { anchor: offset, head: offset });
    } else {
      const own = records.current.find(row => row.id === ownId)!;
      const first = backwards ? other : own, second = backwards ? own : other;
      const content = mergeMarkdown(first.content, second.content);
      const tags = [...new Set([...first.tags ?? [], ...second.tags ?? []])];
      const offset = markdownText(first.content).length;
      documentStore.enqueue([
        { kind: entryKind(first), id: first.id, content, tags },
        { kind: entryKind(second), id: second.id, delete: true },
      ]);
      activate(records.current.find(row => row.id === first.id)!, { anchor: offset, head: offset });
    }
    void documentStore.flush().catch(() => {});
  };
  const deleteCurrentEntry = () => {
    const previous = adjacentEntry(true), next = adjacentEntry(false);
    const snapshot = current.current;
    restoringFocus.current = true;
    updateEntrySelection(null);
    if (snapshot.id !== null) documentStore.enqueue([{ kind: snapshot.kind, id: snapshot.id, delete: true }]);
    const other = previous ?? next;
    if (other) {
      const offset = previous ? markdownText(other.content).length : 0;
      activate(records.current.find(row => row.id === other.id) ?? other, { anchor: offset, head: offset });
    } else {
      flushSync(() => persist({ ...blank(records.current, true, snapshot.parentId, snapshot.afterId, snapshot.kind), beforeId: snapshot.beforeId }));
      focus();
    }
    void documentStore.flush().catch(() => {});
  };
  const selectDocument = () => {
    selectionActive.current = true; setSelectedAll(true); setExpanded(new Set(records.current.map(item => item.id)));
    if (surface.current) {
      surface.current.focus(); const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(surface.current); selection?.removeAllRanges(); selection?.addRange(range);
    }
    void save().catch(() => {});
  };
  const selectedEntryIds = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
    const range = selection.getRangeAt(0);
    return records.current.filter(row => {
      const item = surface.current?.querySelector<HTMLElement>(`[data-item-id="${row.id}"]`);
      const content = item?.querySelector(':scope > div > [role="group"]');
      return !!content && range.intersectsNode(content);
    }).map(row => row.id);
  };
  const deleteEntries = (ids: number[]) => void run(async () => {
    await save();
    const selected = new Set(ids);
    const changes = records.current.filter(item => selected.has(item.id))
      .map(item => ({ kind: entryKind(item), id: item.id, delete: true, expected_revision: item.revision }));
    if (changes.length) await editDocument(changes);
    selectionActive.current = false; setSelectedAll(false); window.getSelection()?.removeAllRanges();
    persist(blank(records.current.filter(item => !selected.has(item.id)), composer));
    await refresh();
  });
  useEffect(() => {
    const deleteSelection = (event: KeyboardEvent) => {
      if (selectionActive.current || event.defaultPrevented || event.key !== 'Backspace' && event.key !== 'Delete') return;
      const selected = selectedEntryIds();
      if (selected.length < 2) return;
      event.preventDefault(); event.stopPropagation(); deleteEntries(selected);
    };
    document.addEventListener('keydown', deleteSelection, true);
    return () => document.removeEventListener('keydown', deleteSelection, true);
  });
  const replaceDocument = (text = '', html = '') => void run(async () => {
    await save();
    const bullet = pastedBullet(text, html);
    const tags = [...new Set([...bullet.tags, ...(activeTag ? [activeTag] : [])])];
    const changes: Record<string, unknown>[] = records.current.map(item => ({ kind: entryKind(item), id: item.id, delete: true }));
    const hasContent = !!(bullet.content.trim() || bullet.tags.length);
    if (hasContent) changes.push({ kind: defaultKind, content: bullet.content, tags, date: day, client_id: crypto.randomUUID() });
    const results = changes.length ? await editDocument(changes) : [];
    const created = hasContent ? results.at(-1) : null;
    selectionActive.current = false; setSelectedAll(false); window.getSelection()?.removeAllRanges();
    persist(created ? { ...blank([], true), kind: defaultKind, mode: 'edit', id: created.id, content: created.content, saved: created.content, tags: created.tags ?? [], savedTags: created.tags ?? [] } : blank([], composer));
    if (created) pendingSelection.current = { anchor: markdownText(created.content).length, head: markdownText(created.content).length };
    await refresh();
  });
  const copyDocument = (clipboard: DataTransfer) => {
    const lines: string[] = [];
    const build = (parent: number | null, depth: number): HTMLUListElement => {
      const list = document.createElement('ul');
      for (const row of sorted(records.current.filter(item => (item.parent_id !== null && !records.current.some(other => other.id === item.parent_id) ? null : item.parent_id) === parent))) {
        const tags = row.tags?.filter(tag => tag !== activeTag) ?? [];
        lines.push('  '.repeat(depth) + '- ' + row.content.replace(/\n/g, '\n' + '  '.repeat(depth + 1)) + (tags.length ? ' ' + tags.map(tag => '#' + tag).join(' ') : ''));
        const li = document.createElement('li');
        const element = surface.current?.querySelector(`[data-item-id="${row.id}"]`);
        const text = element?.querySelector(':scope > div > [role="group"], :scope > div .tiptap');
        if (text) li.innerHTML = text.innerHTML;
        else li.textContent = markdownText(row.content);
        const children = build(row.id, depth + 1);
        if (children.children.length) li.append(children);
        list.append(li);
      }
      return list;
    };
    clipboard.setData('text/html', build(null, 0).outerHTML); clipboard.setData('text/plain', lines.join('\n'));
  };

  const draftInside = (id: number) => {
    let parent = current.current.active ? current.current.parentId : null;
    while (parent !== null) {
      if (parent === id) return true;
      parent = records.current.find(row => row.id === parent)?.parent_id ?? null;
    }
    return false;
  };
  const clearPreview = (id: number | null) => {
    if (id === null) return;
    setPreviewed(previous => {
      if (!previous.size) return previous;
      const next = new Set(previous);
      for (const candidate of previous) {
        let ancestor: number | null = candidate;
        while (ancestor !== null) {
          if (ancestor === id) { next.delete(candidate); break; }
          ancestor = records.current.find(row => row.id === ancestor)?.parent_id ?? null;
        }
      }
      return next.size === previous.size ? previous : next;
    });
  };
  const isExpanded = (id: number) => {
    const row = items.find(item => item.id === id);
    return (!!row && entryKind(row) === 'tasks' && !!row.completed_at && !collapsed.has(id)) || expanded.has(id) || previewed.has(id) || draftInside(id);
  };
  const renderToggle = (id: number | null, content: string) => {
    const row = items.find(item => item.id === id);
    const childCount = row?.child_count ?? items.filter(item => item.parent_id === id).length;
    const doneCount = row?.completed_child_count ?? items.filter(item => item.parent_id === id && item.completed_at).length;
    const rowKind = row ? entryKind(row) : draft.kind;
    if (id === null || !childCount && !(draft.active && draft.parentId === id && (draft.content.trim() || draft.tags.length))) return null;
    const open = isExpanded(id);
    const pinned = expanded.has(id) || draftInside(id) || (!!row?.completed_at && rowKind === 'tasks' && !collapsed.has(id));
    const taskParent = rowKind === 'tasks';
    const showPie = taskParent && doneCount > 0;
    return <Disclosure type="button" data-focus-chrome $open={open} $pie={showPie} $done={!!row?.completed_at} $progress={childCount ? doneCount / childCount : 0} disabled={busy} aria-expanded={open}
      aria-description={taskParent ? `${doneCount} of ${childCount} children completed` : undefined}
      aria-label={`${pinned ? 'Collapse' : 'Expand'} ${markdownText(content) || 'bullet'}`}
      onPointerEnter={event => {
        if (!pinned && event.pointerType !== 'touch') setPreviewed(previous => previous.has(id) ? previous : new Set([...previous, id]));
      }} onClick={() => {
        if (pinned) {
          void save().catch(() => {});
          if (draftInside(id)) persist(blank(records.current, composer));
          clearPreview(id);
        }
        setExpanded(previous => { const next = new Set(previous); if (pinned) next.delete(id); else next.add(id); return next; });
        if (row?.completed_at && rowKind === 'tasks') {
          setCollapsed(previous => {
            const next = new Set(previous);
            if (pinned) next.add(id); else next.delete(id);
            return next;
          });
        }
      }} />;
  };

  const inputLabel = draft.mode === 'edit' ? draft.kind === 'notes' ? 'Edit note' : 'Edit to-do' : draft.kind === 'notes' ? 'New journal bullet' : 'New to-do';
  const renderMarker = (id: number | null, content: string) => {
    const toggle = renderToggle(id, content);
    const row = items.find(item => item.id === id);
    const rowKind = row ? entryKind(row) : draft.kind;
    if (rowKind === 'tasks' && id !== null) {
      const done = !!row?.completed_at;
      return toggle ?? <Checkbox type="button" data-focus-chrome data-preview-suppressed={suppressedPreviews.has(id) || undefined} $checked={done} $suppressPreview={suppressedPreviews.has(id)} aria-pressed={done} disabled={busy} aria-label={`${done ? 'Reopen' : 'Complete'} ${markdownText(content)}`}
        onPointerLeave={event => {
          const button = event.currentTarget;
          const release = () => {
            if (button.matches(':hover')) return;
            previewSuppressedAt.current.delete(id);
            setSuppressedPreviews(previous => { const next = new Set(previous); next.delete(id); return next; });
          };
          const remaining = 250 - (performance.now() - (previewSuppressedAt.current.get(id) ?? 0));
          if (remaining > 0) setTimeout(release, remaining); else release();
        }}
        onClick={() => { previewSuppressedAt.current.set(id, performance.now()); setSuppressedPreviews(previous => new Set([...previous, id])); complete(id); }} />;
    }
    return toggle ?? <Marker data-focus-chrome $task={rowKind === 'tasks'} aria-hidden="true" />;
  };
  const shiftDraft = (outdent: boolean) => {
    const selection = input.current?.selection();
    try {
      move(outdent);
      pendingSelection.current = selection;
      focus();
    } catch (error) { entryError(error); restoringFocus.current = false; }
  };
  const clearEntryGestureTimer = (gesture: EntryGesture) => {
    if (gesture.timer) clearTimeout(gesture.timer);
    gesture.timer = null;
  };
  const startEntryGesture = (event: React.PointerEvent, key: string, element: HTMLElement) => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const previous = entryGesture.current;
    if (previous) clearEntryGestureTimer(previous);
    const pager = element.closest<HTMLElement>('[data-mobile-pager]');
    const gesture: EntryGesture = {
      pointerId: event.pointerId, key, element, x: event.clientX, y: event.clientY, pager,
      pagerLeft: pager?.scrollLeft ?? 0, armed: entrySelectionRef.current?.key === key,
      paging: false, cancelled: false, timer: null,
    };
    entryGesture.current = gesture;
    if (gesture.armed) return;
    gesture.timer = setTimeout(() => {
      if (entryGesture.current !== gesture || gesture.cancelled || gesture.paging) return;
      gesture.armed = true;
      suppressClick.current = true;
      updateEntrySelection({ key, dragX: 0 });
      window.getSelection()?.removeAllRanges();
      try { element.setPointerCapture(gesture.pointerId); } catch { /* The pointer may already have ended. */ }
      haptic('impact');
    }, ENTRY_HOLD_MS);
  };
  const trackEntryGesture = (event: React.PointerEvent) => {
    const gesture = entryGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.cancelled) return;
    const x = event.clientX - gesture.x;
    const y = event.clientY - gesture.y;
    if (gesture.armed) {
      if (Math.abs(x) < 4 || Math.abs(x) < Math.abs(y)) return;
      event.preventDefault(); event.stopPropagation();
      const dragX = Math.sign(x) * Math.min(28, Math.abs(x));
      updateEntrySelection({ key: gesture.key, dragX });
      return;
    }
    if (!gesture.paging && Math.abs(x) < 10 && Math.abs(y) < 10) return;
    clearEntryGestureTimer(gesture);
    if (!gesture.paging && Math.abs(y) >= Math.abs(x)) {
      gesture.cancelled = true;
      return;
    }
    if (!gesture.pager) { gesture.cancelled = true; return; }
    gesture.paging = true;
    gesture.pager.dataset.dragging = 'true';
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* Continue with the events the browser provides. */ }
    event.preventDefault(); event.stopPropagation();
    gesture.pager.scrollLeft = gesture.pagerLeft - x;
  };
  const finishEntryGesture = (event: React.PointerEvent) => {
    const gesture = entryGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    entryGesture.current = null;
    clearEntryGestureTimer(gesture);
    const x = event.clientX - gesture.x;
    const y = event.clientY - gesture.y;
    if (gesture.paging && gesture.pager) {
      event.preventDefault(); event.stopPropagation();
      delete gesture.pager.dataset.dragging;
      const width = gesture.pager.clientWidth;
      const initial = Math.round(gesture.pagerLeft / width);
      const direction = Math.abs(x) >= ENTRY_MOVE_THRESHOLD && Math.abs(x) >= Math.abs(y) * 1.25 ? (x < 0 ? 1 : -1) : 0;
      const last = Math.max(0, Math.round(gesture.pager.scrollWidth / width) - 1);
      const target = Math.max(0, Math.min(last, initial + direction));
      gesture.pager.scrollTo({ left: target * width, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      suppressClick.current = true;
      return;
    }
    if (!gesture.armed) return;
    event.preventDefault(); event.stopPropagation();
    suppressClick.current = true;
    const direction = Math.abs(x) >= ENTRY_MOVE_THRESHOLD && Math.abs(x) >= Math.abs(y) * 1.25 ? (x > 0 ? 'in' : 'out') : null;
    if (!direction) {
      updateEntrySelection({ key: gesture.key, dragX: 0 });
      return;
    }
    updateEntrySelection(null);
    const outdent = direction === 'out';
    if (gesture.key.startsWith('item:')) {
      const id = Number(gesture.key.slice('item:'.length));
      const item = records.current.find(row => row.id === id);
      if (item) moveSavedItem(item, outdent);
    } else shiftDraft(outdent);
  };
  const cancelEntryGesture = (event: React.PointerEvent) => {
    const gesture = entryGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    entryGesture.current = null;
    clearEntryGestureTimer(gesture);
    if (gesture.pager) {
      delete gesture.pager.dataset.dragging;
      if (gesture.paging) gesture.pager.scrollTo({ left: gesture.pagerLeft, behavior: 'smooth' });
    }
    if (gesture.armed) updateEntrySelection({ key: gesture.key, dragX: 0 });
  };
  const advance = () => {
    if (lock.current) return;
    const snapshot = current.current;
    if (!snapshot.content.trim() && !snapshot.tags.length) {
      if (snapshot.id !== null) stageDraft();
      if (snapshot.parentId !== null) shiftDraft(true);
      else { void documentStore.flush().catch(() => {}); }
      return;
    }
    const split = input.current?.splitAtSelection();
    const hiddenTag = snapshot.hiddenTag ?? (activeTag && snapshot.savedTags.includes(activeTag) ? activeTag : null);
    const keepHiddenTag = (content: string, tags: string[]) =>
      [...new Set([...tags, ...(hiddenTag && (content.trim() || tags.length) ? [hiddenTag] : [])])];
    restoringFocus.current = true;
    if (split && !split.before.content && !split.before.tags.length && (split.after.content || split.after.tags.length)) {
      // A split at the start must not delete the parent and promote all its
      // children. Keep that entry's identity with its trailing content.
      flushSync(() => persist({ ...snapshot, mode: 'new', content: split.after.content, tags: keepHiddenTag(split.after.content, split.after.tags) }));
      pendingSelection.current = { anchor: 0, head: 0 };
      focus();
      void save().catch(() => {});
      return;
    }
    flushSync(() => {
      if (split) persist({ ...snapshot, content: split.before.content, tags: keepHiddenTag(split.before.content, split.before.tags) });
      const id = stageDraft();
      const parent = records.current.find(item => item.id === snapshot.parentId);
      const next = blank(records.current, true, snapshot.parentId, id ?? snapshot.afterId, parent ? entryKind(parent) : defaultKind);
      persist({ ...next, beforeId: id === null ? snapshot.beforeId : null,
        content: split?.after.content ?? '', tags: split ? keepHiddenTag(split.after.content, split.after.tags) : [] });
    });
    pendingSelection.current = { anchor: 0, head: 0 };
    focus();
    void documentStore.flush().catch(() => {});
  };
  const renderDraft = (depth: number): ReactNode => {
    const gestureKey = `draft:${draft.clientId}`;
    const gestureSelected = entrySelection?.key === gestureKey;
    return <DraftItem key="draft" data-depth={depth} draggable={gestureSelected}
    data-outline-key={key} data-kind={draft.kind} data-item-id={draft.id ?? 'draft'}
    data-entry-gesture-key={gestureKey} data-gesture-selected={gestureSelected || undefined}
    onPointerLeave={() => clearPreview(draft.id)}
    onContextMenuCapture={event => { if (gestureSelected) { event.preventDefault(); event.stopPropagation(); } }}
    $emptyTask={draft.kind === 'tasks' && draft.id === null && !draft.content.trim() && !draft.tags.length}
    $gestureSelected={gestureSelected} $dragX={gestureSelected ? entrySelection.dragX : 0}
    $leaving={completing === draft.id && completing !== null}>
    <Row aria-busy={saving}>{renderMarker(draft.id, draft.content)}<RichTextEditor key={draft.clientId} ref={input} label={archived && draft.kind === 'tasks' && draft.parentId !== null && draft.mode === 'new' ? 'New completed subtask' : inputLabel} value={draft.content} tags={draft.tags.filter(tag => tag !== activeTag)} readOnly={false}
      onBoundary={boundary} onVerticalBoundary={verticalBoundary} onSelectDocument={selectDocument}
      onEnter={advance} onSelectEntry={selected => updateEntrySelection(selected ? { key: gestureKey, dragX: 0 } : null)} onDeleteEntry={deleteCurrentEntry}
      onChange={(content, tags) => {
        verticalX.current = null;
        const hiddenTag = current.current.hiddenTag ?? (activeTag && current.current.savedTags.includes(activeTag) ? activeTag : null);
        persist({ ...current.current, content, tags: [...new Set([...tags, ...(hiddenTag && (content.trim() || tags.length) ? [hiddenTag] : [])])] });
      }}
      onBlur={event => {
        const blurredClientId = draft.clientId;
        // Enter and nesting can remount the editor during a focus transfer.
        // That structural blur must not dismiss the draft being moved.
        if (restoringFocus.current || current.current.clientId !== blurredClientId) return;
        if (event?.relatedTarget instanceof Node && surface.current?.contains(event.relatedTarget)) { void save().catch(() => {}); return; }
        if (!lock.current && dismissEmptyDraft()) return;
        void save().then(() => {
          if (!restoringFocus.current && current.current.clientId === blurredClientId && !surface.current?.contains(document.activeElement)) dismissEmptyDraft();
        }).catch(() => {});
      }}
      onKeyDown={event => {
        // `busy` is presentation state and can remain true in this callback for
        // one render after an async structural edit has released its lock.
        // `run()` owns the actual mutation lock, so letting the key reach the
        // handlers prevents a restored editor from swallowing the first key.
        if (event.isComposing) return;
        // If the user reaches the remounted editor before the scheduled caret
        // restoration, their key is the newer intent. Do not overwrite the
        // resulting selection on the next animation frame.
        if (restoringFocus.current && event.currentTarget === document.activeElement) {
          pendingSelection.current = undefined;
          pendingVertical.current = undefined;
          restoringFocus.current = false;
        }
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') verticalX.current = null;
        if (event.key === 'Tab') {
          event.preventDefault();
          shiftDraft(event.shiftKey);
        } else if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          advance();
        } else if (event.key === 'Backspace' && current.current.mode === 'new' && !current.current.content && !current.current.tags.length && !current.current.id) {
          event.preventDefault(); dismissEmptyDraft();
        } else if (event.key === 'Escape' && draft.mode === 'edit') {
          event.preventDefault(); persist(blank(records.current, composer)); focus();
        }
      }} /></Row>
    {draft.id !== null && <Branch data-branch-for={draft.id} $open={isExpanded(draft.id)} $editing={draftInside(draft.id)} aria-hidden={!isExpanded(draft.id)}>{renderChildren(draft.id, depth + 1)}</Branch>}
  </DraftItem>;
  };

  const renderChildren = (parentId: number | null, depth: number): ReactNode => {
    const group: (OutlineItem | null)[] = sorted(items.filter(item => !removed.has(item.id) &&
      (item.parent_id !== null && !items.some(parent => parent.id === item.parent_id) ? null : item.parent_id) === parentId
    )).filter(item => !draft.active || item.id !== draft.id);
    const draftParent = draft.parentId !== null && !items.some(row => row.id === draft.parentId) ? null : draft.parentId;
    if (draft.active && draftParent === parentId) {
      let index = draft.beforeId != null ? group.findIndex(item => item?.id === draft.beforeId) : draft.afterId !== null ? group.findIndex(item => item?.id === draft.afterId) + 1 : -1;
      if (index < 0 || index === 0 && draft.beforeId == null) {
        const original = items.find(item => item.id === draft.id && item.parent_id === parentId);
        index = original ? group.filter(item => item && (item.position < original.position || item.position === original.position && item.id < original.id)).length : group.length;
      }
      group.splice(index, 0, null);
    }
    if (!group.length) return null;
    const content = group.map(item => {
      if (item === null) return renderDraft(depth);
      const gestureKey = `item:${item.id}`;
      const gestureSelected = entrySelection?.key === gestureKey;
      return <Item key={item.id} data-outline-key={key} data-done={!!item.completed_at && !archived} data-kind={entryKind(item)} data-item-id={item.id} data-depth={depth} $leaving={completing === item.id}
      data-entry-gesture-key={gestureKey} data-gesture-selected={gestureSelected || undefined}
      onPointerLeave={() => clearPreview(item.id)}
      onContextMenuCapture={event => { if (gestureSelected) { event.preventDefault(); event.stopPropagation(); } }}
      $gestureSelected={gestureSelected} $dragX={gestureSelected ? entrySelection.dragX : 0}
      $arriving={entryKind(item) === 'tasks' && (completed.has(item.id) || reopened.has(item.id))}>
      <Row>{renderMarker(item.id, item.content)}<Text $done={!!item.completed_at && !archived} $action={archived && entryKind(item) === 'tasks'} role="group" tabIndex={0} aria-label={markdownText(item.content, activeTag ? [activeTag] : []) || (item.tags ?? []).filter(tag => tag !== activeTag).map(tag => '#' + tag).join(' ')}
        onClick={event => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          if ((archived || !item.completed_at) && !(event.target as HTMLElement).closest('a')) void select(item, event.currentTarget);
        }}
        onContextMenu={event => {
          const link = (event.target as HTMLElement).closest('a');
          if (link && (archived || !item.completed_at)) { event.preventDefault(); select(item, event.currentTarget, link); }
        }}
        onKeyDown={event => { if ((archived || !item.completed_at) && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(item); } }}
      ><MarkdownContent content={item.content} tags={activeTag ? item.tags?.filter(tag => tag !== activeTag) : item.tags} hiddenTags={activeTag ? [activeTag] : []} /></Text>
      </Row>
      <Branch data-branch-for={item.id} $open={isExpanded(item.id)} $editing={draftInside(item.id)} aria-hidden={!isExpanded(item.id)}>{renderChildren(item.id, depth + 1)}</Branch>
    </Item>;
    });
    const parent = parentId === null ? null : items.find(item => item.id === parentId);
    return parentId === null ? <List>{content}</List> : <Children $task={parent ? entryKind(parent) === 'tasks' : draft.kind === 'tasks'}>{content}</Children>;
  };
  const clearDrop = () => {
    if (dropTarget.current) delete dropTarget.current.dataset.dropPosition;
    dropTarget.current = null;
  };
  const dropEntry = (event: React.DragEvent) => {
    const element = (event.target as Element).closest<HTMLElement>('li[data-item-id]');
    const target = records.current.find(row => row.id === Number(element?.dataset.itemId));
    const id = documentStore.resolve(draggedEntry.current);
    if (!element || !target || id === null || target.id === id) return null;
    let parent: number | null = target.parent_id;
    while (parent !== null) {
      if (parent === id) return null;
      parent = records.current.find(row => row.id === parent)?.parent_id ?? null;
    }
    const rect = element.firstElementChild!.getBoundingClientRect();
    return { element, target, id, before: event.clientY < rect.top + rect.height / 2 };
  };
  return <OutlineSurface ref={surface} data-outline-kind={defaultKind} tabIndex={-1}
  onDragStartCapture={event => {
    if (!entrySelectionRef.current?.key.startsWith('draft:')) return;
    const id = stageDraft();
    if (id === null) { event.preventDefault(); return; }
    draggedEntry.current = id;
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', current.current.content);
  }} onDragOverCapture={event => {
    if (draggedEntry.current === null) return;
    event.preventDefault(); event.stopPropagation(); clearDrop();
    const drop = dropEntry(event);
    event.dataTransfer.dropEffect = drop ? 'move' : 'none';
    if (drop) { drop.element.dataset.dropPosition = drop.before ? 'before' : 'after'; dropTarget.current = drop.element; }
  }} onDropCapture={event => {
    if (draggedEntry.current === null) return;
    event.preventDefault(); event.stopPropagation();
    const drop = dropEntry(event); clearDrop(); draggedEntry.current = null;
    if (!drop) return;
    const row = records.current.find(row => row.id === drop.id);
    if (!row) return;
    try { checkDepth(row.id, drop.target.parent_id); }
    catch (error) { entryError(error); return; }
    documentStore.enqueue([{ kind: entryKind(row), id: row.id, move: true, parent_id: drop.target.parent_id,
      after_id: drop.before ? null : drop.target.id, before_id: drop.before ? drop.target.id : null,
      target_kind: drop.target.parent_id === null ? defaultKind : entryKind(drop.target) }]);
    const moved = records.current.find(item => item.id === row.id)!;
    activate(moved);
    input.current?.selectEntry();
    void documentStore.flush().catch(() => {});
  }} onDragEndCapture={() => { draggedEntry.current = null; clearDrop(); }} onPointerDown={event => {
    verticalX.current = null; selectionActive.current = false; setSelectedAll(false);
    const entry = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-entry-gesture-key]') : null;
    const gestureKey = entry?.dataset.entryGestureKey;
    if (gestureKey !== entrySelectionRef.current?.key) updateEntrySelection(null);
    if (entry && gestureKey) startEntryGesture(event, gestureKey, entry);
  }} onPointerMove={trackEntryGesture} onPointerUp={finishEntryGesture} onPointerCancel={cancelEntryGesture} onCopyCapture={event => {
    if (!selectionActive.current) return;
    event.preventDefault(); event.stopPropagation(); copyDocument(event.clipboardData);
  }} onCutCapture={event => { if (selectionActive.current) { event.preventDefault(); event.stopPropagation(); copyDocument(event.clipboardData); replaceDocument(); } }}
  onPasteCapture={event => { if (selectionActive.current) { event.preventDefault(); event.stopPropagation(); replaceDocument(event.clipboardData.getData('text/plain'), event.clipboardData.getData('text/html')); } }} onKeyDownCapture={event => {
    if (!selectionActive.current || event.defaultPrevented) return;
    event.stopPropagation();
    const mod = event.metaKey || event.ctrlKey;
    const historyKey = mod && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase());
    if (historyKey && event.repeat) { event.preventDefault(); return; }
    const historyDirection = historyShortcutDirection(event.nativeEvent);
    if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); return; }
    if (historyDirection !== null) { event.preventDefault(); void documentUndo(historyDirection).catch(e => entryError(e)); return; }
    const format = mod ? ({ b: 'bold', i: 'italic', u: 'underline', c: event.shiftKey ? 'code' : '' } as Record<string, string>)[event.key.toLowerCase()] : '';
    if (format) { event.preventDefault(); void run(async () => {
      await save();
      const changes = records.current.filter(item => archived || !item.completed_at).map(item => ({ kind: entryKind(item), id: item.id, content: formatMarkdown(item.content, format), tags: item.tags }));
      if (changes.length) await editDocument(changes);
      persist(blank([], composer)); selectionActive.current = false; setSelectedAll(false); window.getSelection()?.removeAllRanges(); await refresh();
    }); return; }
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); replaceDocument(); }
    else if (!mod && event.key.length === 1) { event.preventDefault(); replaceDocument(event.key); }
    else if (event.key === 'Escape') { event.preventDefault(); selectionActive.current = false; setSelectedAll(false); window.getSelection()?.removeAllRanges(); focus(); }
  }}>{renderChildren(null, 0)}{(!archived || defaultKind === 'notes') && (!draft.active || draft.mode === 'edit') && <ComposerTarget type="button" $floating={defaultKind === 'notes' && !composer}
    data-task-creation-area={defaultKind === 'tasks' || undefined} aria-label={defaultKind === 'tasks' ? 'Add to-do' : 'Add journal bullet'}
    onClick={beginBullet} />}
    {defaultKind === 'tasks' && draft.active && draft.mode === 'new' && <ComposerTarget type="button" $floating={false} data-task-creation-area
      aria-label="Continue new to-do" onClick={focus} />}
    <VisuallyHidden>Tab indents. Shift Tab outdents. Enter adds a sibling. Shift Enter adds a line break. Select all twice selects this list.</VisuallyHidden></OutlineSurface>;
}
