# 012 — Folds close the way they open, and keep your place

- **Status**: DONE
- **Commit**: 0082bdc
- **Severity**: MEDIUM
- **Category**: Interruptibility / Performance
- **Estimated scope**: Journal.tsx

## Problem

- `{open && <FoldDays …>}` unmounts in one frame when the spine is pressed. Every date disappears and the days below snap up.
- When the run auto-closes after being scrolled past, all of its height vanishes above the viewport, and the text being read jumps. Safari has no scroll anchoring.
- `FoldDays` enters with opacity only; the rest of the app rises `translateY(4px)`.
- `FoldRun`'s `useLayoutEffect` runs on every render with no dependencies. It reads layout and writes `--spine-top`/`--spine-height` on the parent `[data-fold-days]`, which invalidates style for every row inside.

## Target

- A spine press collapses the run with the shared `collapseRow(element, { fade: ROW_FADE_MS })` from `src/motion.ts` (180ms fade, then a 220ms height collapse on `--ease-in-out`), and then unmounts it.
- An auto-close of a run above the viewport adds the run's lost height back as `scrollTop -= lost`, in the same frame, with no animation.
- `FoldDays` enters with `@starting-style { opacity: 0; transform: translateY(4px); }` and `transition: opacity 180ms var(--ease-out), transform 240ms var(--ease-out)`. Under reduced motion, only the opacity.
- The spine is measured only from a `ResizeObserver` (plus once on open), and writes `top`/`height` directly on the spine element.
