# 014 — The phone shell: no pull-to-refresh, safe in landscape, installable

- **Status**: DONE
- **Commit**: 0082bdc
- **Severity**: MEDIUM
- **Category**: Mobile
- **Estimated scope**: styles.ts, App.tsx, Modal.tsx, index.html, public/manifest.webmanifest, public/icons

## Problem

- Nothing sets `overscroll-behavior` on the root, the mobile panes or the modal sheet. On Android a pull on a pane can reload the page mid-writing.
- `TimerChrome` (`right: 12px`) and `MobileTabs` (`left: 12px`) ignore the landscape safe areas.
- There is no web manifest, no `apple-touch-icon` and no status-bar meta.

## Target

- `html, body { overscroll-behavior: none; }`. `MobilePane` and the modal sheet use `overscroll-behavior: contain`.
- `right: max(12px, env(safe-area-inset-right))` and `left: max(12px, env(safe-area-inset-left))`.
- `public/manifest.webmanifest` with `display: standalone`, theme and background `#faf4ed`, and 192/512 icons. `apple-touch-icon` 180px PNG, rendered from `public/favicon.svg`. `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style` set to `default`.
- `100lvh` stays: it keeps the layout still while the keyboard overlays it (see tests/layout.spec.ts).
