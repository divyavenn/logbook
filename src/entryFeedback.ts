const reported = new WeakSet<object>();

export function entryError(error: unknown, entry?: HTMLElement | null) {
  if (typeof error !== 'object' || error === null || !reported.has(error)) {
    console.error('Entry edit failed:', error);
    if (typeof error === 'object' && error !== null) reported.add(error);
  }
  const target = entry ?? document.activeElement?.closest<HTMLElement>('li[data-outline-key]');
  const row = target?.querySelector<HTMLElement>(':scope > div');
  if (!row) return;
  target!.dataset.entryError = 'true';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animation = row.animate(reduced
    ? [{ opacity: 1 }, { opacity: .5 }, { opacity: 1 }]
    : [0, -3, 3, -2, 2, 0].map(x => ({ translate: `${x}px 0` })),
  { duration: 280, easing: 'ease-out' });
  animation.onfinish = () => { delete target!.dataset.entryError; };
}
