# 015 — Arrivals in the stats panel, and the rare moments

- **Status**: DONE
- **Commit**: 0082bdc
- **Severity**: MEDIUM
- **Category**: Interruptibility / Missed opportunities
- **Executed note**: the parent's check lands 120ms after the child's. `useTaskCompletion` previews the child alone, then adds the ancestors it finishes after `CASCADE_BEAT_MS`; a later check drops the late one.
- **Estimated scope**: StatsModal.tsx, HabitRows.tsx, useTaskCompletion.ts, OutlineStyles.ts

## Problem

- Removing a pill in the stats heading waits 340ms for `closePill` before saving, with no guard. A double click toggles the day twice. Pills are keyed by habit alone, so a closed pill is reused on the next hovered day at width 0, and a failed save leaves it invisible.
- A habit added or removed in the stats panel appears or vanishes in one frame.
- Finishing today's last habit, a parent finished by its last child, and a streak milestone all go unmarked.

## Target

- The heading's pill saves at once and closes alongside: a `leaving` guard, the key `${day}-${habit.id}`, and on failure the closing animation reversed.
- A new habit row enters with `@starting-style { opacity: 0; transform: translateY(4px); }` and a 180/240ms `var(--ease-out)` transition. A removed row leaves with `collapseRow` before it is dropped.
- When the last of today's habits is checked: a `celebrate` haptic, and today's pills in the logbook arrive with a 40ms stagger.
- When a completion cascades to a parent: `celebrate`, and the parent's check runs 120ms after the child's. When a check takes a streak to 7, 30, 100 or 365 days: `celebrate`.
