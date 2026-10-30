# 005 — Colour changes use `ease`

- **Status**: DONE
- **Commit**: 070f076
- **Severity**: LOW
- **Category**: Easing & duration

## Problem

Colour transitions use `ease-out`, e.g. `src/components/OutlineStyles.ts:186` `transition: color 200ms ease-out;` and `press` in `src/styles.ts:125`. Hover and colour changes should use `ease`.

## Target

Every `color`, `background-color`, `border-color` (and the `transition-property: background-color, border-color` marker at `OutlineStyles.ts:118`) uses `ease`. Durations are unchanged. Transform, scale and opacity transitions are untouched.

## Steps

1. In `src/`, replace `(background-|border-)?color <n>ms ease-out` with the same text ending in `ease`.
2. `OutlineStyles.ts:118`: set `transition-timing-function: ease`.

## Verification

- `npm run build`; the full Playwright suite passes. Hover a link and a tag: no visible change beyond a softer start.
