// The curves the page moves on. CSS reads them as --ease-out and --ease-in-out
// (set in GlobalStyle); motion driven from script reads them here.
export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';

// A cubic-bezier as a function of elapsed time, for motion CSS cannot run.
export function bezier(x1: number, y1: number, x2: number, y2: number): (elapsed: number) => number {
  const curve = (first: number, second: number, step: number) => {
    const rest = 1 - step;
    return 3 * rest * rest * step * first + 3 * rest * step * step * second + step * step * step;
  };
  return elapsed => {
    if (elapsed <= 0) return 0;
    if (elapsed >= 1) return 1;
    let low = 0, high = 1, step = elapsed;
    for (let attempt = 0; attempt < 20; attempt++) {
      const position = curve(x1, x2, step);
      if (Math.abs(position - elapsed) < .0005) break;
      if (position < elapsed) low = step; else high = step;
      step = (low + high) / 2;
    }
    return curve(y1, y2, step);
  };
}
export const easeOut = bezier(.23, 1, .32, 1);
export const easeInOut = bezier(.77, 0, .175, 1);

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A browser smooth scroll runs on its own curve, for as long as the distance
// asks, and reads as a movement apart from anything beside it. A glide runs on
// ours. A second glide retargets from wherever the pane is; a scroll by the
// reader hands the pane back to them.
export const GLIDE_MS = 420;
const glides = new WeakMap<HTMLElement, number>();
export function glide(pane: HTMLElement, top: number, { duration = GLIDE_MS, easing = easeInOut } = {}): void {
  cancelAnimationFrame(glides.get(pane) ?? 0);
  glides.delete(pane);
  const start = pane.scrollTop, distance = top - start;
  if (reducedMotion() || Math.abs(distance) <= 1) { pane.scrollTop = top; return; }
  const begun = performance.now();
  let placed = start;
  const step = () => {
    if (Math.abs(pane.scrollTop - placed) > 1) { glides.delete(pane); return; }
    const elapsed = Math.min(1, (performance.now() - begun) / duration);
    pane.scrollTop = start + distance * easing(elapsed);
    placed = pane.scrollTop;
    if (elapsed < 1) glides.set(pane, requestAnimationFrame(step));
    else glides.delete(pane);
  };
  glides.set(pane, requestAnimationFrame(step));
}

// A row leaving a list closes the space it held, so the rows below slide up
// into it instead of jumping the moment it is dropped. Height is the one
// layout property animated here, on one row at a time, because it is the only
// way the rows below can follow.
export const ROW_FADE_MS = 180;
export const ROW_COLLAPSE_MS = 220;
export function collapseRow(row: HTMLElement, { after = 0, fade = 0, collapse = ROW_COLLAPSE_MS } = {}): Animation {
  const height = `${row.offsetHeight}px`;
  row.style.overflow = 'hidden';
  // Without motion the space closes at once; a fade is not motion, and stays.
  const closing = reducedMotion() ? 0 : collapse;
  const span = Math.max(1, fade + closing);
  const keyframes: Keyframe[] = fade
    ? [{ opacity: 1, height, easing: EASE_OUT }, { opacity: 0, height, offset: Math.min(1, fade / span), easing: EASE_IN_OUT }, { opacity: 0, height: '0px' }]
    : [{ height, easing: EASE_IN_OUT }, { height: '0px' }];
  return row.animate(keyframes, { duration: span, delay: after, fill: 'both' });
}
// The leave was called off: the row opens back up from wherever it had got to.
export function restoreRow(row: HTMLElement, animation: Animation): void {
  const clear = () => { animation.cancel(); row.style.overflow = ''; };
  if (!animation.effect?.getComputedTiming().progress) { clear(); return; }
  animation.onfinish = clear;
  animation.reverse();
}
