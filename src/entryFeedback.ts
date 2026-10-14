const reported = new WeakSet<object>();
const running = new WeakMap<HTMLElement, () => void>();

export function entryError(error: unknown, entry?: HTMLElement | null) {
  if (typeof error !== 'object' || error === null || !reported.has(error)) {
    console.error('Entry edit failed:', error);
    if (typeof error === 'object' && error !== null) reported.add(error);
  }
  const target = entry ?? document.activeElement?.closest<HTMLElement>('li[data-outline-key]');
  const row = target?.querySelector<HTMLElement>(':scope > div');
  if (!row) return;
  const current = getComputedStyle(row);
  const start = { translate: current.translate, opacity: current.opacity };
  running.get(row)?.();
  target!.dataset.entryError = 'true';
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = preference.matches;
  const animation = row.animate(reduced
    ? [{ opacity: start.opacity }, { opacity: .5 }, { opacity: 1 }]
    : [{ translate: start.translate }, ...[-3, 3, -2, 2, 0].map(x => ({ translate: `${x}px 0` }))],
  { duration: 280, easing: 'ease-out' });
  let settling: Animation | null = null;
  const events = new AbortController();
  const cleanup = () => {
    events.abort(); animation.cancel(); settling?.cancel();
    if (running.get(row) === cleanup) { running.delete(row); delete target!.dataset.entryError; }
  };
  const interrupt = () => {
    const style = getComputedStyle(row);
    const from = reduced ? { opacity: style.opacity } : { translate: style.translate };
    animation.cancel(); events.abort();
    settling = row.animate([from, reduced ? { opacity: 1 } : { translate: '0px 0px' }], { duration: preference.matches ? 0 : 90, easing: 'ease-out' });
    settling.onfinish = cleanup;
  };
  running.set(row, cleanup);
  animation.onfinish = cleanup;
  preference.addEventListener('change', interrupt, { signal: events.signal });
  for (const event of ['pointerdown', 'keydown', 'beforeinput']) row.addEventListener(event, interrupt, { capture: true, signal: events.signal });
}
