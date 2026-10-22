import { useEffect, useRef, type PointerEvent } from 'react';

const ENTRY_MOVE_THRESHOLD = 48;
export type EntrySelection = { key: string; dragX: number };
type EntryGesture = {
  pointerId: number; x: number; y: number; pager: HTMLElement; pagerLeft: number;
  paging: boolean; cancelled: boolean;
};

// A touch drag across the page turns it. Entries themselves are not moved by
// touch: a press on one is a press, and a drag over one selects its text.
export function useEntryGestures() {
  const entryGesture = useRef<EntryGesture | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => {
    const gesture = entryGesture.current;
    if (gesture) delete gesture.pager.dataset.dragging;
    entryGesture.current = null;
  }, []);
  const startEntryGesture = (event: PointerEvent, element: HTMLElement) => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const pager = element.closest<HTMLElement>('[data-mobile-pager]');
    if (!pager) { entryGesture.current = null; return; }
    pager.scrollTo({ left: pager.scrollLeft, behavior: 'instant' });
    entryGesture.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY, pager,
      pagerLeft: pager.scrollLeft, paging: false, cancelled: false,
    };
  };
  const trackEntryGesture = (event: PointerEvent) => {
    const gesture = entryGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.cancelled) return;
    const x = event.clientX - gesture.x;
    const y = event.clientY - gesture.y;
    if (!gesture.paging && Math.abs(x) < 10 && Math.abs(y) < 10) return;
    if (!gesture.paging && Math.abs(y) >= Math.abs(x)) { gesture.cancelled = true; return; }
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
    if (!gesture.paging) return;
    const x = event.clientX - gesture.x;
    const y = event.clientY - gesture.y;
    event.preventDefault(); event.stopPropagation();
    delete gesture.pager.dataset.dragging;
    const width = gesture.pager.clientWidth;
    const initial = Math.round(gesture.pagerLeft / width);
    const direction = Math.abs(x) >= ENTRY_MOVE_THRESHOLD && Math.abs(x) >= Math.abs(y) * 1.25 ? (x < 0 ? 1 : -1) : 0;
    const last = Math.max(0, Math.round(gesture.pager.scrollWidth / width) - 1);
    const target = Math.max(0, Math.min(last, initial + direction));
    gesture.pager.scrollTo({ left: target * width, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    suppressClick.current = true;
  };
  const cancelEntryGesture = (event: PointerEvent) => {
    const gesture = entryGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    entryGesture.current = null;
    delete gesture.pager.dataset.dragging;
    if (gesture.paging) gesture.pager.scrollTo({ left: gesture.pagerLeft, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const consumeClick = (): boolean => {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  };
  return { startEntryGesture, trackEntryGesture, finishEntryGesture, cancelEntryGesture, consumeClick };
}
