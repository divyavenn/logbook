# 013 — One set of curves, and the sheet leaves faster than it comes

- **Status**: DONE
- **Commit**: 0082bdc
- **Severity**: MEDIUM
- **Category**: Easing & duration / Cohesion / Accessibility
- **Estimated scope**: Modal.tsx, HabitRows.tsx, OutlineStyles.ts, entryFeedback.ts, TagTabs.tsx, LockedEntryPreview.tsx, App.tsx

## Problem

- `Modal.tsx` runs `opacity 160ms ease-out, transform 160ms ease-out`, both ways, on the weak keyword, with no reduced-motion rule.
- `HabitRows.tsx` hand-types `'cubic-bezier(.23, 1, .32, 1)'` and `'cubic-bezier(.77, 0, .175, 1)'`.
- The branch's child rows use `ease-out` beside the parent's `var(--ease-out)` (OutlineStyles.ts).
- `entryFeedback.ts` uses `'ease-out'`.
- `TagTabs.tsx` uses `ease-out` and moves `translateX(-18px)` with no reduced-motion rule.
- `LockedEntryPreview.tsx` enters over 320/420ms.
- The checkbox tick (`OutlineStyles.ts` `Checkbox::after`) keeps its scale and blur under reduced motion.

## Target

- Modal arrives with `opacity 180ms var(--ease-out), transform 180ms var(--ease-out)` and leaves with `opacity 120ms var(--ease-out), transform 120ms var(--ease-out)` (asymmetric: the dismissal snaps). Under reduced motion, only opacity, display and overlay transition.
- Every hand-typed curve becomes `EASE_OUT`/`EASE_IN_OUT` in script, or `var(--ease-out)`/`var(--ease-in-out)` in CSS.
- `LockedEntryPreview` enters over 240ms.
- `TagTabs` and the checkbox tick drop movement under reduced motion and keep the fade.
