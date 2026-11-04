# 004 — Reduced motion drops movement, not feedback

- **Status**: DONE
- **Commit**: 070f076
- **Severity**: MEDIUM
- **Category**: Accessibility

## Problem

```css
/* src/styles.ts:78-80 — current */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
```

This removes every fade and colour change as well as movement, so state changes become instant for exactly the readers who need them to be clear.

## Target

- The global rule keeps only `scroll-behavior: auto !important`.
- Each moving helper drops its movement and keeps its opacity: `appear` and `viewEnter` (`src/styles.ts`), `Branch` and the marker glyph in `src/components/OutlineStyles.ts`, `TagCompletion` and `MobileFormatBar` in `src/components/RichTextEditor.tsx`, `ThemeGlyph` and the timer ring in `src/App.tsx`. In each `@media (prefers-reduced-motion: reduce)` block, use `transition-property: opacity` (plus colour properties where they exist) instead of `transition: none`.
- Infinite spinners keep their own `animation: none` (`src/components/CalendarModal.tsx:42`).

## Verification

- **Mechanical**: `npx playwright test tests/editor-interactions.spec.ts` (it emulates reduced motion).
- **Feel check**: in DevTools Rendering, emulate `prefers-reduced-motion: reduce`. Switching tags crossfades without rising, a branch appears without growing, and press and colour feedback remain.
