# 006 — Days that arrive later settle in

- **Status**: DONE
- **Commit**: 070f076
- **Severity**: LOW (missed opportunity)
- **Category**: Missed opportunities / Cohesion (stagger)
- **Depends on**: 001

## Problem

`DayBlock` (`src/components/Journal.tsx:52`) has no entrance. A view now opens on today and the earlier days arrive a moment later; those days, and days loaded on scroll or inserted by a date jump, appear all at once.

## Target

- `Journal` remembers the dates of its first paint. Each date that appears afterwards gets a stable arrival index, counted within the batch it arrived in and capped at 6, held in a ref so a later render never changes its class mid-transition.
- An arriving `DayBlock`:

```css
opacity: 1; transform: none;
@starting-style { opacity: 0; transform: translateY(4px); }
transition: opacity 180ms var(--ease-out) <index * 40>ms, transform 240ms var(--ease-out) <index * 40>ms;
@media (prefers-reduced-motion: reduce) { transition-property: opacity; }
```

- Days on the first paint never animate (the view's own entrance covers them).

## Boundaries

- The stagger is decorative and must never delay interaction: no `pointer-events` or visibility changes.

## Verification

- **Feel check**: pick a tag that has no saved copy. Today appears with the view; the earlier days rise in just behind it, one after another, and are finished within half a second.
