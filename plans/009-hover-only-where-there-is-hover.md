# 009 — Hover only where there is hover, and a press everywhere

- **Status**: DONE
- **Commit**: 0082bdc
- **Severity**: HIGH
- **Category**: Accessibility / Physicality
- **Estimated scope**: styles.ts, App.tsx, StatsModal.tsx, CalendarModal.tsx, SessionsModal.tsx, Journal.tsx, TagTabs.tsx, OutlineStyles.ts, ConsistencyChart.tsx, HabitRows.tsx

## Problem

Ungated `:hover` sticks after a tap on touch:
- `App.tsx` `pageControl`: `&:hover svg { scale: 1.05 }` and a link colour.
- `TimerButton`: `&:hover { background: var(--timer-hover) }`. After a tap the timer shows the hover colour, not its real state.
- `StatsModal.tsx` `DownloadLink`: `scale: 1.06`; `SymbolButton` span: `rotate(90deg)`. The same rotate is in `CalendarModal.tsx` and `SessionsModal.tsx`, and `SessionsModal` also has a `scale(1.12)`.
- `Journal.tsx` `DateHead` underline.

Places gated with `(hover: hover)` alone get false hovers on hybrid devices.

Pressables with no press feedback: `Disclosure` (OutlineStyles.ts), `TagPill`/`Home` (TagTabs.tsx), `DayTitle`, `Figure`, `SymbolButton`, `Confirm` (StatsModal.tsx), `FoldGhost`, `FoldSpine`, `SectionTitle` (Journal.tsx). The chart cell presses to `scale: .9` (ConsistencyChart.tsx), outside the 0.95–0.98 range.

## Target

- Every hover rule that moves or recolours sits in `@media (hover: hover) and (pointer: fine)`, including those currently gated by `(hover: hover)` alone.
- Press feedback is `scale: .96` on `:active`, with `transition: scale 120ms ease-out` (the existing `press` mixin in `src/styles.ts`). For the 1px spine, `:active` darkens the line to `var(--ink)` instead.
- The chart cell presses to `.96`.

## Verification

- **Mechanical**: `npx tsc -b`; `npx playwright test`.
- **Feel check**: in device emulation, tapping the theme toggle, timer, download and × leaves no tint, enlargement or rotation behind.
