import { useEffect, useRef, type PointerEvent } from 'react';
import { haptic } from './haptics';

const ENTRY_HOLD_MS = 360;
const ENTRY_MOVE_THRESHOLD = 48;
export type EntrySelection = { key: string; dragX: number };
type EntryGesture = {
  pointerId: number; key: string; element: HTMLElement; x: number; y: number; pager: HTMLElement | null; pagerLeft: number;
  armed: boolean; paging: boolean; cancelled: boolean; timer: ReturnType<typeof setTimeout> | null;
};
type GestureContext = {
  selectedKey: () => string | undefined;
  select: (selection: EntrySelection | null) => void;
  move: (key: string, outdent: boolean) => void;
};

export function useEntryGestures(context: GestureContext) {
  const current = useRef(context);
  current.current = context;
  const entryGesture = useRef<EntryGesture | null>(null);
  const suppressClick = useRef(false);
  const updateEntrySelection = (selection: EntrySelection | null) => current.current.select(selection);
  useEffect(() => () => {
    const gesture = entryGesture.current;
    if (gesture?.timer) clearTimeout(gesture.timer);
    if (gesture?.pager) delete gesture.pager.dataset.dragging;
    entryGesture.current = null;
  }, []);
  const clearEntryGestureTimer = (gesture: EntryGesture) => {
    if (gesture.timer) clearTimeout(gesture.timer);
    gesture.timer = null;
  };
  const startEntryGesture = (event: PointerEvent, key: string, element: HTMLElement) => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const previous = entryGesture.current;
    if (previous) clearEntryGestureTimer(previous);
    const pager = element.closest<HTMLElement>('[data-mobile-pager]');
    pager?.scrollTo({ left: pager.scrollLeft, behavior: 'instant' });
    const gesture: EntryGesture = {
      pointerId: event.pointerId, key, element, x: event.clientX, y: event.clientY, pager,
      pagerLeft: pager?.scrollLeft ?? 0, armed: current.current.selectedKey() === key,
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
  const trackEntryGesture = (event: PointerEvent) => {
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
  const finishEntryGesture = (event: PointerEvent) => {
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
    current.current.move(gesture.key, outdent);
  };
  const cancelEntryGesture = (event: PointerEvent) => {
    const gesture = entryGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    entryGesture.current = null;
    clearEntryGestureTimer(gesture);
    if (gesture.pager) {
      delete gesture.pager.dataset.dragging;
      if (gesture.paging) gesture.pager.scrollTo({ left: gesture.pagerLeft, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    if (gesture.armed) updateEntrySelection({ key: gesture.key, dragX: 0 });
  };
  const consumeClick = (): boolean => {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  };
  return { startEntryGesture, trackEntryGesture, finishEntryGesture, cancelEntryGesture, consumeClick };
}
