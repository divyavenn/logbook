import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import styled, { keyframes, css } from 'styled-components';
import { useJournalContext, registerDraftFlush } from '../JournalContext';
import { api, ApiError, errorMessage } from '../api';
import type { EntryKind, OutlineItem } from '../types';
import { TextButton, VisuallyHidden } from '../styles';
import { MarkdownContent, markdownText, richTextStyles, mergeMarkdown, formatMarkdown, pastedBullet } from '../markdown';
import { RichTextEditor, type RichTextHandle, type TextOffsets, type VerticalDirection } from './RichTextEditor';
import { documentUndo, editDocument, recordEdit } from '../documentHistory';
import { compactViewport } from '../layout';

const MAX_LEVELS = 8;
const OutlineSurface = styled.div`
  position: relative; outline: none;
  --bullet-size: 15px;
  --bullet-row-height: 28px;
  --bullet-padding: 4px 0;
  --bullet-line-height: 1.2;
  --bullet-paragraph-gap: .2em;
  --bullet-marker-offset: .5px;
  @media(pointer: coarse) { --bullet-size: 16px; --bullet-line-height: 1.35; }
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
const shiftIn = keyframes`from { opacity: .72; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); }`;
const shiftOut = keyframes`from { opacity: .72; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); }`;
const Item = styled.li<{ $leaving?: boolean; $arriving?: boolean; $shifting?: 'in' | 'out' | null }>`
  min-width: 0; transform-origin: left center;
  ${({ $leaving }) => $leaving && css`animation: ${popOut} 180ms ease-out both; pointer-events: none;`}
  ${({ $arriving }) => $arriving && css`animation: ${slideIn} 280ms cubic-bezier(.2,.7,.3,1) both;`}
  ${({ $shifting }) => $shifting && css`animation: ${$shifting === 'in' ? shiftIn : shiftOut} 220ms cubic-bezier(.2, 0, 0, 1) both;`}
`;
const Row = styled.div`position: relative; display: flex; align-items: flex-start; min-height: var(--bullet-row-height); @media(pointer: coarse) { min-height: 44px; } @media ${compactViewport} { min-height: 36px; }`;
const Branch = styled.div<{ $open: boolean }>`
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
const Disclosure = styled.button<{ $open: boolean; $task: boolean; $progress: number }>`
  width: 40px; min-width: 40px; height: var(--bullet-row-height); padding: 0; border: 0;
  display: grid; place-items: center; background: transparent; border-radius: 4px; color: ${({ $task }) => $task ? 'var(--ink)' : 'var(--muted)'};
  &::before { content: ''; width: 5px; height: 5px; border-right: 1.25px solid currentColor; border-bottom: 1.25px solid currentColor; translate: 0 var(--bullet-marker-offset);
    transform: rotate(${({ $open }) => $open ? '45deg' : '-45deg'}); transition: transform 140ms ease-out; }
  ${({ $task, $progress }) => $task && css`&::before { --task-progress: ${$progress * 360}deg; width: 12px; height: 12px; border: 1px solid currentColor; border-radius: 50%; transform: none; background: conic-gradient(currentColor var(--task-progress), transparent 0); transition: --task-progress 240ms ease-out; }`}
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
  @media(pointer: coarse) { min-height: 44px; padding: 10px 0; }
  @media ${compactViewport} { min-height: 36px; padding: 6px 0; }
`;
type Draft = {
  active: boolean; mode: 'new' | 'edit'; id: number | null; content: string; saved: string;
  kind: EntryKind;
  clientId: ReturnType<typeof crypto.randomUUID>; requestId: ReturnType<typeof crypto.randomUUID>; revision: number | null;
  parentId: number | null; afterId: number | null; hiddenTag: string | null; tags: string[]; savedTags: string[];
};
type VerticalTarget = { x: number; direction: VerticalDirection };
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
  kind,
  afterId: afterId === undefined ? siblings(items, parentId).at(-1)?.id ?? null : afterId,
});

export function Outline({ kind, items, day, composer = false, archived = false, scope, refresh, notify }: Props) {
  const defaultKind: EntryKind = kind === 'mixed' ? 'notes' : kind;
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
  const [shifting, setShifting] = useState<'in' | 'out' | null>(null);
  const [, setSelectedAll] = useState(false);
  const selectionActive = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  const key = scope ? `still-outline-${kind}-${scope}` : kind === 'tasks' ? 'still-outline-tasks' : `still-draft-${day}`;
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
      if (stored && (stored.content !== stored.saved || JSON.stringify(stored.tags ?? []) !== JSON.stringify(stored.savedTags ?? [])) && typeof stored.content === 'string') {
        const row = items.find(item => item.id === stored.id);
        return { ...blank(items, true), ...stored, requestId: stored.requestId ?? crypto.randomUUID(), revision: stored.revision ?? row?.revision ?? null,
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
  const queue = useRef<Promise<number | null>>(Promise.resolve(null));
  const lock = useRef(false);
  const actionToken = useRef(0);
  const restoringFocus = useRef(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const previouslyComposer = useRef(composer);
  const persist = useCallback((next: Draft) => {
    current.current = next;
    if (next.active) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
    if (mounted.current) setDraft(next);
  }, [key]);
  useEffect(() => {
    const value = current.current;
    if (kind !== 'tasks' || !composer || !value.active || value.mode !== 'new' ||
        value.id !== null || value.parentId !== null || value.content.trim() || value.tags.length) return;
    const afterId = siblings(items, null).at(-1)?.id ?? null;
    if (value.afterId !== afterId) persist({ ...value, afterId });
  }, [items, kind, composer, persist]);
  const focus = () => {
    // A remounted editor can inherit DOM focus one frame before its intended
    // caret is restored. Temporarily remove that premature focus so a rapid
    // follow-up key cannot land at the editor's default edge.
    if ((pendingSelection.current || pendingVertical.current) && surface.current?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
    requestAnimationFrame(() => {
      if (selectionActive.current) { restoringFocus.current = false; return; }
      if (pendingVertical.current) input.current?.focusAt(pendingVertical.current.x, pendingVertical.current.direction, { preventScroll: false });
      else input.current?.focus({ preventScroll: false }, pendingSelection.current);
      if (pendingLinkEdit.current) input.current?.editLink();
      pendingSelection.current = undefined;
      pendingVertical.current = undefined;
      pendingLinkEdit.current = false;
      restoringFocus.current = false;
    });
  };
  const dismissEmptyDraft = () => {
    if (lock.current) return false;
    const snapshot = current.current;
    if (snapshot.id !== null || snapshot.content.trim() || snapshot.tags.length) return false;
    persist(blank(records.current, false));
    return true;
  };

  const save = useCallback(() => {
    const operation = queue.current.catch(() => null).then(async () => {
      let snapshot = current.current;
      if (!snapshot.active || snapshot.content === snapshot.saved && JSON.stringify(snapshot.tags) === JSON.stringify(snapshot.savedTags)) return snapshot.id;
      let announced = false;
      const feedback = setTimeout(() => {
        announced = true;
        window.dispatchEvent(new CustomEvent('still-save-state', { detail: 'saving' }));
      }, 450);
      setSaving(true);
      try {
        const edit = async (changes: (value: Draft) => Record<string, unknown>[]) => {
          try {
            return await editDocument(changes(snapshot), snapshot.clientId, snapshot.requestId);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409 || snapshot.id === null) throw error;
            await refresh();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const latest = records.current.find(item => item.id === snapshot.id);
            if (!latest || current.current.clientId !== snapshot.clientId) throw error;
            const group = siblings(records.current, latest.parent_id);
            const index = group.findIndex(item => item.id === latest.id);
            snapshot = {
              ...current.current,
              kind: entryKind(latest),
              revision: latest.revision,
              saved: latest.content,
              savedTags: latest.tags ?? [],
              parentId: latest.parent_id,
              afterId: group[index - 1]?.id ?? null,
              requestId: crypto.randomUUID(),
            };
            persist(snapshot);
            return editDocument(changes(snapshot), snapshot.clientId, snapshot.requestId);
          }
        };
        if (!snapshot.content.trim() && !snapshot.tags.length) {
          if (snapshot.id) {
            await edit(value => [{ kind: value.kind, id: value.id, delete: true, expected_revision: value.revision }]);
            setRemoved(previous => new Set([...previous, snapshot.id!]));
            if (current.current.clientId === snapshot.clientId) persist({ ...current.current, id: null, revision: null, requestId: crypto.randomUUID(), saved: '', savedTags: [] });
            await refresh();
          }
          setFailed(false);
          if (announced) window.dispatchEvent(new CustomEvent('still-save-state', { detail: 'saved' }));
          return null;
        }
        const [result] = await edit(value => [{
          kind: value.kind, id: value.id, content: value.content, tags: value.tags, date: day, client_id: value.clientId, parent_id: value.parentId, after_id: value.afterId,
          expected_revision: value.revision,
        }]);
        if (!result) throw new Error('The entry could not be saved.');
        if (snapshot.id === null) {
          setRemoved(previous => {
            if (!previous.has(result.id)) return previous;
            const next = new Set(previous); next.delete(result.id); return next;
          });
        }
        if (current.current.clientId === snapshot.clientId) persist({ ...current.current, id: result.id, revision: result.revision, requestId: crypto.randomUUID(), saved: snapshot.content, savedTags: snapshot.tags });
        if (snapshot.kind === 'tasks') localStorage.removeItem('still-task-draft');
        if (snapshot.id) localStorage.removeItem(`still-edit-${snapshot.kind}-${snapshot.id}`);
        setFailed(false);
        if (announced) window.dispatchEvent(new CustomEvent('still-save-state', { detail: 'saved' }));
        await refresh(); return result.id;
      } catch (error) {
        if (announced) window.dispatchEvent(new CustomEvent('still-save-state', { detail: 'clear' }));
        setFailed(true); notify(errorMessage(error)); throw error;
      }
      finally { clearTimeout(feedback); if (mounted.current) setSaving(false); }
    });
    queue.current = operation;
    return operation;
  }, [day, kind, notify, persist, refresh]);

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
      window.removeEventListener('focus', onFocus); window.removeEventListener('pagehide', flush);
      void save().catch(() => {});
    };
  }, [composer, kind, save]);

  const run = async (action: () => Promise<void>, restoreFocus = true) => {
    if (lock.current) return;
    const token = ++actionToken.current;
    lock.current = true; restoringFocus.current = restoreFocus; setBusy(true);
    try { await action(); }
    catch (error) { notify(errorMessage(error)); }
    finally {
      if (actionToken.current === token && mounted.current) {
        lock.current = false;
        flushSync(() => setBusy(false));
        if (restoreFocus) focus();
      }
    }
  };
  const select = (row: OutlineItem, element?: HTMLElement, contextLink?: HTMLElement, offsets?: TextOffsets, vertical?: VerticalTarget) => {
    if (!vertical) verticalX.current = null;
    const selection = offsets ?? selectedTextOffsets(element, contextLink);
    void run(async () => {
      await save();
      // Saving the previous draft can insert before this row and advance its
      // revision. Let the refresh commit, then resolve the row again instead
      // of opening the pre-save snapshot; otherwise the first edit is
      // guaranteed to conflict and cannot retry.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const latest = records.current.find(item => item.id === row.id);
      if (!latest) return;
      const group = siblings(records.current, latest.parent_id);
      const index = group.findIndex(item => item.id === latest.id);
      const content = latest.content;
      flushSync(() => persist({ ...blank(records.current, true), mode: 'edit', id: latest.id, content, saved: content,
        kind: entryKind(latest),
        revision: latest.revision,
        tags: latest.tags ?? [], savedTags: latest.tags ?? [], hiddenTag: activeTag && latest.tags?.includes(activeTag) ? activeTag : null,
        parentId: latest.parent_id, afterId: group[index - 1]?.id ?? null }));
      if (vertical) input.current?.focusAt(vertical.x, vertical.direction, { preventScroll: false });
      else input.current?.focus({ preventScroll: false }, selection);
      if (contextLink) input.current?.editLink();
      if (!surface.current?.contains(document.activeElement)) {
        pendingSelection.current = selection;
        pendingVertical.current = vertical;
        setTimeout(focus, 0);
      }
    }, false);
  };
  const move = async (outdent: boolean) => {
    const snapshot = current.current;
    const parent = records.current.find(item => item.id === snapshot.parentId);
    const group = siblings(records.current, snapshot.parentId).filter(item => item.id !== snapshot.id);
    const previous = snapshot.afterId !== null ? group.find(item => item.id === snapshot.afterId) : undefined;
    if (outdent ? !parent : !previous) return;
    const parentId = outdent ? parent!.parent_id : previous!.id;
    const afterId = outdent ? parent!.id : siblings(records.current, previous!.id).at(-1)?.id ?? null;
    const targetParent = parentId === null ? null : records.current.find(item => item.id === parentId);
    const targetKind: EntryKind = targetParent ? entryKind(targetParent) : defaultKind;
    let level = 1, ancestor = parentId;
    while (ancestor !== null) { level++; ancestor = records.current.find(item => item.id === ancestor)?.parent_id ?? null; }
    if (level > MAX_LEVELS) throw new Error(`Bullets support up to ${MAX_LEVELS} levels.`);
    if (snapshot.id === null) {
      setShifting(outdent ? 'out' : 'in');
      setTimeout(() => { if (mounted.current) setShifting(null); }, 240);
      flushSync(() => persist({ ...snapshot, kind: targetKind, parentId, afterId }));
      // A new draft has no server-side position to move yet. Keep indentation
      // immediate and persist the final parent when Enter or blur saves it.
      // Waiting on a create request here makes a quick Tab, Enter sequence lose
      // the Enter while the structural action still owns the mutation lock.
      // If the note autosave had already started, reconcile the just-created
      // row through the same save queue before a following Enter advances.
      const reconcile = queue.current.catch(() => null).then(async id => {
        const value = current.current;
        if (!id || value.clientId !== snapshot.clientId || value.parentId !== parentId || value.kind !== targetKind) return id;
        const [moved] = await editDocument([{ kind: snapshot.kind, id, move: true, parent_id: parentId, after_id: afterId, expected_revision: value.revision }]);
        if (moved && current.current.clientId === snapshot.clientId) {
          persist({ ...current.current, kind: targetKind, parentId, afterId, revision: moved.revision });
          await refresh();
        }
        return id;
      });
      queue.current = reconcile;
      return;
    } else {
      const id = await save();
      const [moved] = id ? await editDocument([{ kind: snapshot.kind, id, move: true, parent_id: parentId, after_id: afterId, expected_revision: current.current.revision }]) : [];
      setShifting(outdent ? 'out' : 'in');
      setTimeout(() => { if (mounted.current) setShifting(null); }, 240);
      lock.current = false;
      flushSync(() => { setBusy(false); persist({ ...current.current, kind: targetKind, parentId, afterId, revision: moved?.revision ?? current.current.revision }); });
    }
    await refresh();
  };
  const complete = (id: number) => void run(async () => {
    await save();
    const task = records.current.find(row => row.id === id)!;
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

  const beginBullet = () => void run(async () => {
    await save();
    lock.current = false;
    flushSync(() => { setBusy(false); persist(blank(records.current, true)); });
  });

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
  const boundary = (direction: 'backspace' | 'delete') => void run(async () => {
    const currentElement = surface.current?.querySelector('[contenteditable]')?.closest('li');
    const elements = [...document.querySelectorAll<HTMLElement>('li[data-outline-key][data-item-id]')].filter(el => el.offsetParent !== null && !el.closest('[aria-hidden="true"]') && el.dataset.done !== 'true');
    const index = elements.findIndex(el => el === currentElement);
    const backwards = direction === 'backspace';
    const adjacent = elements[index + (backwards ? -1 : 1)];
    if (!adjacent || adjacent.dataset.outlineKey !== key) {
      if (direction === 'backspace' && !current.current.content.trim() && !current.current.tags.length) {
        await save(); persist(blank(records.current, false));
      }
      return;
    }
    const id = adjacent.dataset.itemId === 'draft' ? null : Number(adjacent.dataset.itemId);
    if (id === null) return;
    const other = records.current.find(row => row.id === id);
    if (!other) return;
    const snapshot = current.current;
    const ownId = await save();
    if (!ownId) {
      pendingSelection.current = { anchor: markdownText(other.content).length, head: markdownText(other.content).length };
      // Do not expose the remounted editor as focused before focus() restores
      // its end caret. Otherwise a very fast Backspace can land at position 0
      // and be mistaken for another cross-entry merge.
      (document.activeElement as HTMLElement | null)?.blur();
      flushSync(() => persist({ ...blank([], true), kind: entryKind(other), mode: 'edit', id: other.id, content: other.content, saved: other.content,
        tags: other.tags ?? [], savedTags: other.tags ?? [], parentId: other.parent_id }));
      return;
    }
    const own = { ...other, id: ownId, kind: snapshot.kind, content: snapshot.content, tags: snapshot.tags, revision: current.current.revision ?? other.revision };
    const first = backwards ? other : own;
    const second = backwards ? own : other;
    const content = mergeMarkdown(first.content, second.content), tags = [...new Set([...first.tags ?? [], ...second.tags ?? []])];
    const [result] = await editDocument([
      { kind: entryKind(first), id: first.id, content, tags, expected_revision: first.revision },
      { kind: entryKind(second), id: second.id, delete: true, expected_revision: second.revision },
    ]);
    if (!result) return;
    persist({ ...blank([], true), kind: entryKind(first), mode: 'edit', id: result.id, content, saved: content, tags, savedTags: tags, parentId: result.parent_id });
    pendingSelection.current = { anchor: markdownText(first.content).length, head: markdownText(first.content).length };
    await refresh();
  }, direction === 'backspace' || direction === 'delete');
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
    const progressTask = rowKind === 'tasks' && !row?.completed_at;
    return <Disclosure type="button" data-focus-chrome $open={open} $task={progressTask} $progress={childCount ? doneCount / childCount : 0} disabled={busy} aria-expanded={open}
      aria-description={progressTask ? `${doneCount} of ${childCount} children completed` : undefined}
      aria-label={`${pinned ? 'Collapse' : 'Expand'} ${markdownText(content) || 'bullet'}`}
      onPointerEnter={event => {
        if (!pinned && event.pointerType !== 'touch') setPreviewed(previous => previous.has(id) ? previous : new Set([...previous, id]));
      }} onClick={() => void run(async () => {
        if (pinned) {
          await save();
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
      }, false)} />;
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
  const advance = () => {
    if (!current.current.content.trim() && !current.current.tags.length && current.current.id !== null) {
      persist({ ...current.current, content: '', tags: [] });
    }
    if (!current.current.content.trim() && !current.current.tags.length && current.current.id === null) {
      if (current.current.parentId !== null) void run(() => move(true));
      return;
    }
    void run(async () => {
      const split = input.current?.splitAtSelection();
      const hiddenTag = current.current.hiddenTag ?? (activeTag && current.current.savedTags.includes(activeTag) ? activeTag : null);
      const keepHiddenTag = (content: string, tags: string[], value = hiddenTag) =>
        [...new Set([...tags, ...(value && (content.trim() || tags.length) ? [value] : [])])];
      if (split) persist({ ...current.current, content: split.before.content, tags: keepHiddenTag(split.before.content, split.before.tags) });
      const snapshot = current.current;
      let id = await save();
      // The editor stays responsive while a request is in flight. If the
      // user typed more, acknowledge that newer revision before Enter
      // advances to the next row; never clear unacknowledged text.
      if (current.current.clientId === snapshot.clientId &&
          (current.current.content !== current.current.saved || JSON.stringify(current.current.tags) !== JSON.stringify(current.current.savedTags))) {
        id = await save();
      }
      const parent = snapshot.parentId === null ? null : records.current.find(item => item.id === snapshot.parentId);
      const nextKind = parent ? entryKind(parent) : defaultKind;
      const next = id ? blank(records.current, true, snapshot.parentId, id, nextKind) : blank(records.current, composer);
      const splitDraft = split?.after.content || split?.after.tags.length
        ? { ...next, content: split.after.content, tags: keepHiddenTag(split.after.content, split.after.tags, next.hiddenTag) }
        : next;
      if (split?.after.content || split?.after.tags.length) pendingSelection.current = { anchor: 0, head: 0 };
      // Make the next rendered row interactive immediately. Otherwise a
      // very fast click can land between this render and run()'s finally.
      lock.current = false;
      flushSync(() => persist(splitDraft));
    });
  };
  const renderDraft = (depth: number): ReactNode => <DraftItem key="draft" data-depth={depth}
    data-outline-key={key} data-kind={draft.kind} data-item-id={draft.id ?? 'draft'}
    onPointerLeave={() => clearPreview(draft.id)}
    $emptyTask={draft.kind === 'tasks' && draft.id === null && !draft.content.trim() && !draft.tags.length}
    $shifting={shifting}
    $leaving={completing === draft.id && completing !== null}>
    <Row aria-busy={saving}>{renderMarker(draft.id, draft.content)}<RichTextEditor key={draft.clientId} ref={input} label={archived && draft.kind === 'tasks' && draft.parentId !== null && draft.mode === 'new' ? 'New completed subtask' : inputLabel} value={draft.content} tags={draft.tags.filter(tag => tag !== activeTag)} readOnly={false}
      onBoundary={boundary} onVerticalBoundary={verticalBoundary} onSelectDocument={selectDocument}
      onEnter={advance}
      onChange={(content, tags) => {
        verticalX.current = null;
        const hiddenTag = current.current.hiddenTag ?? (activeTag && current.current.savedTags.includes(activeTag) ? activeTag : null);
        persist({ ...current.current, content, tags: [...new Set([...tags, ...(hiddenTag && (content.trim() || tags.length) ? [hiddenTag] : [])])] });
      }}
      onBlur={event => {
        const blurredClientId = draft.clientId;
        // Enter and nesting can remount the editor before its next-frame focus.
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
          if (event.shiftKey && current.current.parentId === null) return;
          event.preventDefault();
          // Read ProseMirror's selection before moving the row. The browser's
          // DOM selection can briefly point at the remounted editor instead.
          const indentSelection = input.current?.selection() ?? selectedTextOffsets(event.currentTarget as HTMLElement);
          // Draft indentation is entirely local and synchronous; it must not
          // take the async mutation lock because Enter commonly follows Tab in
          // the same typing cadence.
          if (current.current.id === null) {
            // Moving the draft remounts its editor. Protect an empty draft
            // from being mistaken for an abandoned one during that blur.
            restoringFocus.current = true;
            const emptyDraft = !current.current.content.trim() && !current.current.tags.length;
            void move(event.shiftKey);
            if (emptyDraft) {
              // There is no save to reconcile. Restore the remounted editor on
              // the next frame without an extra blur that could discard it.
              pendingSelection.current = indentSelection;
              focus();
            } else {
              // A note autosave may already be in flight and reconcile this row
              // after the immediate local move. Restore once more after that
              // refresh so it cannot reset the caret to the start.
              (document.activeElement as HTMLElement | null)?.blur();
              void queue.current.finally(() => { pendingSelection.current = indentSelection; focus(); });
            }
          } else {
            void run(async () => { await move(event.shiftKey); pendingSelection.current = indentSelection; });
            // Do not expose the remounted editor as focused until run() can
            // restore both focus and the saved caret after the server move.
            (document.activeElement as HTMLElement | null)?.blur();
          }
        } else if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          advance();
        } else if (event.key === 'Backspace' && current.current.mode === 'new' && !current.current.content && !current.current.tags.length && !current.current.id) {
          event.preventDefault(); dismissEmptyDraft();
        } else if (event.key === 'Escape' && draft.mode === 'edit') {
          event.preventDefault(); persist(blank(records.current, composer)); focus();
        }
      }} /></Row>
    {failed && <TextButton onClick={() => void run(async () => { await save(); })}>Retry saving</TextButton>}
    {draft.id !== null && <Branch data-branch-for={draft.id} $open={isExpanded(draft.id)} aria-hidden={!isExpanded(draft.id)}>{renderChildren(draft.id, depth + 1)}</Branch>}
  </DraftItem>;

  const renderChildren = (parentId: number | null, depth: number): ReactNode => {
    const group: (OutlineItem | null)[] = sorted(items.filter(item => !removed.has(item.id) &&
      (item.parent_id !== null && !items.some(parent => parent.id === item.parent_id) ? null : item.parent_id) === parentId
    )).filter(item => !draft.active || item.id !== draft.id);
    const draftParent = draft.parentId !== null && !items.some(row => row.id === draft.parentId) ? null : draft.parentId;
    if (draft.active && draftParent === parentId) {
      let index = draft.afterId !== null ? group.findIndex(item => item?.id === draft.afterId) + 1 : -1;
      if (index < 1) {
        const original = items.find(item => item.id === draft.id && item.parent_id === parentId);
        index = original ? group.filter(item => item && (item.position < original.position || item.position === original.position && item.id < original.id)).length : group.length;
      }
      group.splice(index, 0, null);
    }
    if (!group.length) return null;
    const content = group.map(item => item === null ? renderDraft(depth) : <Item key={item.id} data-outline-key={key} data-done={!!item.completed_at && !archived} data-kind={entryKind(item)} data-item-id={item.id} data-depth={depth} $leaving={completing === item.id}
      onPointerLeave={() => clearPreview(item.id)}
      $arriving={entryKind(item) === 'tasks' && (completed.has(item.id) || reopened.has(item.id))}>
      <Row>{renderMarker(item.id, item.content)}<Text $done={!!item.completed_at && !archived} $action={archived && entryKind(item) === 'tasks'} role="group" tabIndex={0} aria-label={markdownText(item.content) || (item.tags ?? []).filter(tag => tag !== activeTag).map(tag => '#' + tag).join(' ')}
        onClick={event => { if ((archived || !item.completed_at) && !(event.target as HTMLElement).closest('a')) select(item, event.currentTarget); }}
        onContextMenu={event => {
          const link = (event.target as HTMLElement).closest('a');
          if (link && (archived || !item.completed_at)) { event.preventDefault(); select(item, event.currentTarget, link); }
        }}
        onKeyDown={event => { if ((archived || !item.completed_at) && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(item); } }}
      ><MarkdownContent content={item.content} tags={activeTag ? item.tags?.filter(tag => tag !== activeTag) : item.tags} /></Text>
      </Row>
      <Branch data-branch-for={item.id} $open={isExpanded(item.id)} aria-hidden={!isExpanded(item.id)}>{renderChildren(item.id, depth + 1)}</Branch>
    </Item>);
    const parent = parentId === null ? null : items.find(item => item.id === parentId);
    return parentId === null ? <List>{content}</List> : <Children $task={parent ? entryKind(parent) === 'tasks' : draft.kind === 'tasks'}>{content}</Children>;
  };
  return <OutlineSurface ref={surface} data-outline-kind={defaultKind} tabIndex={-1} onPointerDown={() => { verticalX.current = null; selectionActive.current = false; setSelectedAll(false); }} onCopyCapture={event => {
    if (!selectionActive.current) return;
    event.preventDefault(); event.stopPropagation(); copyDocument(event.clipboardData);
  }} onCutCapture={event => { if (selectionActive.current) { event.preventDefault(); event.stopPropagation(); copyDocument(event.clipboardData); replaceDocument(); } }}
  onPasteCapture={event => { if (selectionActive.current) { event.preventDefault(); event.stopPropagation(); replaceDocument(event.clipboardData.getData('text/plain'), event.clipboardData.getData('text/html')); } }} onKeyDownCapture={event => {
    if (!selectionActive.current || event.defaultPrevented) return;
    event.stopPropagation();
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); return; }
    if (mod && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); void documentUndo(event.shiftKey || event.key.toLowerCase() === 'y').catch(e => notify(errorMessage(e))); return; }
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
