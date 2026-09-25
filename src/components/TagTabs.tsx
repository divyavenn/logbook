import { useRef, useState, type ReactNode } from 'react';
import styled from 'styled-components';
import type { Tag } from '../types';
import { narrowViewport } from '../layout';

const Backdrop = styled.div<{ $open: boolean }>`
  position: fixed; inset: 0; z-index: 40;
  background: var(--backdrop); backdrop-filter: blur(4px);
  opacity: ${({ $open }) => $open ? 1 : 0};
  visibility: ${({ $open }) => $open ? 'visible' : 'hidden'};
  pointer-events: none;
  transition: opacity 140ms ease-out, visibility 140ms;
  body:has(dialog[open]) & { display: none; }
  @media ${narrowViewport} { display: none; }
`;
const Rail = styled.nav<{ $open: boolean }>`
  --sidebar-width: max(var(--left-margin), min(280px, calc(100vw - 48px)));
  position: fixed; inset: 0 auto 0 0; z-index: 41;
  width: ${({ $open }) => $open ? 'var(--sidebar-width)' : 'calc(var(--left-margin) / 2)'};
  outline: none;
  body:has(dialog[open]) & { display: none; }
  @media ${narrowViewport} { display: none; }
`;
const Panel = styled.div<{ $open: boolean }>`
  position: absolute; inset: 0 auto 0 0; width: var(--sidebar-width);
  padding: 48px clamp(24px, calc(var(--sidebar-width) * .12), 48px) 32px;
  overflow-y: auto; background: var(--paper);
  opacity: ${({ $open }) => $open ? 1 : 0};
  transform: translateX(${({ $open }) => $open ? '0' : '-18px'});
  visibility: ${({ $open }) => $open ? 'visible' : 'hidden'};
  pointer-events: ${({ $open }) => $open ? 'auto' : 'none'};
  transition-property: opacity, transform, visibility;
  transition-duration: 180ms, 220ms, 0s;
  transition-timing-function: ease-out, cubic-bezier(.2, 0, 0, 1), linear;
  transition-delay: ${({ $open }) => $open ? '0s' : '0s, 0s, 220ms'};
`;
const RailActions = styled.div`
  display: flex; align-items: center; margin-top: 24px;
`;
const Heading = styled.h2`margin: 0 0 18px; font-size: 22px; font-weight: 400; letter-spacing: -.02em;`;
const Home = styled.button`
  min-height: 40px; padding: 0; border: 0; background: transparent; color: var(--ink);
  font: inherit; letter-spacing: inherit; text-align: left;
  @media(pointer: coarse) { min-height: 44px; }
`;
const Collection = styled.div`display: flex; flex-wrap: wrap; align-content: start; gap: 8px;`;
const TagPillLabel = styled.span`display: block; translate: 0 -1px;`;
const TagPill = styled.button`
  position: relative; max-width: 100%; min-height: 36px; padding: 6px 12px;
  border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--tag-ink);
  font-size: 14px; line-height: 20px; overflow-wrap: anywhere;
  &[aria-pressed='true'] { border-color: var(--tag-selected); color: var(--tag-selected); }
  transition: border-color 140ms ease-out, color 140ms ease-out;
  &::before { content: ''; position: absolute; inset: -2px; }
  @media(pointer: coarse) { min-height: 44px; &::before { inset: 0; } }
`;

export function TagTabs({ tags, active, onSelect, controls }: {
  tags: Tag[]; active: string | null; onSelect: (tag: string | null) => void; controls?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rail = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const show = () => {
    if (document.querySelector('dialog[open]')) return;
    if (!rail.current?.contains(document.activeElement)) previousFocus.current = document.activeElement as HTMLElement;
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    if (rail.current?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement)?.blur();
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    }
  };
  const select = (tag: string | null) => { close(); onSelect(tag); };

  return <>
    <Backdrop $open={open} aria-hidden="true" data-testid="tag-backdrop" />
    <Rail ref={rail} $open={open} aria-label="Tags" tabIndex={0} data-open={open} data-focus-surface
      onPointerEnter={show}
      onPointerLeave={() => {
        if (!rail.current?.matches(':focus-visible') && !rail.current?.querySelector(':focus-visible')) close();
      }}
      onFocusCapture={event => {
        if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) previousFocus.current = event.relatedTarget;
        show();
      }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <Panel data-testid="tag-panel" $open={open} aria-hidden={!open} inert={!open}>
        <Heading><Home type="button" onClick={() => select(null)}>logbook</Home></Heading>
        <Collection>
          <TagPill type="button" aria-pressed={active === null} onClick={() => select(null)}><TagPillLabel>all</TagPillLabel></TagPill>
          {tags.map(tag => <TagPill key={tag.name} type="button"
          aria-pressed={tag.name === active} onClick={() => select(tag.name)}><TagPillLabel>#{tag.name}</TagPillLabel></TagPill>)}</Collection>
        <RailActions>{controls}</RailActions>
      </Panel>
    </Rail>
  </>;
}
