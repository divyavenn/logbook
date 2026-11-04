# 008 — Haptics that mean something, on every phone

- **Status**: DONE
- **Commit**: 0082bdc
- **Severity**: HIGH
- **Category**: Purpose & frequency / Missed opportunities
- **Executed note**: haptics do not follow `still-muted`. That key mutes the focus timer's sound only, and silencing touch with it would be a surprise. They follow the system's own haptics setting, as the iOS tick always does.
- **Estimated scope**: src/haptics.ts (rewrite), src/main.tsx, ~8 call sites

## Problem

`src/haptics.ts:8-19` vibrates on `pointerup` for any touched control, including `[contenteditable="true"]`, `input`, `a[href]` and `[role="group"][tabindex]`. Every caret placement buzzes, a press slid off its button (a cancelled click) buzzes, and a swipe ends in a buzz on the element it started on. Only the timer opts into `impact` (`src/App.tsx`, `data-haptic="impact"`), and it fires before the start or stop has worked. `haptic()` returns when `navigator.vibrate` is missing, so iOS Safari, which has none, gets nothing.

## Target

A small semantic vocabulary, called from the handlers that commit an action, never from a global listener:

| Kind | Android `navigator.vibrate` | When |
| --- | --- | --- |
| `selection` | `5` | page turn committed, chart day selected, stats row pinned, mobile tab chosen |
| `success` | `10` | task checked, habit checked, chart day toggled on |
| `soft` | `6` | task or habit reopened, habit day taken back |
| `start` | `14` | timer started |
| `stop` | `[8, 50, 8]` | timer stopped |
| `warning` | `[20, 40, 20]` | `entryError`; removing a habit for good |
| `celebrate` | `[10, 60, 10, 60, 24]` | last of today's habits done; a parent finished by its last child; a streak reaching 7, 30, 100 or 365 |

- On iOS (no `navigator.vibrate`), every kind plays the system tick by clicking a `<label>` bound to a hidden `<input type="checkbox" switch>`. It is mounted on `document.body` (outside the app's `inert` surface), visually hidden but not `display: none`, `tabindex="-1"`, `aria-hidden="true"`. It works only synchronously inside a user gesture, and on iOS 18 or later; elsewhere it does nothing harmful.
- No haptic while the document is hidden, and none under the existing sound mute (`localStorage['still-muted'] === '1'`).
- Async outcomes (timer stop) still fire at press time, inside the gesture. The press is what the hand felt.
- `installTouchHaptics` and `data-haptic` are removed.

## Boundaries

- Do NOT vibrate on focus, caret placement, scrolling or hover.
- Do NOT add dependencies.

## Verification

- **Mechanical**: `npx tsc -b`; `npx playwright test`.
- **Feel check** (real devices): on Android, typing in an entry never buzzes; checking a habit is a short success, and checking the last one is the longer celebrate pattern. On an iPhone with iOS 18 or later, checking a task gives a system tick and placing the caret gives none.
