import styled, { createGlobalStyle, css } from 'styled-components';

// The paper at the very top of the page, which the status bar and the browser
// chrome take their colour from. Day and night are the reader's choice here
// rather than the system's, so the tag is kept in step by hand.
export const PAPER = { day: '#f2f1ed', night: '#011627' } as const;
export function applyTheme(night: boolean): void {
  document.documentElement.dataset.theme = night ? 'night' : 'day';
  const bar = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (bar) bar.content = night ? PAPER.night : PAPER.day;
}

export const GlobalStyle = createGlobalStyle`
  @property --task-progress { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
  @font-face { font-family: 'Sohne'; src: url('/fonts/sohne-variable.woff2') format('woff2'); font-weight: 100 900; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Sohne'; src: url('/fonts/sohne-italic.woff2') format('woff2'); font-weight: 400; font-style: italic; font-display: swap; }
  :root {
    color-scheme: light;
    --paper: #f2f1ed; --ink: #242422; --muted: #626762; --line: #d4d2cb; --sage: #59605d; --soft: #e8e6df;
    --surface: #faf9f6; --field: #fffefa; --date-bg: color-mix(in srgb, var(--muted) 22%, transparent); --tag-bg: #e8e6df; --tag-ink: #525a56; --tag-selected: #1871ba;
    --code-bg: #e6e7e1; --code-ink: #4d615d; --quote: #5f645f; --selection: #ccdbe7; --focus: #6f7f88;
    --link: #1871ba; --url: #70588f; --checkbox: #747773; --scrollbar: #c0beb7;
    --timer-ring: #9ba6ad; --timer: #56626b; --timer-hover: #626f78; --timer-ink: #faf9f6;
    --timer-running: #1871ba; --timer-running-hover: #267bc3; --timer-running-ring: #6f91b3;
    --page-paper: var(--paper); --page-focus-paper: color-mix(in srgb, var(--paper), #000 16%);
    --chrome-opacity: .76; --focus-chrome-opacity: .6;
    --primary: #354047; --primary-hover: #49565d; --primary-ink: #ffffff;
    --danger: #99493b; --backdrop: #2d343033; --chart: #a8b8c6; --chart-today: #557fa5; --chart-hover: #7395b4;
  }
  :root[data-theme='night'] {
    color-scheme: dark;
    --paper: #011627; --ink: #c0c7d1; --muted: #a3b0bf; --line: #294559; --sage: #b1c4cc; --soft: #193447;
    --surface: #0a2133; --field: #102a3f; --date-bg: color-mix(in srgb, var(--muted) 22%, transparent); --tag-bg: #26394a; --tag-ink: #c0c7d1; --tag-selected: #75d1c4;
    --code-bg: #183340; --code-ink: #9bc2b9; --quote: #a3b9be; --selection: #315366; --focus: #75d1c4;
    --link: #75d1c4; --url: #b7a4dd; --checkbox: #8ca0b0; --scrollbar: #35556a;
    --timer-ring: #486578; --timer: #24394a; --timer-hover: #304b60; --timer-ink: #dbe4ea;
    --timer-running: #335e62; --timer-running-hover: #3b686c; --timer-running-ring: #75a39e;
    --page-paper: var(--paper); --page-focus-paper: color-mix(in srgb, var(--paper), #000 20%);
    --chrome-opacity: 1; --focus-chrome-opacity: .78;
    --primary: #75d1c4; --primary-hover: #9ddece; --primary-ink: #011627;
    --danger: #efaa9c; --backdrop: #000b16aa; --chart: #355e65; --chart-today: #75d1c4; --chart-hover: #96e0d5;
  }
  * { box-sizing: border-box; }
  html {
    background: var(--paper); -webkit-font-smoothing: antialiased;
    /* A touch is answered by the page's own press states, not by the grey
       flash the browser paints over whatever was tapped. */
    -webkit-tap-highlight-color: transparent;
    /* Landscape must not inflate the writing. */
    -webkit-text-size-adjust: 100%;
  }
  body { margin: 0; color: var(--ink); background: var(--paper); font-family: 'Sohne', 'Helvetica Neue', Arial, sans-serif; font-size: 18px; font-weight: 300; line-height: 1.4; transition: background-color 160ms ease-out, color 160ms ease-out; }
  body:has(dialog[open]) { overflow: hidden; }
  button, input, textarea, select { font: inherit; color: inherit; }
  /* A control is not writing: a press is answered at once rather than after
     the wait for a second tap, and a long press on one takes hold of nothing.
     Entry text is writing, and stays selectable. */
  button, a, [role="button"], summary {
    touch-action: manipulation;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  button:not(:disabled), summary { cursor: pointer; }
  button:disabled { cursor: wait; opacity: .5; }
  :focus, :focus-visible { outline: none; }
  ::selection { background: var(--selection); }
  h1, h2, h3, p { margin: 0; }
  h1, h2, h3 { text-wrap: balance; font-weight: 400; }
  p, li { text-wrap: pretty; }
  svg { flex-shrink: 0; stroke-width: 1.5; }
  a { color: inherit; }
  /* Under 16px, a field zooms the page as it takes focus, and does not zoom
     back. The fields keep their size where there is a pointer to read them. */
  @media (pointer: coarse) {
    input:not([type='range']), textarea, select { font-size: 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
  }
`;

// Filtering remounts the views, so a swap can settle in rather than snap.
// Entry only: the outgoing view is gone before React inserts its replacement.
// The first paint is not a switch, and animating it would move the page under
// anything measuring it, so callers opt in once a view has actually changed.
export const viewEnter = (enabled: boolean) => enabled && css`
  opacity: 1; transform: none;
  @starting-style { opacity: 0; transform: translateY(6px); }
  transition-property: opacity, transform;
  transition-duration: 320ms, 420ms;
  transition-timing-function: ease-out, cubic-bezier(.2, 0, 0, 1);
  @media (prefers-reduced-motion: reduce) { transition: none; }
`;

// The ink wash that fades scrolled content into the page at a viewport edge.
export const edgeWash = (edge: 'top' | 'bottom') => css`
  position: absolute; z-index: 7; ${edge === 'top' ? 'top: -2px;' : 'bottom: 0;'} height: 30px; pointer-events: none;
  opacity: 1;
  background: linear-gradient(to ${edge === 'top' ? 'bottom' : 'top'}, var(--edge-paper) 0%, color-mix(in srgb, var(--edge-paper) 72%, transparent) 34%, transparent 82%);
  &::after {
    content: ''; position: absolute; inset: 0;
    background-image:
      radial-gradient(ellipse 22% 105% at 7% -8%, var(--edge-paper) 0 48%, transparent 82%),
      radial-gradient(ellipse 30% 92% at 31% -10%, var(--edge-paper) 0 44%, transparent 80%),
      radial-gradient(ellipse 24% 112% at 56% -18%, var(--edge-paper) 0 50%, transparent 84%),
      radial-gradient(ellipse 32% 96% at 82% -9%, var(--edge-paper) 0 42%, transparent 79%),
      radial-gradient(ellipse 18% 108% at 101% -16%, var(--edge-paper) 0 49%, transparent 83%);
    mask-image: linear-gradient(to bottom, #000 0%, #000d 40%, transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000d 40%, transparent 100%);
    opacity: .88;
    ${edge === 'bottom' && 'transform: rotate(180deg);'}
  }
`;

// Anything that appears should arrive rather than pop into place.
export const appear = (rise = '4px', ms = 180) => css`
  opacity: 1; transform: none;
  @starting-style { opacity: 0; transform: translateY(${rise}); }
  transition: opacity ${ms}ms ease-out, transform ${ms}ms cubic-bezier(.2, 0, 0, 1);
  @media (prefers-reduced-motion: reduce) { transition: none; }
`;

export const press = css`
  transition: background-color 120ms ease-out, color 120ms ease-out, scale 150ms ease-out;
  &:active:not(:disabled) { scale: .96; }
`;
export const IconButton = styled.button`
  ${press}; width: 44px; height: 44px; display: inline-flex; justify-content: center; align-items: center;
  border: 0; border-radius: 50%; background: transparent; color: var(--muted); flex-shrink: 0;
  &:hover { background: var(--soft); color: var(--ink); }
`;
export const Button = styled.button<{ $primary?: boolean }>`
  ${press}; min-height: 44px; padding: 8px 17px; display: inline-flex; justify-content: center; align-items: center; gap: 8px;
  border: 0; border-radius: 8px; background: ${({ $primary }) => $primary ? 'var(--primary)' : 'var(--soft)'};
  color: ${({ $primary }) => $primary ? 'var(--primary-ink)' : 'var(--ink)'}; font-size: 13px;
  &:hover { background: ${({ $primary }) => $primary ? 'var(--primary-hover)' : 'var(--date-bg)'}; }
`;
export const TextButton = styled.button`
  ${press}; min-height: 44px; border: 0; background: transparent; color: var(--sage);
  display: inline-flex; align-items: center; gap: 7px; padding: 4px 8px; font-size: 12px; border-radius: 6px;
  &:hover { background: var(--soft); }
`;
export const Eyebrow = styled.span`
  font-size: 10px; font-weight: 600; letter-spacing: 1.8px; text-transform: uppercase; color: var(--muted);
`;
export const Muted = styled.p`font-size: 13px; color: var(--muted);`;
export const Field = styled.input`
  width: 100%; min-height: 44px; border: 1px solid var(--line); border-radius: 7px;
  padding: 8px 11px; background: var(--field); font-size: 14px; min-width: 0;
`;
export const FieldLabel = styled.label`display: grid; gap: 6px; font-size: 12px; color: var(--muted);`;
export const InlineError = styled.p`font-size: 13px; color: var(--danger); margin: 12px 0;`;
export const Row = styled.div`display: flex; align-items: center; gap: 8px;`;
export const VisuallyHidden = styled.span`
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
`;
