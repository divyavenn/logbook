import { editDocument } from './documentHistory';
import type { EntryKind } from './types';

// A drag can cross outlines, and each day owns a separate one. The dragged
// entry is recorded here so the outline under the pointer knows what is coming
// and which day it is leaving.
export type EntryDrag = { outline: string; kind: EntryKind; id: number; date: string };
export type DragPlacement = { parentId: number | null; afterId?: number | null; beforeId?: number | null };

let active: EntryDrag | null = null;
let consumed: EntryDrag | null = null;
export const startEntryDrag = (drag: EntryDrag) => { active = drag; consumed = null; };
export const endEntryDrag = () => { active = null; };
// A drop elsewhere takes the entry out of the outline it was dragged from, so
// that outline drops its editing draft instead of leaving a row behind.
export const takeEntryDrag = (drag: EntryDrag) => { consumed = drag; active = null; };
export const entryDragLeft = (outline: string) => consumed?.outline === outline;
// Only a dated entry arriving from another day is a move this outline can take.
export const incomingEntryDrag = (outline: string, date: string | undefined): EntryDrag | null =>
  date && active && active.outline !== outline ? active : null;

export async function moveEntryToDay(drag: EntryDrag, date: string, placement: DragPlacement) {
  await editDocument([{
    kind: drag.kind, id: drag.id, move: true, date,
    parent_id: placement.parentId, after_id: placement.afterId ?? null, before_id: placement.beforeId ?? null,
  }]);
}
