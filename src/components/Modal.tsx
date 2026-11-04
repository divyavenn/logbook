import { useLayoutEffect, useId, useRef, type ReactNode } from 'react';
import styled from 'styled-components';
import { VisuallyHidden } from '../styles';

// A fitted sheet takes the width of what it holds, within the usual bounds.
const Sheet = styled.dialog<{ $wide: boolean; $compact: boolean; $fit: boolean; $instant: boolean }>`
  width: ${({ $wide, $compact, $fit }) => $fit ? 'fit-content' : `min(${$compact ? '420px' : $wide ? '720px' : '620px'}, calc(100vw - 32px))`};
  max-width: calc(100vw - 32px); max-height: calc(100dvh - 40px);
  padding: ${({ $compact }) => $compact ? '12px' : '32px'}; border: 0; border-radius: 16px; color: var(--ink); background: var(--surface);
  box-shadow: ${({ $compact }) => $compact ? '' : '0 0 0 1px #00000008,'} 0 16px 60px #202a2526; overflow-y: auto; overscroll-behavior: contain;
  /* The sheet rises in and lets go faster than it came: a dismissal answers
     at once. Opened from the keyboard, it neither rises nor fades. */
  opacity: 0; transform: translateY(8px); pointer-events: none;
  transition: opacity 120ms var(--ease-out), transform 120ms var(--ease-out), display 120ms allow-discrete, overlay 120ms allow-discrete;
  &[open] { opacity: 1; transform: translateY(0); pointer-events: auto; transition-duration: 180ms; }
  &::backdrop { background: var(--backdrop); backdrop-filter: blur(3px); opacity: 0; pointer-events: none;
    transition: opacity 120ms var(--ease-out), display 120ms allow-discrete, overlay 120ms allow-discrete; }
  &[open]::backdrop { opacity: 1; pointer-events: auto; transition-duration: 180ms; }
  @starting-style {
    &[open] { opacity: 0; transform: translateY(8px); }
    &[open]::backdrop { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    transform: none; &[open] { transform: none; }
    @starting-style { &[open] { transform: none; } }
  }
  ${({ $instant }) => $instant ? '&, &::backdrop, &[open], &[open]::backdrop { transition: none; }' : ''}
  @media (max-width: 500px) {
    width: calc(100vw - 16px); max-height: calc(100dvh - max(16px, env(safe-area-inset-top)) - max(16px, env(safe-area-inset-bottom)));
    padding: ${({ $compact }) => $compact ? '12px' : '22px 18px'}; border-radius: 18px;
  }
`;

export function Modal({ open, onClose, onAfterClose, title, children, wide = false, compact = false, fit = false, instant = false }: {
  open: boolean; onClose: () => void; onAfterClose?: () => void; title: string; children: ReactNode; wide?: boolean; compact?: boolean; fit?: boolean; instant?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const latest = useRef({ open, onAfterClose });
  latest.current = { open, onAfterClose };
  useLayoutEffect(() => {
    const dialog = ref.current!;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      // Closing releases focus and pointer input immediately. CSS keeps the
      // departing surface painted and reverses it if the dialog reopens.
      dialog.close(); latest.current.onAfterClose?.();
    }
  }, [open]);
  return <Sheet ref={ref} $wide={wide} $compact={compact} $fit={fit} $instant={instant} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => {
    if (e.target === e.currentTarget) {
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
    }
  }}>
    <VisuallyHidden id={titleId}>{title}</VisuallyHidden>
    {children}
  </Sheet>;
}
