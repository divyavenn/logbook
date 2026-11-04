# 010 — A way in by touch for everything hover reveals

- **Status**: DONE
- **Commit**: 0082bdc
- **Severity**: HIGH
- **Category**: Accessibility / Missed opportunities
- **Estimated scope**: StatsModal.tsx, Journal.tsx, HabitRows.tsx, ConsistencyChart.tsx

## Problem

- `StatsModal.tsx` `AddField`: the placeholder is transparent unless hovered or focused. On a phone, the foot of the list is a blank line.
- `Journal.tsx` `FoldGhost`: the count shows only on `:hover`/`:focus-visible`. On touch, a folded run is a blank gap.
- `Journal.tsx` day reveal under `(hover: none)`: a tap on a past day's date makes the details visible through sticky hover while they keep `pointer-events: none`. They look tappable and are not.
- `HabitRows.tsx` `Pill`: the check turns into × on hover only. On touch, the first tap undoes the day with no warning.
- `ConsistencyChart.tsx` `onPointerOver` previews for touch pointers too, so the heading flickers as a finger scrolls across the chart.

## Target

- Under `(hover: none)`:
  - The add-a-habit placeholder is always shown.
  - The ghost of a folded run shows at `opacity: .5`.
  - The day reveal follows a day that has been tapped: a `data-in-hand` attribute set on the DayBlock by a tap on its date (cleared by a tap elsewhere) shows and enables its details, as focus does on desktop.
- The pill shows its × on `:active` too, so the finger-down frame warns.
- The chart's `onPointerOver` ignores `pointerType === 'touch'`; taps already select.

## Verification

- **Mechanical**: `npx playwright test tests/habits.spec.ts tests/quiet-days.spec.ts tests/mobile.spec.ts`.
- **Feel check**: in touch emulation, the add-a-habit hint, the folded "N days" and a tapped day's pills are all visible and tappable.
