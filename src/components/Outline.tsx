import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link2 } from 'lucide-react';
import { flushSync } from 'react-dom';
import { useJournalContext } from '../JournalContext';
import type { EntryDocument, EntryKind, OutlineItem } from '../types';
import { VisuallyHidden } from '../styles';
import { MarkdownContent, documentWithTags, entryText, formatDocument, markdownText, mergeEntries, pastedEntry, replaceEntryRange, serializeEntry, withTags } from '../markdown';
import { RichTextEditor, type RichTextHandle, type TextOffsets, type VerticalDirection } from './RichTextEditor';
import { documentUndo, editDocument, historyShortcutDirection } from '../documentHistory';
import { useEntryGestures, type EntrySelection } from '../useEntryGestures';
import { OutlineDocument } from '../outlineDocument';
import { entryError } from '../entryFeedback';
import { entryLinkUrl } from '../entryLinks';
import { endEntryDrag, entryDragLeft, incomingEntryDrag, moveEntryToDay, startEntryDrag, takeEntryDrag, type DragPlacement, type EntryDrag } from '../entryDrag';
import { domTextOffset } from '../textSelection';
import { LOG_WASH_HEIGHT } from '../layout';
import { selectedEntryRanges, spannedEntries } from '../entrySelection';
import { copySpannedDays, markdownBullet } from '../journalClipboard';
import { useRangeEditing } from '../useRangeEditing';
import { useTaskCompletion } from '../useTaskCompletion';
import { useOutlineDraft } from '../useOutlineDraft';
import { hasDraftChanges, type Draft } from '../entryDrafts';
import { ancestorIds, branchIds, checkEntryDepth, orderedEntries as sorted, siblingEntries as siblings } from '../entryTree';
import type { DocumentChange, OutlineChange } from '../entryChanges';
import { formattingShortcut, type EntryFormat } from '../entryFormatting';
import { OutlineSurface, List, Children, Row, Item, Branch, ComposerTarget, LinkCopy, Marker, DraftItem, Checkbox, Disclosure, Text, BRANCH_OPEN_MS, DEPART_MS, FILE_FADE_MS, FILE_PAUSE_MS } from './OutlineStyles';

type VerticalTarget = { x: number; direction: VerticalDirection };
// The branch easing, cubic-bezier(.2, 0, 0, 1), so anything moving alongside a
// branch as it grows travels on the same curve instead of its own.
function branchEasing(elapsed: number): number {
  const curve = (first: number, second: number, step: number) => {
    const rest = 1 - step;
    return 3 * rest * rest * step * first + 3 * rest * step * step * second + step * step * step;
  };
  let low = 0, high = 1, step = elapsed;
  for (let attempt = 0; attempt < 20; attempt++) {
    const position = curve(.2, 0, step);
    if (Math.abs(position - elapsed) < .0005) break;
    if (position < elapsed) low = step; else high = step;
    step = (low + high) / 2;
  }
  return curve(0, 1, step);
}
type Props = {
  kind: EntryKind | 'mixed'; items: OutlineItem[]; day?: string; composer?: boolean;
  archived?: boolean; scope?: string;
  refresh: () => Promise<void>;
};
function selectedTextOffsets(element?: HTMLElement, link?: HTMLElement): TextOffsets | undefined {
  if (element && link) {
    const range = document.createRange();
    range.selectNodeContents(element); range.setEndBefore(link);
    const anchor = domTextOffset(element, range.endContainer, range.endOffset);
    return { anchor, head: domTextOffset(element, link, link.childNodes.length) };
  }
  const selection = window.getSelection();
  if (!element || !selection?.anchorNode || !selection.focusNode ||
      !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return;
  return {
    anchor: domTextOffset(element, selection.anchorNode, selection.anchorOffset),
    head: domTextOffset(element, selection.focusNode, selection.focusOffset),
  };
}

// The pane an entry scrolls within: the log, the task list, or a pane of the
// mobile pager, whichever is carrying it.
function scrollingParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return null;
}

export function Outline({ kind, items: serverItems, day, composer = false, archived = false, scope, refresh }: Props) {
  const defaultKind: EntryKind = kind === 'mixed' ? 'notes' : kind;
  const key = scope ? `still-outline-${kind}-${scope}` : kind === 'tasks' ? 'still-outline-tasks' : `still-draft-${day}`;
  const [documentStore] = useState(() => new OutlineDocument(key));
  const [, renderDocument] = useState(0);
  const { activeTag, completed, onComplete, reopened, onReopen, target } = useJournalContext();
  // A task given its first tag is filed under it, and the list of untagged
  // tasks no longer carries it once the save comes back. It keeps its place
  // while the reader is still with it, and goes only once they have moved on.
  const files = kind === 'tasks' && !archived && !activeTag;
  const filed = useRef(new Map<number, OutlineItem[]>());
  const live = documentStore.rebase(serverItems);
  for (const [id, branch] of filed.current) {
    const resolved = documentStore.resolve(id)!;
    if (live.some(row => row.id === resolved)) {
      const ids = branchIds(live, resolved);
      filed.current.set(id, live.filter(row => ids.has(row.id)));
    } else if (!branch.length) filed.current.delete(id);
  }
  const lingering = [...filed.current.values()].flat().filter(row => !live.some(item => item.id === row.id));
  const items = lingering.length ? [...live, ...lingering] : live;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // A filtered view hides the tag it filters by, in the text and as a bubble:
  // an entry leaves that view by being deleted from it, not by losing the tag
  // inline. Every other tag stays visible and editable.
  const hiddenTagsFor = (tags: string[] | undefined) =>
    activeTag && (tags ?? []).includes(activeTag) ? [activeTag] : [];
  const [removed, setRemoved] = useState(new Set<number>());
  // An entry that has lost the tag filing it fades before its row is dropped,
  // so leaving a filtered view reads as an answer rather than a disappearance.
  const [departing, setDeparting] = useState(new Set<number>());
  const depart = useCallback((id: number) => {
    setDeparting(rows => new Set([...rows, id]));
    window.setTimeout(() => {
      setRemoved(rows => new Set([...rows, id]));
      setDeparting(rows => { const next = new Set(rows); next.delete(id); return next; });
    }, DEPART_MS);
  }, []);
  const [, refile] = useState(0);
  const fileTimers = useRef(new Map<number, number>());
  const file = useCallback((id: number) => {
    if (!files || filed.current.has(id)) return;
    filed.current.set(id, []);
    refile(count => count + 1);
  }, [files]);
  const { blank, draft, current, records, persist, stageDraft, save, saving } = useOutlineDraft({
    key, documentStore, items, defaultKind, composer, day, activeTag, onUnfiled: depart, onFiled: file,
  });
  // Once the reader has left the task, it rests a moment, fades, and then the
  // rows beneath close over the space it held.
  const fileAway = useCallback((id: number) => {
    fileTimers.current.delete(id);
    const resolved = documentStore.resolve(id)!;
    const finish = () => {
      filed.current.delete(id);
      setRemoved(rows => new Set([...rows, resolved]));
    };
    // The tag was taken back off before it went, so the task stays.
    if (!itemsRef.current.find(row => row.id === resolved)?.tags?.length) {
      filed.current.delete(id); refile(count => count + 1); return;
    }
    const row = surface.current?.querySelector<HTMLElement>(`li[data-item-id="${resolved}"]`);
    if (!row) { finish(); return; }
    const height = `${row.offsetHeight}px`;
    row.style.overflow = 'hidden';
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.animate([
      { opacity: 1, height },
      { opacity: 0, height, offset: .6 },
      { opacity: 0, height: '0px' },
    ], { duration: still ? 1 : FILE_FADE_MS, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }).finished.then(finish, finish);
  }, [documentStore]);
  useEffect(() => {
    for (const id of filed.current.keys()) {
      const branch = filed.current.get(id)!;
      const resolved = documentStore.resolve(id);
      const editing = draft.active && [draft.id, draft.parentId].some(entry => {
        const at = documentStore.resolve(entry);
        return at !== null && (at === resolved || branch.some(row => row.id === at));
      });
      const timer = fileTimers.current.get(id);
      if (editing) {
        if (timer !== undefined) { clearTimeout(timer); fileTimers.current.delete(id); }
      } else if (timer === undefined) fileTimers.current.set(id, window.setTimeout(() => fileAway(id), FILE_PAUSE_MS));
    }
  });
  useEffect(() => () => { for (const timer of fileTimers.current.values()) clearTimeout(timer); }, []);
  const draftHiddenTags = (value: Draft) =>
    value.hiddenTags.length || !activeTag || !value.savedTags.includes(activeTag) ? value.hiddenTags : [activeTag];
  const [expanded, setExpanded] = useState(new Set<number>());
  const [previewed, setPreviewed] = useState(new Set<number>());
  const seenCompleted = useRef(new Set<number>());
  const [collapsed, setCollapsed] = useState(() => {
    const initial = new Set(archived ? items.filter(row => row.kind === 'tasks' && !!row.completed_at).map(row => row.id) : []);
    seenCompleted.current = new Set(initial);
    return initial;
  });
  const [suppressedPreviews, setSuppressedPreviews] = useState(new Set<number>());
  const previewSuppressedAt = useRef(new Map<number, number>());
  const [entrySelection, setEntrySelection] = useState<EntrySelection | null>(null);
  const entrySelectionRef = useRef<EntrySelection | null>(null);
  const updateEntrySelection = (next: EntrySelection | null) => {
    entrySelectionRef.current = next;
    setEntrySelection(next);
  };
  // A press anywhere else on the page lets the entry go, including presses in
  // another outline or on the page chrome, which never reach this surface.
  useEffect(() => {
    const key = entrySelection?.key;
    if (!key) return;
    const dismiss = (event: PointerEvent) => {
      const entry = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-entry-gesture-key]') : null;
      if (entry?.dataset.entryGestureKey !== key) updateEntrySelection(null);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [entrySelection?.key]);
  // A shortcut over a selection that spans entries applies to all of them. The
  // rows are read when the key is pressed, so ordinary typing costs nothing.
  const spannedRows = () => {
    const ids = new Set(spannedEntries(key).map(range => Number(range.id)).filter(id => !Number.isNaN(id)));
    return ids.size ? records.current.filter(row => ids.has(row.id)) : [];
  };
  // A child travels with its parent, and mixed levels have no shared move.
  const movableGroup = (rows: OutlineItem[]) => {
    const ids = new Set(rows.map(row => row.id));
    const roots = sorted(rows.filter(row => !ancestorIds(records.current, row.parent_id).some(id => ids.has(id))));
    return roots.length && roots.every(row => row.parent_id === roots[0].parent_id) ? roots : [];
  };
  const shiftGroup = (rows: OutlineItem[], outdent: boolean) => {
    const group = movableGroup(rows);
    if (!group.length) return;
    try {
      stageDraft();
      const siblingRows = siblings(records.current, group[0].parent_id);
      const index = siblingRows.findIndex(row => row.id === group[0].id);
      const destination = moveDestination({ id: group[0].id, parentId: group[0].parent_id, afterId: siblingRows[index - 1]?.id ?? null }, outdent);
      if (!destination) return;
      for (const row of group) checkDepth(row.id, destination.parentId);
      let afterId = destination.afterId;
      const changes: OutlineChange[] = group.map(row => {
        const change: OutlineChange = { kind: row.kind, id: row.id, type: 'move',
          parent_id: destination.parentId, after_id: afterId, target_kind: destination.targetKind };
        afterId = row.id;
        return change;
      });
      if (destination.parentId !== null) setExpanded(previous => new Set([...previous, destination.parentId!]));
      documentStore.enqueue(changes);
      void documentStore.flush().catch(() => {});
    } catch (error) { entryError(error, surface.current?.querySelector(`[data-item-id="${group[0].id}"]`)); }
  };
  const formatGroup = (rows: OutlineItem[], format: EntryFormat) => void run(async () => {
    await save();
    await editDocument(rows.map(row => {
      const document = formatDocument(documentOf(row), format);
      return { kind: row.kind, id: row.id, document, ...serializeEntry(document) };
    }));
    await refresh();
  }, false);
  const draggedEntry = useRef<number | null>(null);
  const dropTarget = useRef<HTMLElement | null>(null);
  const [, setSelectedAll] = useState(false);
  const selectionActive = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const completedIds = new Set(archived ? items.filter(row => row.kind === 'tasks' && !!row.completed_at).map(row => row.id) : []);
    const newlyCompleted = [...completedIds].filter(id => !seenCompleted.current.has(id));
    seenCompleted.current = completedIds;
    setCollapsed(previous => {
      const next = new Set([...previous].filter(id => completedIds.has(id)));
      newlyCompleted.forEach(id => next.add(id));
      return next.size === previous.size && [...next].every(id => previous.has(id)) ? previous : next;
    });
  }, [items, archived]);
  useLayoutEffect(() => {
    if (!target || kind !== 'mixed' && target.kind !== kind) return;
    let settling = 0;
    const item = records.current.find(row => row.id === target.id);
    if (!item) return;
    const parents = ancestorIds(records.current, item.parent_id);
    setExpanded(previous => new Set([...previous, ...parents]));
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-kind="${target.kind}"][data-item-id="${target.id}"] [role="group"]`);
      if (!row) return;
      // The entry led to leads: it comes to rest at the top of the view, just
      // clear of the wash, and the page travels the last of the way there
      // rather than cutting to it.
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const pane = scrollingParent(row);
      row.focus({ preventScroll: true });
      if (!pane) { row.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' }); return; }
      // The page keeps growing underneath this: the day arrives, and the days
      // around it load as the view passes them, so where the entry sits is not
      // yet settled. The aim is taken again until it is, each correction a
      // short one, so the arrival reads as a single movement.
      let aimed = 0;
      const aim = () => {
        const offset = row.getBoundingClientRect().top - pane.getBoundingClientRect().top - LOG_WASH_HEIGHT;
        const rest = Math.max(0, Math.min(pane.scrollTop + offset, pane.scrollHeight - pane.clientHeight));
        if (Math.abs(rest - pane.scrollTop) > 1) {
          if (still) pane.scrollTop = rest;
          else {
            // Years of logbook is too far to travel over, so the page is put
            // within a screen of the entry first and glides the rest: the
            // reader always sees the same short arrival, from the side the
            // entry is coming from.
            const approach = pane.clientHeight * .85;
            if (!aimed) pane.scrollTop = rest > pane.scrollTop
              ? Math.max(pane.scrollTop, rest - approach)
              : Math.min(pane.scrollTop, rest + approach);
            pane.scrollTo({ top: rest, behavior: 'smooth' });
          }
        }
        if (++aimed < 5) settling = window.setTimeout(aim, 420);
      };
      aim();
    }));
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settling); };
  }, [target, kind]);
  const mounted = useRef(true);
  const input = useRef<RichTextHandle>(null);
  const pendingSelection = useRef<TextOffsets | undefined>(undefined);
  const pendingVertical = useRef<VerticalTarget | undefined>(undefined);
  const arriving = useRef<number | null>(null);
  const verticalX = useRef<number | null>(null);
  const pendingLinkEdit = useRef(false);
  const lock = useRef(false);
  const actionToken = useRef(0);
  const restoringFocus = useRef(false);
  const [busy, setBusy] = useState(false);
  const focus = () => {
    if (selectionActive.current) { restoringFocus.current = false; return; }
    // A new entry seeded with a filtered view's tag starts in front of it, so
    // the first letter goes before the tag rather than behind it.
    const seeded = current.current;
    if (!pendingSelection.current && seeded.id === null && seeded.hiddenTags.length
      && !entryText(documentOf(seeded)).trim()) pendingSelection.current = { anchor: 0, head: 0 };
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
    // Nothing written, and no tag the reader put there: a filtered view's own
    // tag is seeded into every new entry and does not make one worth keeping.
    const typed = snapshot.tags.filter(tag => !snapshot.hiddenTags.includes(tag));
    if (snapshot.id !== null || entryText(documentOf(snapshot)).trim() || typed.length) return false;
    persist(blank(records.current, false));
    return true;
  };
  // A filtered view's own tag shows only while the entry is open, so an entry
  // that has lost the caret closes rather than sitting open with the tag
  // showing. Saved and unchanged, so closing it keeps nothing back.
  const releaseOpenEntry = () => {
    if (lock.current || !activeTag) return false;
    const snapshot = current.current;
    if (!snapshot.active || snapshot.mode !== 'edit' || snapshot.id === null || hasDraftChanges(snapshot)) return false;
    persist(blank(records.current, composer));
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
    setExpanded(remap); setCollapsed(remap); setPreviewed(remap); setRemoved(remap); setDeparting(remap);
  };
  documentStore.failed = (error, ids) => {
    for (const id of ids) entryError(error, surface.current?.querySelector<HTMLElement>(`[data-item-id="${id}"]`));
  };
  const { complete, completing, pendingCompletion } = useTaskCompletion({
    document: documentStore, rows: () => records.current, locked: () => lock.current,
    save, refresh, activeId: () => current.current.id,
    clearActive: () => { stageDraft(); persist(blank(records.current, composer)); },
    onComplete, onReopen,
    onError: (error, id) => entryError(error, surface.current?.querySelector(`[data-item-id="${id}"]`)),
  });
  useEffect(() => {
    const applied = () => {
      selectionActive.current = false; setSelectedAll(false); setRemoved(new Set()); setDeparting(new Set()); persist(blank([], composer));
    };
    window.addEventListener('still-history-applied', applied);
    return () => window.removeEventListener('still-history-applied', applied);
  }, [composer, persist]);
  useEffect(() => {
    mounted.current = true;
    // The composer takes the caret when nothing else holds it. Claiming it
    // while the reader has something selected over the page would take that
    // selection away; a selection inside an editor is only its own caret.
    const written = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      return !element?.closest('[contenteditable="true"]');
    };
    const unselected = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return true;
      return !(written(selection.anchorNode) && written(selection.focusNode));
    };
    const claim = () => {
      if (!mounted.current || defaultKind !== 'notes' || !composer) return;
      if (document.querySelector('dialog[open]') || !unselected()) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      input.current?.focus({ preventScroll: true });
    };
    // The window coming back is not itself a free caret. The browser says so
    // before it has given focus back to whatever was holding it, so what was
    // holding it is remembered as it goes: the caret returns to the entry the
    // reader left it in, and the composer claims nothing.
    let held: Element | null = null;
    const onBlur = () => { held = document.activeElement; };
    const onFocus = () => {
      const returning = held && held !== document.body && held.isConnected;
      held = null;
      if (!returning) claim();
    };
    // What holds the caret now, if it is anything the reader chose. A rebuilt
    // view must not take it off an entry or a field: those keep it, and the
    // composer goes without.
    const chosen = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) return null;
      return active.closest('[data-outline-key], [contenteditable], input, textarea, dialog') ? 'keeps' : active;
    };
    let waiting: HTMLElement | null = null;
    let release: (() => void) | null = null;
    let pending = 0;
    const frame = requestAnimationFrame(() => {
      const holder = chosen();
      if (holder === null) { claim(); return; }
      if (holder === 'keeps') return;
      // A page control still holds the caret, the tag rail that was just used
      // among them. It is waited out rather than talked over: the panel closes,
      // the control lets go, and the composer is ready without having taken
      // anything from the reader.
      waiting = holder;
      release = () => { pending = requestAnimationFrame(claim); };
      waiting.addEventListener('blur', release, { once: true });
    });
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      mounted.current = false; cancelAnimationFrame(frame); cancelAnimationFrame(pending);
      window.removeEventListener('blur', onBlur);
      if (waiting && release) waiting.removeEventListener('blur', release);
      window.removeEventListener('focus', onFocus);
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
    flushSync(() => persist({ ...blank(records.current, true), mode: 'edit', id: row.id, content: row.content, saved: row.content, document: row.document ?? null,
      kind: row.kind, revision: row.revision, tags: row.tags ?? [], savedTags: row.tags ?? [],
      hiddenTags: hiddenTagsFor(row.tags),
      parentId: row.parent_id, afterId: group[index - 1]?.id ?? null, beforeId: index === 0 ? group[1]?.id : null }));
    pendingSelection.current = selection;
    pendingVertical.current = vertical;
    focus();
  };
  // An entry dropped in from another day is only in this outline's items once
  // the refreshed journal has rendered. Resume editing it there.
  useLayoutEffect(() => {
    if (arriving.current === null) return;
    const row = records.current.find(item => item.id === arriving.current);
    if (!row) return;
    arriving.current = null;
    activate(row);
    input.current?.selectEntry();
  }, [items]);
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
  const documentOf = (row: { document?: EntryDocument | null; content: string; tags?: string[] }) =>
    row.document ?? documentWithTags(row.content, row.tags ?? []);
  const checkDepth = (id: number | null, parentId: number | null) => checkEntryDepth(records.current, id, parentId);
  const moveDestination = (snapshot: { id: number | null; parentId: number | null; afterId: number | null }, outdent: boolean) => {
    const parent = records.current.find(item => item.id === snapshot.parentId);
    const group = siblings(records.current, snapshot.parentId);
    const index = group.findIndex(item => item.id === snapshot.id);
    const previous = index >= 0 ? group[index - 1] : group.find(item => item.id === snapshot.afterId);
    if (outdent ? !parent : !previous) return null;
    const parentId = outdent ? parent!.parent_id : previous!.id;
    const afterId = outdent ? parent!.id : siblings(records.current, previous!.id).at(-1)?.id ?? null;
    const targetParent = parentId === null ? null : records.current.find(item => item.id === parentId);
    const targetKind: EntryKind = targetParent ? targetParent.kind : defaultKind;
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
      if (id !== null) documentStore.enqueue([{ kind: snapshot.kind, id, type: 'move', parent_id: parentId, after_id: afterId, target_kind: targetKind }]);
    }
    restoringFocus.current = true;
    flushSync(() => {
      if (parentId !== null) setExpanded(previous => new Set([...previous, parentId]));
      persist({ ...current.current, kind: targetKind, parentId, afterId, beforeId: null, placement: 'after' });
    });
    void documentStore.flush().catch(() => {});
  };
  const beginEntry = () => {
    void save().catch(() => {});
    restoringFocus.current = true;
    flushSync(() => persist(blank(records.current, true)));
    focus();
  };

  const navigateBoundary = (direction: VerticalDirection | 'left' | 'right', measuredX?: number) => {
    if (lock.current) return false;
    const currentElement = surface.current?.querySelector('[contenteditable]')?.closest<HTMLElement>('li[data-outline-key]');
    if (!currentElement) return false;
    const elements = [...document.querySelectorAll<HTMLElement>('li[data-outline-key][data-item-id]')]
      .filter(element => element.offsetParent !== null && getComputedStyle(element).visibility !== 'hidden' &&
        !element.closest('[aria-hidden="true"]') && element.dataset.done !== 'true');
    const index = elements.indexOf(currentElement);
    if (index < 0) return false;
    const step = direction === 'up' || direction === 'left' ? -1 : 1;
    let adjacent = elements[index + step];
    while (adjacent?.dataset.itemId === 'draft') adjacent = elements[elements.indexOf(adjacent) + step];
    if (!adjacent) { verticalX.current = null; return false; }
    const id = Number(adjacent.dataset.itemId);
    const outlineKey = adjacent.dataset.outlineKey;
    if (!Number.isInteger(id) || !outlineKey) { verticalX.current = null; return false; }
    const vertical = (direction === 'up' || direction === 'down') && measuredX !== undefined
      ? { x: verticalX.current ?? measuredX, direction } : undefined;
    const offset = direction === 'left' ? Number.MAX_SAFE_INTEGER : 0;
    void save().catch(() => {});
    window.dispatchEvent(new CustomEvent('still-entry-navigation', { detail: {
      key: outlineKey, id, vertical, selection: vertical ? undefined : { anchor: offset, head: offset },
    } }));
    return true;
  };

  useEffect(() => {
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; id: number; vertical?: VerticalTarget; selection?: TextOffsets }>).detail;
      if (!detail || detail.key !== key) return;
      const row = records.current.find(item => item.id === detail.id);
      if (!row) return;
      verticalX.current = detail.vertical?.x ?? null;
      select(row, undefined, undefined, detail.selection, detail.vertical);
    };
    window.addEventListener('still-entry-navigation', navigate);
    return () => window.removeEventListener('still-entry-navigation', navigate);
  });

  useEffect(() => {
    const append = (event: Event) => { if ((event as CustomEvent<string>).detail === key) beginEntry(); };
    window.addEventListener('still-new-entry', append);
    return () => window.removeEventListener('still-new-entry', append);
  });
  const adjacentEntry = (backwards: boolean) => {
    const currentElement = surface.current?.querySelector('[contenteditable]')?.closest('li');
    const elements = [...surface.current?.querySelectorAll<HTMLElement>('li[data-outline-key][data-item-id]') ?? []]
      .filter(el => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"]') && el.dataset.done !== 'true');
    const index = elements.findIndex(el => el === currentElement);
    const adjacent = elements[index + (backwards ? -1 : 1)];
    return records.current.find(row => row.id === Number(adjacent?.dataset.itemId));
  };
  // Text joined backwards lands at the end of the branch above it rather than
  // on the parent heading it, which a folded branch keeps off the screen.
  // Completed rows stay skipped, as they are in the rendered order this falls
  // back to.
  const openChildren = (id: number) => siblings(records.current, id).filter(row => !row.completed_at);
  const lastInBranch = (row: OutlineItem): OutlineItem => {
    const children = openChildren(row.id);
    return children.length ? lastInBranch(children[children.length - 1]) : row;
  };
  const boundary = (direction: 'backspace' | 'delete') => {
    if (lock.current) return;
    const backwards = direction === 'backspace';
    if (backwards && current.current.parentId !== null) { shiftDraft(true); return; }
    const adjacent = adjacentEntry(backwards);
    const other = backwards ? (adjacent && lastInBranch(adjacent)) : adjacent;
    const snapshot = current.current;
    if (!other) {
      if (backwards && !snapshot.content.trim() && !snapshot.tags.length) {
        if (snapshot.id === null) dismissEmptyDraft();
        else deleteCurrentEntry();
      }
      return;
    }
    restoringFocus.current = true;
    const ownId = stageDraft();
    if (ownId === null) {
      const offset = backwards ? Number.MAX_SAFE_INTEGER : 0;
      activate(other, { anchor: offset, head: offset });
    } else {
      const own = records.current.find(row => row.id === ownId)!;
      const first = backwards ? other : own, second = backwards ? own : other;
      const merged = mergeEntries(documentOf(first), documentOf(second));
      const { content, tags } = serializeEntry(merged);
      const firstText = backwards
        ? surface.current?.querySelector<HTMLElement>(`[data-item-id="${first.id}"] > div > [role="group"]`)
        : surface.current?.querySelector<HTMLElement>('[role="textbox"]');
      const offset = firstText ? domTextOffset(firstText, firstText, firstText.childNodes.length)
        : markdownText(first.content, hiddenTagsFor(first.tags)).length;
      documentStore.enqueue([
        { kind: first.kind, id: first.id, type: 'update', content, tags, document: merged },
        ...keepChildren([second]),
        { kind: second.kind, id: second.id, type: 'delete' },
      ]);
      activate(records.current.find(row => row.id === first.id)!, { anchor: offset, head: offset });
    }
    void documentStore.flush().catch(() => {});
  };
  // Removing an entry from a filtered list takes it out of that list only. The
  // tag that put it there goes, and the entry stays in the full logbook.
  const untagOrDelete = (entry: { kind: EntryKind; id: number; content: string; tags: string[] }): OutlineChange => {
    const remaining = activeTag ? entry.tags.filter(tag => tag !== activeTag) : [];
    return activeTag && (entry.content.trim() || remaining.length)
      ? { kind: entry.kind, id: entry.id, type: 'update', content: entry.content, tags: remaining, allow_empty: true }
      : { kind: entry.kind, id: entry.id, type: 'delete' };
  };
  // Deleting an entry takes its branch with it, so an edit that merely consumes
  // entries as text lifts out the children it never covered first: joining two
  // lines, or typing over a selection, is not a request to discard what hung
  // below them. These moves must be enqueued ahead of the deletes.
  const keepChildren = (doomed: readonly { id: number; kind: EntryKind }[]): OutlineChange[] => {
    const gone = new Set(doomed.map(row => row.id));
    return doomed.flatMap(row => {
      const parentId = records.current.find(item => item.id === row.id)?.parent_id ?? null;
      const parent = parentId === null ? null : records.current.find(item => item.id === parentId);
      return siblings(records.current, row.id).filter(child => !gone.has(child.id)).map(child => ({
        id: child.id, kind: child.kind, type: 'move' as const,
        parent_id: parentId, after_id: row.id, target_kind: parent ? parent.kind : defaultKind,
      }));
    });
  };
  const deleteCurrentEntry = () => {
    const previous = adjacentEntry(true), next = adjacentEntry(false);
    const snapshot = current.current;
    restoringFocus.current = true;
    updateEntrySelection(null);
    let untagged = false;
    if (snapshot.id !== null) {
      const id = snapshot.id;
      const change = untagOrDelete({ kind: snapshot.kind, id, content: snapshot.content,
        tags: [...new Set([...snapshot.tags, ...snapshot.savedTags])] });
      untagged = change.type === 'update';
      documentStore.enqueue([change]);
      // An untagged entry still matches this outline's rows until the reload.
      if (untagged) depart(id);
    }
    const other = previous ?? next;
    if (other) {
      const offset = previous ? Number.MAX_SAFE_INTEGER : 0;
      activate(records.current.find(row => row.id === other.id) ?? other, { anchor: offset, head: offset });
    } else {
      flushSync(() => persist({ ...blank(records.current, true, snapshot.parentId, snapshot.afterId, snapshot.kind), beforeId: snapshot.beforeId }));
      focus();
    }
    void documentStore.flush().then(() => untagged ? refresh() : undefined).catch(() => {});
  };
  const selectDocument = () => {
    selectionActive.current = true; setSelectedAll(true); setExpanded(new Set(records.current.map(item => item.id)));
    if (surface.current) {
      surface.current.focus(); const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(surface.current); selection?.removeAllRanges(); selection?.addRange(range);
    }
    void save().catch(() => {});
  };
  useRangeEditing(key, () => selectionActive.current, edit => {
    const ranges = edit.ranges.filter(range => range.key === key);
    if (!ranges.length) return;
    try {
      const value = current.current;
      const includesDraft = ranges.some(range => range.id === 'draft' || Number(range.id) === value.id);
      const selected = ranges.map(range => {
        if (range.id === 'draft' || Number(range.id) === value.id) return {
          ...range, id: value.id, kind: value.kind, content: value.content, tags: value.tags,
          document: documentOf(value), parentId: value.parentId,
        };
        const row = records.current.find(row => row.id === Number(range.id));
        if (!row) throw new Error('The selected entry has changed.');
        return { ...range, id: row.id, kind: row.kind, content: row.content, tags: row.tags,
          document: documentOf(row), parentId: row.parent_id };
      });
      const first = selected[0], last = selected.at(-1)!;
      const primary = edit.ranges[0].key === key;
      const replacement = replaceEntryRange(first, last, primary ? edit.text : '', primary ? edit.html : '');
      if (!includesDraft) stageDraft();
      else if (value.content.trim() || value.tags.length) {
        const stagedId = stageDraft();
        for (let index = 0; index < selected.length; index++) {
          if (ranges[index].id === 'draft' || Number(ranges[index].id) === value.id) selected[index].id = stagedId;
        }
      }
      // Hidden tags are context, not selected text, so in a filtered view they
      // cannot keep an emptied entry alive as a blank row carrying the tag.
      // Nothing written left is the test, not nothing stored: a remainder of
      // tags alone cannot keep an entry alive as a blank row in a filtered view.
      const removeAll = !entryText(replacement.document).trim() && (!!activeTag || !replacement.tags.length);
      const id = first.id ?? documentStore.allocate();
      restoringFocus.current = true;
      const changes: OutlineChange[] = [];
      if (!removeAll) {
        const content = { id, kind: first.kind, content: replacement.content, tags: replacement.tags,
          document: replacement.document, allow_empty: true };
        changes.push(first.id === null
          ? { ...content, type: 'create', date: day, client_id: value.clientId, parent_id: first.parentId, after_id: value.afterId, before_id: value.beforeId }
          : { ...content, type: 'update' });
      }
      const doomed = selected.slice(removeAll ? 0 : 1)
        .filter((row): row is typeof row & { id: number } => row.id !== null);
      changes.push(...keepChildren(doomed));
      for (const row of doomed) changes.push({ id: row.id, kind: row.kind, type: 'delete' });
      documentStore.enqueue(changes, edit.historyKey);
      if (includesDraft) persist(blank(records.current, false));
      if (primary) edit.focus = () => {
        const row = records.current.find(row => row.id === documentStore.resolve(id));
        if (row) activate(row, { anchor: replacement.offset, head: replacement.offset });
        else {
          flushSync(() => persist(blank(records.current, true, first.parentId)));
          pendingSelection.current = { anchor: 0, head: 0 }; focus();
        }
      };
      else restoringFocus.current = false;
      void documentStore.flush().catch(() => {});
    } catch (error) { restoringFocus.current = false; entryError(error, surface.current?.querySelector(`[data-item-id="${ranges[0].id}"]`)); }
  }, copySpannedDays);
  const replaceDocument = (text = '', html = '') => void run(async () => {
    await save();
    const entry = pastedEntry(text, html);
    const tags = [...new Set([...entry.tags, ...(activeTag ? [activeTag] : [])])];
    const changes: DocumentChange[] = records.current.map(item => {
      const remaining = activeTag ? (item.tags ?? []).filter(tag => tag !== activeTag) : [];
      return activeTag && (item.content.trim() || remaining.length)
        ? { kind: item.kind, id: item.id, content: item.content, tags: remaining, allow_empty: true }
        : { kind: item.kind, id: item.id, delete: true };
    });
    const hasContent = !!(entry.content.trim() || entry.tags.length);
    if (hasContent) changes.push({ kind: defaultKind, content: entry.content, tags, date: day, client_id: crypto.randomUUID() });
    const results = changes.length ? await editDocument(changes) : [];
    const created = hasContent ? results.at(-1) : null;
    selectionActive.current = false; setSelectedAll(false); window.getSelection()?.removeAllRanges();
    persist(created ? { ...blank([], true), kind: defaultKind, mode: 'edit', id: created.id, content: created.content, saved: created.content, document: created.document ?? null, tags: created.tags ?? [], savedTags: created.tags ?? [] } : blank([], composer));
    if (created) pendingSelection.current = { anchor: markdownText(created.content).length, head: markdownText(created.content).length };
    await refresh();
  });
  // Copying entries takes their branches with them, as a markdown list. The
  // draft's own text is newer than the saved copy, so it wins.
  const copyEntries = (clipboard: DataTransfer, roots?: number[]) => {
    const lines: string[] = [];
    const contentOf = (row: OutlineItem) => row.id === current.current.id && current.current.active ? current.current.content : row.content;
    const childrenOf = (parent: number | null) => sorted(records.current.filter(item =>
      (item.parent_id !== null && !records.current.some(other => other.id === item.parent_id) ? null : item.parent_id) === parent));
    const build = (rows: OutlineItem[], depth: number): HTMLUListElement => {
      const list = document.createElement('ul');
      for (const row of rows) {
        const content = contentOf(row);
        // Tags are already inline in the text, so an entry copies whole.
        lines.push(markdownBullet(content, depth, row.kind === 'tasks', !!row.completed_at, row.tags ?? []));
        const li = document.createElement('li');
        const element = surface.current?.querySelector(`[data-item-id="${row.id}"]`);
        const text = element?.querySelector(':scope > div > [role="group"], :scope > div .tiptap');
        if (text) li.innerHTML = text.innerHTML;
        else li.textContent = markdownText(content);
        // A closed branch is not on screen to be selected from, so all of it
        // comes along. An open one brings only what was actually selected.
        const under = childrenOf(row.id).filter(child =>
          !roots || !isExpanded(row.id) || chosen.has(child.id));
        const children = build(under, depth + 1);
        if (children.children.length) li.append(children);
        list.append(li);
      }
      return list;
    };
    const chosen = new Set(roots);
    const top = roots
      ? sorted(records.current.filter(row => chosen.has(row.id) && !ancestorIds(records.current, row.parent_id).some(id => chosen.has(id))))
      : childrenOf(null);
    clipboard.setData('text/html', build(top, 0).outerHTML); clipboard.setData('text/plain', lines.join('\n'));
  };
  // A link to one entry, to paste into another entry or to send to someone.
  // Both flavours go on the clipboard: the address on its own, and the same
  // address labelled with the opening of what it points at, so pasting it into
  // an entry here reads as a reference rather than as a URL.
  const copyEntryLink = async (id: number) => {
    const row = records.current.find(item => item.id === id);
    const signature = row?.signature;
    const element = surface.current?.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
    if (!row || !signature) {
      // An entry the server has not seen yet has nothing to sign a link with.
      entryError('This entry hasn’t been saved yet, so it has no link to copy.', element);
      return;
    }
    const url = entryLinkUrl({ kind: row.kind, id, signature });
    // The address goes on the clipboard as itself, in both flavours. Pasted
    // here it is a bare link, which is what reads as a glimpse of the entry —
    // and a glimpse that is taken when it is read, so it follows the entry if
    // the writing changes. A label is something the writer gives it instead.
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.textContent = url;
    try {
      if (typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([url], { type: 'text/plain' }),
          'text/html': new Blob([anchor.outerHTML], { type: 'text/html' }),
        })]);
      } else {
        await navigator.clipboard.writeText(url);
      }
    } catch { entryError('Couldn’t reach the clipboard.', element); }
  };
  // The rows an action applies to: the entry selected in the editor, with its
  // branch. A plain text selection stays plain text.
  const actionRoots = (): number[] | null => {
    const selected = entrySelectionRef.current?.key;
    if (!selected) return input.current?.entireSelected() && current.current.id !== null ? [current.current.id] : null;
    const id = selected.startsWith('draft:') ? current.current.id : Number(selected.slice('item:'.length));
    return id === null || Number.isNaN(id) ? null : [id];
  };

  const draftInside = (id: number) => current.current.active && ancestorIds(records.current, current.current.parentId).includes(id);
  const clearPreview = (id: number | null) => {
    if (id === null) return;
    setPreviewed(previous => {
      if (!previous.size) return previous;
      const next = new Set(previous);
      for (const candidate of previous) {
        if (ancestorIds(records.current, candidate).includes(id)) next.delete(candidate);
      }
      return next.size === previous.size ? previous : next;
    });
  };
  // Opening a branch near the bottom of a short pane hides the children it just
  // revealed. Lift the parent, no higher than the top of the pane, so as much
  // of its subtree as will fit comes into view.
  const revealChildren = (id: number | null) => {
    if (id === null) return;
    requestAnimationFrame(() => {
      const row = surface.current?.querySelector<HTMLElement>(`[data-item-id="${id}"] > div`);
      const children = surface.current?.querySelector<HTMLElement>(`[data-branch-for="${id}"] > ul`);
      if (!row || !children) return;
      let scroller: HTMLElement | null = row.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
        scroller = scroller.parentElement;
      }
      if (!scroller) return;
      const visible = scroller.getBoundingClientRect(), bounds = row.getBoundingClientRect();
      const hidden = bounds.bottom + children.scrollHeight - visible.bottom;
      const room = bounds.top - visible.top;
      const lift = Math.min(hidden, room);
      if (lift <= 1) return;
      // A browser smooth scroll runs on its own curve and duration, which reads
      // as a second movement beside the branch. Drive it on the branch's.
      const start = scroller.scrollTop;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { scroller.scrollTop = start + lift; return; }
      const begun = performance.now();
      let placed = start;
      const pane = scroller;
      const step = () => {
        // A scroll of their own hands the pane back to the reader.
        if (Math.abs(pane.scrollTop - placed) > 1) return;
        const elapsed = Math.min(1, (performance.now() - begun) / BRANCH_OPEN_MS);
        pane.scrollTop = start + lift * branchEasing(elapsed);
        placed = pane.scrollTop;
        if (elapsed < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  };
  const isExpanded = (id: number) => {
    const row = items.find(item => item.id === id);
    return (!!row && row.kind === 'tasks' && !!row.completed_at && !collapsed.has(id)) || expanded.has(id) || previewed.has(id) || draftInside(id);
  };
  const renderToggle = (id: number | null, content: string) => {
    const row = items.find(item => item.id === id);
    const unsavedChild = draft.active && draft.id === null && draft.parentId === id && !!(draft.content.trim() || draft.tags.length);
    const childCount = (row?.child_count ?? items.filter(item => item.parent_id === id).length) + Number(unsavedChild);
    let doneCount = row?.completed_child_count ?? items.filter(item => item.parent_id === id && item.completed_at).length;
    if (pendingCompletion.size) for (const child of items) {
      if (child.parent_id === id && pendingCompletion.has(child.id)) doneCount += Number(pendingCompletion.get(child.id)) - Number(!!child.completed_at);
    }
    const rowKind = row ? row.kind : draft.kind;
    if (unsavedChild && row?.completed_at && draft.kind === 'tasks') doneCount++;
    if (id === null || !childCount) return null;
    const open = isExpanded(id);
    const pinned = expanded.has(id) || draftInside(id) || (!!row?.completed_at && rowKind === 'tasks' && !collapsed.has(id));
    const taskParent = rowKind === 'tasks';
    return <Disclosure type="button" data-focus-chrome $open={open} $task={taskParent} $done={!!row?.completed_at} $progress={childCount ? doneCount / childCount : 0} disabled={busy} aria-expanded={open}
      aria-description={taskParent ? `${doneCount} of ${childCount} children completed` : undefined}
      aria-label={`${pinned ? 'Collapse' : 'Expand'} ${markdownText(content) || 'entry'}`}
      onPointerEnter={event => {
        if (!pinned && event.pointerType !== 'touch') {
          setPreviewed(previous => previous.has(id) ? previous : new Set([...previous, id]));
          revealChildren(id);
        }
      }} onClick={() => {
        if (pinned) {
          void save().catch(() => {});
          if (draftInside(id)) persist(blank(records.current, composer));
          clearPreview(id);
        }
        setExpanded(previous => { const next = new Set(previous); if (pinned) next.delete(id); else next.add(id); return next; });
        if (!pinned) revealChildren(id);
        if (row?.completed_at && rowKind === 'tasks') {
          setCollapsed(previous => {
            const next = new Set(previous);
            if (pinned) next.add(id); else next.delete(id);
            return next;
          });
        }
      }} >
      {taskParent && <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
        {/* Evenly spaced across the bubble's 9.5px interior, on its centre line. */}
        {[3.9, 7, 10.1].map(x => <circle key={x} cx={x} cy="7" r=".9" fill="currentColor" />)}
      </svg>}
    </Disclosure>;
  };

  const inputLabel = draft.mode === 'edit' ? draft.kind === 'notes' ? 'Edit note' : 'Edit task' : draft.kind === 'notes' ? 'New note' : 'New task';
  const renderMarker = (id: number | null, content: string) => {
    const toggle = renderToggle(id, content);
    const row = items.find(item => item.id === id);
    const rowKind = row ? row.kind : draft.kind;
    if (rowKind === 'tasks' && id !== null) {
      const done = pendingCompletion.get(id) ?? !!row?.completed_at;
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
  const { startEntryGesture, trackEntryGesture, finishEntryGesture, cancelEntryGesture, consumeClick } = useEntryGestures();
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
    const hiddenTags = draftHiddenTags(snapshot);
    const keepHiddenTag = (content: string, tags: string[]) =>
      [...new Set([...tags, ...(content.trim() || tags.length ? hiddenTags : [])])];
    restoringFocus.current = true;
    if (split && !split.before.content && !split.before.tags.length && (split.after.content || split.after.tags.length)) {
      // Keep the trailing entry (and its children) intact. An explicit empty
      // sibling represents the line inserted before it and survives a reload.
      stageDraft();
      const editKey = crypto.randomUUID();
      persist({ ...current.current, content: split.after.content, tags: keepHiddenTag(split.after.content, split.after.tags) });
      const id = stageDraft(editKey)!;
      const emptyId = documentStore.allocate();
      const parent = records.current.find(row => row.id === snapshot.parentId);
      const emptyKind = parent ? parent.kind : defaultKind;
      flushSync(() => {
        documentStore.enqueue([{ id: emptyId, kind: emptyKind, type: 'create', content: '', tags: activeTag ? [activeTag] : [],
          allow_empty: true, date: day, client_id: crypto.randomUUID(), parent_id: snapshot.parentId, before_id: id }], editKey);
        persist({ ...current.current, clientId: crypto.randomUUID(), mode: 'edit', afterId: emptyId, beforeId: null, placement: 'after' });
      });
      pendingSelection.current = { anchor: 0, head: 0 };
      focus();
      void save().catch(() => {});
      return;
    }
    flushSync(() => {
      if (split) persist({ ...snapshot, content: split.before.content, tags: keepHiddenTag(split.before.content, split.before.tags) });
      const id = stageDraft();
      const parent = records.current.find(item => item.id === snapshot.parentId);
      const next = blank(records.current, true, snapshot.parentId, id ?? snapshot.afterId, parent ? parent.kind : defaultKind);
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
    $leaving={draft.id !== null && completing.has(draft.id)}>
    <Row aria-busy={saving} onClick={gestureSelected ? event => {
      // The row swallows pointer input while selected, so a click without a
      // drag hands editing back instead of leaving the entry stuck selected.
      // The second click of the selecting double click must not undo it.
      if (event.detail >= 2 || (event.target as HTMLElement).closest('button, a')) return;
      updateEntrySelection(null);
      input.current?.focus(undefined, { anchor: Number.MAX_SAFE_INTEGER, head: Number.MAX_SAFE_INTEGER });
    } : undefined}>{renderMarker(draft.id, draft.content)}<RichTextEditor key={draft.clientId} ref={input} label={archived && draft.kind === 'tasks' && draft.parentId !== null && draft.mode === 'new' ? 'New completed child task' : inputLabel} value={draft.content} document={draft.document} tags={draft.tags} readOnly={false}
      onBoundary={boundary} onVerticalBoundary={navigateBoundary} onHorizontalBoundary={navigateBoundary} onSelectDocument={selectDocument}
      onEnter={advance} onSelectEntry={selected => updateEntrySelection(selected ? { key: gestureKey, dragX: 0 } : null)} onDeleteEntry={deleteCurrentEntry}
      onShift={shiftDraft}
      onChange={(content, tags, document) => {
        verticalX.current = null;
        const value = current.current;
        const hiddenTags = draftHiddenTags(value);
        // A new entry written in a filtered view is filed under that view's
        // tag. A saved one carries whatever its document says: the tag shows
        // while it is open, so deleting it there is meant.
        const keep = value.id === null && (content.trim() || tags.length) ? hiddenTags : [];
        const kept = document && keep.length ? withTags(document, keep) : document;
        const projected = kept && keep.length ? serializeEntry(kept) : null;
        persist({ ...value, content: projected?.content ?? content, document: kept, hiddenTags,
          tags: projected?.tags ?? [...new Set([...tags, ...keep])] });
      }}
      onBlur={event => {
        const blurredClientId = draft.clientId;
        // Enter and nesting can remount the editor during a focus transfer.
        // That structural blur must not dismiss the draft being moved.
        if (restoringFocus.current || current.current.clientId !== blurredClientId) return;
        // Native dialogs restore focus to this editor when closed. Keep an
        // empty draft mounted while a dialog temporarily owns that focus.
        if (document.querySelector('dialog[open]')) { void save().catch(() => {}); return; }
        if (event?.relatedTarget instanceof Node && surface.current?.contains(event.relatedTarget)) { void save().catch(() => {}); return; }
        if (!lock.current && dismissEmptyDraft()) return;
        void save().then(() => {
          if (restoringFocus.current || current.current.clientId !== blurredClientId || surface.current?.contains(document.activeElement)) return;
          if (!dismissEmptyDraft()) releaseOpenEntry();
        }).catch(() => {});
      }}
      onKeyDown={event => {
        // The screen can still look busy after a save has finished. Let run()
        // check the lock so the editor does not lose the user's next key.
        if (event.isComposing) return;
        // A key press wins over an older plan to move the cursor.
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
          event.preventDefault();
          void save().catch(() => {});
          restoringFocus.current = true;
          flushSync(() => persist(blank(records.current, composer)));
          focus();
        }
      }} />
      {gestureSelected && draft.id !== null && <LinkCopy type="button" data-focus-chrome data-copy-link
        aria-label={`Copy link to ${markdownText(draft.content, draftHiddenTags(draft)) || 'this entry'}`}
        title="Copy link to this entry"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); void copyEntryLink(draft.id!); }}><Link2 size={14} aria-hidden="true" /></LinkCopy>}
    </Row>
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
      return <Item key={item.id} data-outline-key={key} data-done={!!item.completed_at && !archived} data-kind={item.kind} data-item-id={item.id} data-depth={depth} $leaving={completing.has(item.id)} $departing={departing.has(item.id)}
      data-entry-gesture-key={gestureKey} data-gesture-selected={gestureSelected || undefined}
      onPointerLeave={() => clearPreview(item.id)}
      onContextMenuCapture={event => { if (gestureSelected) { event.preventDefault(); event.stopPropagation(); } }}
      $gestureSelected={gestureSelected} $dragX={gestureSelected ? entrySelection.dragX : 0}
      $arriving={item.kind === 'tasks' && (completed.has(item.id) || reopened.has(item.id))}>
      <Row>{renderMarker(item.id, item.content)}<Text $done={!!item.completed_at && !archived} $action={archived && item.kind === 'tasks'} role="group" tabIndex={0} aria-label={markdownText(item.content, hiddenTagsFor(item.tags)) || (item.tags ?? []).filter(tag => tag !== activeTag).map(tag => '#' + tag).join(' ') || (item.kind === 'tasks' ? 'Empty task' : 'Empty note')}
        onClick={event => {
          if (consumeClick()) return;
          if (selectedEntryRanges().length > 1) return;
          if ((archived || !item.completed_at) && !(event.target as HTMLElement).closest('a')) void select(item, event.currentTarget);
        }}
        onContextMenu={event => {
          const link = (event.target as HTMLElement).closest('a');
          if (link && (archived || !item.completed_at)) { event.preventDefault(); select(item, event.currentTarget, link); }
        }}
        onKeyDown={event => { if ((archived || !item.completed_at) && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(item); } }}
      ><MarkdownContent document={item.document} content={item.content} tags={activeTag ? item.tags?.filter(tag => tag !== activeTag) : item.tags} hiddenTags={hiddenTagsFor(item.tags)} /></Text>
        {gestureSelected && <LinkCopy type="button" data-focus-chrome data-copy-link
          aria-label={`Copy link to ${markdownText(item.content, hiddenTagsFor(item.tags)) || 'this entry'}`}
          title="Copy link to this entry"
          /* The row is the drag handle, so the press that works this button
             must not also be read as the start of a drag. */
          onPointerDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); void copyEntryLink(item.id); }}><Link2 size={14} aria-hidden="true" /></LinkCopy>}
      </Row>
      <Branch data-branch-for={item.id} $open={isExpanded(item.id)} $editing={draftInside(item.id)} aria-hidden={!isExpanded(item.id)}>{renderChildren(item.id, depth + 1)}</Branch>
    </Item>;
    });
    const parent = parentId === null ? null : items.find(item => item.id === parentId);
    return parentId === null ? <List>{content}</List> : <Children $task={parent ? parent.kind === 'tasks' : draft.kind === 'tasks'}>{content}</Children>;
  };
  const clearDrop = () => {
    if (dropTarget.current) delete dropTarget.current.dataset.dropPosition;
    dropTarget.current = null;
  };
  const dropEntry = (event: React.DragEvent) => {
    const element = (event.target as Element).closest<HTMLElement>('li[data-item-id]');
    const target = records.current.find(row => row.id === Number(element?.dataset.itemId));
    if (!element || !target) return null;
    const incoming = draggedEntry.current === null ? incomingEntryDrag(key, day) : null;
    const id = incoming ? incoming.id : documentStore.resolve(draggedEntry.current);
    if (id === null || target.id === id) return null;
    // An entry from another day cannot be its own ancestor here.
    if (!incoming && ancestorIds(records.current, target.parent_id).includes(id)) return null;
    const rect = element.firstElementChild!.getBoundingClientRect();
    return { element, target, id, incoming, before: event.clientY < rect.top + rect.height / 2 };
  };
  const acceptingDrag = () => draggedEntry.current !== null || !!incomingEntryDrag(key, day);
  const takeIncomingEntry = (drag: EntryDrag, placement: DragPlacement) => {
    takeEntryDrag(drag);
    // The refreshed day arrives in a later render, so the arrival is picked up there.
    arriving.current = drag.id;
    void run(async () => {
      await moveEntryToDay(drag, day!, placement);
      await refresh();
    });
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
    // A day's entry can be dropped into another day, which owns its own
    // outline. Only a saved entry has an ID that outline could move.
    if (day) {
      const kind = current.current.kind;
      const register = (saved: number) => startEntryDrag({ outline: key, kind, id: saved, date: day });
      const resolved = documentStore.resolve(id);
      if (resolved !== null && resolved > 0) register(resolved);
      else void documentStore.flush().then(() => {
        const saved = documentStore.resolve(id);
        if (saved !== null && saved > 0) register(saved);
      }).catch(() => {});
    }
  }} onDragOverCapture={event => {
    if (!acceptingDrag()) return;
    event.preventDefault(); event.stopPropagation(); clearDrop();
    const drop = dropEntry(event);
    event.dataTransfer.dropEffect = drop ? 'move' : 'none';
    if (drop) { drop.element.dataset.dropPosition = drop.before ? 'before' : 'after'; dropTarget.current = drop.element; }
  }} onDropCapture={event => {
    if (!acceptingDrag()) return;
    event.preventDefault(); event.stopPropagation();
    const drop = dropEntry(event); clearDrop(); draggedEntry.current = null;
    if (!drop) return;
    if (drop.incoming) {
      takeIncomingEntry(drop.incoming, { parentId: drop.target.parent_id,
        afterId: drop.before ? null : drop.target.id, beforeId: drop.before ? drop.target.id : null });
      return;
    }
    const row = records.current.find(row => row.id === drop.id);
    if (!row) return;
    try { checkDepth(row.id, drop.target.parent_id); }
    catch (error) { entryError(error); return; }
    documentStore.enqueue([{ kind: row.kind, id: row.id, type: 'move', parent_id: drop.target.parent_id,
      after_id: drop.before ? null : drop.target.id, before_id: drop.before ? drop.target.id : null,
      target_kind: drop.target.parent_id === null ? defaultKind : drop.target.kind }]);
    const moved = records.current.find(item => item.id === row.id)!;
    activate(moved);
    input.current?.selectEntry();
    void documentStore.flush().catch(() => {});
  }} onDragEndCapture={() => {
    const left = draggedEntry.current !== null && entryDragLeft(key);
    draggedEntry.current = null; endEntryDrag(); clearDrop();
    if (left) { updateEntrySelection(null); persist(blank(records.current, false)); }
  }} onPointerDown={event => {
    verticalX.current = null; selectionActive.current = false; setSelectedAll(false);
    const entry = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-entry-gesture-key]') : null;
    const gestureKey = entry?.dataset.entryGestureKey;
    if (gestureKey !== entrySelectionRef.current?.key) updateEntrySelection(null);
    if (entry) startEntryGesture(event, entry);
  }} onPointerMove={trackEntryGesture} onPointerUp={finishEntryGesture} onPointerCancel={cancelEntryGesture} onCopyCapture={event => {
    if (selectionActive.current) {
      event.preventDefault(); event.stopPropagation(); copyEntries(event.clipboardData);
      return;
    }
    const roots = actionRoots();
    if (!roots?.length) return;
    event.preventDefault(); event.stopPropagation(); copyEntries(event.clipboardData, roots);
  }} onCutCapture={event => {
    if (selectionActive.current) {
      event.preventDefault(); event.stopPropagation(); copyEntries(event.clipboardData); replaceDocument();
      return;
    }
    const roots = actionRoots();
    if (!roots?.length) return;
    event.preventDefault(); event.stopPropagation();
    copyEntries(event.clipboardData, roots);
    deleteCurrentEntry();
  }}
  onPasteCapture={event => { if (selectionActive.current) { event.preventDefault(); event.stopPropagation(); replaceDocument(event.clipboardData.getData('text/plain'), event.clipboardData.getData('text/html')); } }} onKeyDownCapture={event => {
    // A link to the entry being held, for pasting into another entry or for
    // sending to someone.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'k' && !event.defaultPrevented) {
      const held = actionRoots();
      if (held?.length) {
        event.preventDefault(); event.stopPropagation();
        void copyEntryLink(held[0]);
        return;
      }
    }
    // A selection spanning entries takes the shortcut across all of them.
    const grouping = event.metaKey || event.ctrlKey ? formattingShortcut(event.key, event.shiftKey) : null;
    if ((event.key === 'Tab' || grouping) && !selectionActive.current && !event.defaultPrevented) {
      const rows = spannedRows();
      if (rows.length) {
        event.preventDefault(); event.stopPropagation();
        if (grouping) formatGroup(rows, grouping); else shiftGroup(rows, event.shiftKey);
        return;
      }
    }
    if (!selectionActive.current || event.defaultPrevented) return;
    event.stopPropagation();
    const mod = event.metaKey || event.ctrlKey;
    const historyKey = mod && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase());
    if (historyKey && event.repeat) { event.preventDefault(); return; }
    const historyDirection = historyShortcutDirection(event.nativeEvent);
    if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); return; }
    if (historyDirection !== null) { event.preventDefault(); void documentUndo(historyDirection).catch(e => entryError(e)); return; }
    const format = mod ? formattingShortcut(event.key, event.shiftKey) : null;
    if (format) { event.preventDefault(); void run(async () => {
      await save();
      const changes = records.current.filter(item => archived || !item.completed_at).map(item => {
        const document = formatDocument(documentOf(item), format);
        return { kind: item.kind, id: item.id, document, ...serializeEntry(document) };
      });
      if (changes.length) await editDocument(changes);
      persist(blank([], composer)); selectionActive.current = false; setSelectedAll(false); window.getSelection()?.removeAllRanges(); await refresh();
    }); return; }
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); replaceDocument(); }
    else if (!mod && event.key.length === 1) { event.preventDefault(); replaceDocument(event.key); }
    else if (event.key === 'Escape') { event.preventDefault(); selectionActive.current = false; setSelectedAll(false); window.getSelection()?.removeAllRanges(); focus(); }
  }}>{renderChildren(null, 0)}{(!archived || defaultKind === 'notes') && (!draft.active || draft.mode === 'edit') && <ComposerTarget type="button" $floating={defaultKind === 'notes' && !composer}
    data-task-creation-area={defaultKind === 'tasks' || undefined} aria-label={defaultKind === 'tasks' ? 'Add task' : 'Add note'}
    onClick={beginEntry} />}
    {defaultKind === 'tasks' && draft.active && draft.mode === 'new' && <ComposerTarget type="button" $floating={false} data-task-creation-area
      aria-label="Continue new task" onClick={focus} />}
    <VisuallyHidden>Tab indents. Shift Tab outdents. Enter adds a sibling. Shift Enter adds a line break. Select all twice selects this list.</VisuallyHidden></OutlineSurface>;
}
