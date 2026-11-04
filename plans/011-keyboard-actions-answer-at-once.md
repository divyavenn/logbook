# 011 — Keyboard actions answer at once

- **Status**: DONE
- **Commit**: 0082bdc
- **Severity**: MEDIUM
- **Category**: Purpose & frequency / Performance
- **Executed note**: the hover lift was kept. `tests/layout.spec.ts` ("expanding a parent at the foot of the task pane lifts it to show its children") specifies it deliberately, so it is a settled decision to raise with the owner, not re-litigate.
- **Estimated scope**: HabitRows.tsx, ConsistencyChart.tsx, Modal.tsx, SearchModal.tsx, RichTextEditor.tsx, Outline.tsx

## Problem

- Alt+Arrow habit reordering plays a 180ms move (`HabitRows.tsx` `useLayoutEffect` FLIP).
- Arrow keys on the chart fade the selection over 200ms, and pointer sweeps do too (`ConsistencyChart.tsx` `transition: background-color 200ms var(--ease-out)`).
- The search palette, opened with Cmd/Ctrl+F, inherits Modal's 160ms rise.
- The tag-suggestion popup and the mobile format bar animate `left`/`top`/`width` as they follow the caret (`RichTextEditor.tsx`). That is layout work on every frame, while typing.
- Hovering a parent's bullet glides the scroll pane under the pointer (`Outline.tsx` `revealChildren` called from `onPointerEnter`).

## Target

- The Alt+Arrow move is instant; the FLIP is removed.
- Chart cells change colour with `transition: background-color 120ms ease`. Hover and keyboard selection are instant: `transition: none` on `:hover` and on `[aria-current]`.
- `Modal` gains an `instant` prop that drops its transition; `SearchModal` uses it.
- The popup and format bar keep their opacity/transform appearance and drop `left`, `top` and `width` from their transitions.
- The hover preview still opens the branch, but only a click lifts the pane (`revealChildren` is no longer called from `onPointerEnter`).
