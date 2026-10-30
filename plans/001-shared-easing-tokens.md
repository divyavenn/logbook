# 001 — Put every curve on two shared tokens

- **Status**: DONE
- **Commit**: 070f076
- **Severity**: MEDIUM
- **Category**: Cohesion & tokens
- **Estimated scope**: 6 files, ~40 one-line edits plus one new module

## Problem

There are no easing tokens. The same mild curve is hand-typed 16 times, beside bare `ease-out` and one `cubic-bezier(.4, 0, .2, 1)`:

```css
/* src/components/OutlineStyles.ts:39 — current */
transition-timing-function: cubic-bezier(.2, 0, 0, 1);
/* src/styles.ts:92 — current */
transition-timing-function: ease-out, cubic-bezier(.2, 0, 0, 1);
```

`cubic-bezier(.2, 0, 0, 1)` is a gentle deceleration that is weaker than a strong UI ease-out, so arrivals read as soft rather than crisp. A JS copy of the same curve, `branchEasing` in `src/components/Outline.tsx:29-44`, is hard-wired to `(.2, 0, 0, 1)` so that the scroll lift stays in step with `Branch`.

## Target

```css
:root {
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);      /* entering, exiting, settling */
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);  /* moving on screen: scrolls, collapses */
}
```

- Every `cubic-bezier(.2, 0, 0, 1)` / `cubic-bezier(.2,0,0,1)` in `src/` becomes `var(--ease-out)`.
- A new `src/motion.ts` exports `EASE_OUT`, `EASE_IN_OUT` (the same strings), `bezier(x1, y1, x2, y2)` (a JS cubic-bezier solver), `easeOut`, `easeInOut` and `reducedMotion()`.
- `branchEasing` is deleted. The branch scroll lift uses `easeOut` from `src/motion.ts`.

## Repo conventions to follow

- Global CSS lives in `GlobalStyle` (`src/styles.ts`). Put the tokens in their own `:root { }` block above the themed `:root` blocks, because they belong to neither theme.
- Shared motion helpers are plain TS modules beside `src/layout.ts`. Imitate `src/taskCompletion.ts` (small constants plus pure functions).

## Steps

1. Add the token block to `GlobalStyle` in `src/styles.ts`.
2. Create `src/motion.ts` with the exports above. `bezier` binary-searches t for x, as `branchEasing` does today.
3. `rg -l "cubic-bezier\(\.2, ?0, ?0, ?1\)" src` and replace each occurrence with `var(--ease-out)`.
4. In `src/components/Outline.tsx`, delete `branchEasing` and use `easeOut` where it was called (the branch lift, around line 873).

## Boundaries

- Do NOT change durations in this plan.
- Do NOT touch `ease`/`ease-out` on colour transitions; that is plan 005.

## Verification

- **Mechanical**: `npm run build` passes; `rg "cubic-bezier\(\.2" src` returns nothing.
- **Feel check**: open a parent task's branch at 10% playback. It reaches its height quickly and settles long, and the pane's scroll lift travels on the same curve.
- **Done when**: the only cubic-bezier literals left in `src/` are in `src/styles.ts` (tokens) and `src/motion.ts`.
