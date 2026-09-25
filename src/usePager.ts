import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export function usePager<View extends string>(views: readonly View[], initialView: View, active: boolean) {
  const [view, setView] = useState<View>(initialView);
  const viewRef = useRef<View>(initialView);
  const pagerRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const viewIndex = useCallback((value: View) => views.indexOf(value), [views]);
  const commitView = useCallback((next: View) => {
    viewRef.current = next;
    setView(previous => previous === next ? previous : next);
  }, []);

  const selectView = useCallback((next: View) => {
    commitView(next);
    const pager = pagerRef.current;
    if (!pager) return;
    pager.scrollTo({
      left: viewIndex(next) * pager.clientWidth,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [commitView, viewIndex]);

  const trackScroll = useCallback((pager: HTMLDivElement) => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const index = Math.max(0, Math.min(views.length - 1, Math.round(pager.scrollLeft / pager.clientWidth)));
      commitView(views[index]);
    }, 80);
  }, [commitView, views]);

  useLayoutEffect(() => {
    if (!active) return;
    const align = () => {
      const pager = pagerRef.current;
      if (pager) pager.scrollLeft = viewIndex(viewRef.current) * pager.clientWidth;
    };
    align();
    window.addEventListener('resize', align);
    return () => window.removeEventListener('resize', align);
  }, [active, viewIndex]);

  useEffect(() => () => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
  }, []);

  return { pagerRef, selectView, trackScroll, view } as const;
}
