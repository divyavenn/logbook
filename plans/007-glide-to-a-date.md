# 007 — Travel to a date on a fixed, deliberate curve

- **Status**: DONE
- **Commit**: 070f076
- **Severity**: LOW (missed opportunity)
- **Category**: Easing & duration
- **Depends on**: 001

## Problem

`jumpToDate` (`src/App.tsx:637-644`) and the entry-link arrival (`src/components/Outline.tsx:260-290`) use `scrollTo({ behavior: 'smooth' })`, whose curve and duration belong to the browser and vary with distance. The arrival also re-aims every 420ms, and each re-aim starts a fresh browser scroll.

## Target

`src/motion.ts` gains:

```ts
export const GLIDE_MS = 420;
// Scrolls a pane to `top` on a curve of our own. A second call retargets from
// wherever the pane is; a scroll by the reader hands the pane back to them.
export function glide(pane: HTMLElement, top: number, { duration = GLIDE_MS, easing = easeInOut } = {}): void
```

- Under reduced motion, or for distances of 1px or less, it sets `scrollTop` directly.
- `jumpToDate`: `glide(pane, target)`, with the same approach the entry-link arrival uses: a jump of more than a screen first places the pane `clientHeight * .85` short of the target, on the side it is coming from.
- The entry-link arrival's first aim uses `easeInOut`. Its corrections use `easeOut`, so a correction never starts from rest mid-travel.
- The branch lift (`Outline.tsx`, plan 001) becomes `glide(scroller, start + lift, { duration: BRANCH_OPEN_MS, easing: easeOut })`.

## Verification

- **Mechanical**: `npx playwright test tests/entry-links.spec.ts tests/calendar.spec.ts tests/layout.spec.ts`.
- **Feel check**: open a date from a tag view. The page eases out of rest, travels, and settles in under half a second, from the side the date is on. Scrolling during the glide stops it at once.
