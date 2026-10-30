# Animation plans

Written by the `improve-animations` audit of the logbook at 070f076.

| # | Plan | Severity | Depends on | Status |
|---|---|---|---|---|
| 001 | [Shared easing tokens](001-shared-easing-tokens.md) | MEDIUM | — | DONE |
| 002 | [View entrance inside the UI budget](002-view-enter-budget.md) | MEDIUM | 001 | DONE |
| 003 | [Rows close the gap they leave](003-rows-close-their-gap.md) | HIGH | 001 | DONE |
| 004 | [Reduced motion keeps fades](004-reduced-motion-keeps-fades.md) | MEDIUM | — | DONE |
| 005 | [Colour changes on `ease`](005-colour-on-ease.md) | LOW | — | DONE |
| 006 | [Days settle in](006-days-settle-in.md) | LOW | 001 | DONE |
| 007 | [Glide to a date](007-glide-to-a-date.md) | LOW | 001, 003 (shares src/motion.ts) | DONE |

Execution order: 001 → 003 → 002 → 004 → 005 → 006 → 007.
