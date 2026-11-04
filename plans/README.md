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
| 008 | [Haptics that mean something](008-haptics-that-mean-something.md) | HIGH | — | DONE |
| 009 | [Hover only where there is hover](009-hover-only-where-there-is-hover.md) | HIGH | — | DONE |
| 010 | [Touch paths for hover reveals](010-touch-paths-for-hover-reveals.md) | HIGH | 009 | DONE |
| 011 | [Keyboard actions answer at once](011-keyboard-actions-answer-at-once.md) | MEDIUM | — | DONE |
| 012 | [Folds close the way they open](012-folds-close-the-way-they-open.md) | MEDIUM | — | DONE |
| 013 | [One set of curves](013-one-set-of-curves.md) | MEDIUM | — | DONE |
| 014 | [The phone shell](014-the-phone-shell.md) | MEDIUM | — | DONE |
| 015 | [Arrivals and rare moments](015-moments-and-arrivals.md) | MEDIUM | 008 | DONE |

Execution order: 001 → 003 → 002 → 004 → 005 → 006 → 007.

Second audit (0082bdc): 008 → 009 → 010 → 013 → 011 → 012 → 015 → 014.
