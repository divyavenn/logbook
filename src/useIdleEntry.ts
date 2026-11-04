import { useEffect } from 'react';

// Page-level typing belongs to the last writing area the reader used. In a
// separate pane it belongs to that pane; the initial destination is today's log.
export function useIdleEntry() {
  useEffect(() => {
    let last: HTMLElement | null = null;
    const visible = (element: HTMLElement) => element.offsetParent !== null
      && !element.closest('[inert], [aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden';
    const remember = (event: Event) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-default-entry]') : null;
      if (element) last = element;
    };
    const type = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing
        || Array.from(event.key).length !== 1 || document.querySelector('dialog[open]')) return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest('input, textarea, select, [contenteditable], [role="textbox"], [data-outline-key]')) return;
      // Space still activates a focused button, and a page selection belongs
      // to the range editor rather than a fresh entry.
      if (event.key === ' ' && active instanceof Element && active.closest('button, a, [role="button"]')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const candidates = [...document.querySelectorAll<HTMLElement>('[data-default-entry]')].filter(visible);
      const target = last && candidates.includes(last) ? last
        : candidates.find(element => element.dataset.defaultEntry === 'notes') ?? candidates[0];
      if (!target) return;
      event.preventDefault();
      target.dispatchEvent(new CustomEvent('still-start-entry', { detail: event.key }));
    };
    document.addEventListener('pointerdown', remember);
    document.addEventListener('focusin', remember);
    document.addEventListener('keydown', type);
    return () => {
      document.removeEventListener('pointerdown', remember);
      document.removeEventListener('focusin', remember);
      document.removeEventListener('keydown', type);
    };
  }, []);
}
