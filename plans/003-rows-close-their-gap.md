# 003 — Close the gap a leaving row leaves

- **Status**: DONE
- **Commit**: 070f076
- **Severity**: HIGH
- **Category**: Missed opportunity (layout jump) / Performance
- **Depends on**: 001
- **Estimated scope**: src/motion.ts, Outline.tsx, OutlineStyles.ts, useTaskCompletion.ts

## Problem

Completing a root task fades its row (`$leaving`, 180ms, `src/components/OutlineStyles.ts:34-38`). `src/useTaskCompletion.ts:100` waits `180`ms and then refreshes. When the row is dropped, every row below jumps up its full height in one frame. A row leaving a filtered view does the same: it fades for `DEPART_MS` and is then dropped by `setRemoved` (`src/components/Outline.tsx:105-112`). The filed-task fade (`Outline.tsx:fileAway`) already collapses, but on its own curve, `cubic-bezier(.4, 0, .2, 1)` over 900ms.

## Target

One shared exit in `src/motion.ts`:

```ts
export const ROW_FADE_MS = 180;
export const ROW_COLLAPSE_MS = 220;
// Height is the one layout property animated here, on one element at a time,
// because it is the only way the rows below can follow.
export function collapseRow(row: HTMLElement, { after = 0, fade = 0, collapse = ROW_COLLAPSE_MS } = {}): Animation
export function restoreRow(row: HTMLElement, animation: Animation): void
```

- `collapseRow` sets `overflow: hidden` and animates height from `offsetHeight`px to 0 with `EASE_IN_OUT`, starting `after` ms in, with `fill: 'both'`. With `fade`, it first fades opacity 1 to 0 on `EASE_OUT` inside the same animation. Under reduced motion the collapse takes 0ms; the fade stays.
- `restoreRow` (interruption, e.g. a completion undone mid-exit or a failed refresh): if the animation has not left its delay, cancel it; otherwise `reverse()` it, so it retargets from where it is, and cancel and clear the overflow on finish.
- Completion and departure: the CSS fade stays as is (180ms / `DEPART_MS`). An effect in `Outline` starts `collapseRow(row, { after: fade })` for each id entering `completing`/`departing`, and `restoreRow` for each id leaving them while its row is still connected.
- `useTaskCompletion` waits `ROW_FADE_MS + ROW_COLLAPSE_MS` before refreshing. The `depart` timeout becomes `DEPART_MS + ROW_COLLAPSE_MS`. The row is therefore already closed when React drops it.
- Filing uses `collapseRow(row, { fade: FILE_FADE_MS, collapse: FILE_COLLAPSE_MS })` with `FILE_FADE_MS = 540` and `FILE_COLLAPSE_MS = 360` (deliberately slow; this was a user request).

## Boundaries

- Rows are found with `surface.current.querySelector('li[data-item-id="<id>"]')`. The draft row (`data-item-id="draft"`) is left to its CSS fade.
- Do NOT change how or when React removes rows, only how long it waits.

## Verification

- **Mechanical**: `npm run build`; `npx playwright test tests/workflows.spec.ts tests/tags.spec.ts tests/layout.spec.ts`.
- **Feel check**: complete the middle of three tasks at 10% playback. It fades, then the task below slides up into its place with no jump at the end. Click the checkmark again mid-exit: the row opens back up from where it was, without snapping.
