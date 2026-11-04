# 002 — Bring the view entrance inside the UI budget

- **Status**: DONE
- **Commit**: 070f076
- **Severity**: MEDIUM
- **Category**: Easing & duration
- **Depends on**: 001

## Problem

Switching tags (done many times a day) remounts the task list and logbook with:

```css
/* src/styles.ts:87-94 — current */
@starting-style { opacity: 0; transform: translateY(6px); }
transition-duration: 320ms, 420ms;
transition-timing-function: ease-out, cubic-bezier(.2, 0, 0, 1);
```

420ms is over the 300ms UI budget, and the fade uses the weak built-in `ease-out`.

## Target

```css
opacity: 1; transform: none;
@starting-style { opacity: 0; transform: translateY(4px); }
transition-property: opacity, transform;
transition-duration: 220ms, 260ms;
transition-timing-function: var(--ease-out);
@media (prefers-reduced-motion: reduce) { transition-property: opacity; }
```

## Steps

1. Replace the body of `viewEnter` in `src/styles.ts` with the target. Keep its `enabled &&` guard and its comment.

## Boundaries

- Do NOT touch `selectTag` / `flushSync` in `src/App.tsx`. The mobile page turn deliberately disables the entrance.

## Verification

- **Mechanical**: `npm run build`; `npx playwright test tests/tags.spec.ts`.
- **Feel check**: on desktop, click between tags quickly. Each swap lands in about a quarter second with no visible drift afterwards, and a quick second click never shows a view still rising.
