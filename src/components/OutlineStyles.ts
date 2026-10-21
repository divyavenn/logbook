import styled, { css } from 'styled-components';
import { richTextStyles } from '../markdown';
import { compactViewport } from '../layout';
import { TASK_PROGRESS_MS } from '../taskCompletion';

export const OutlineSurface = styled.div`
  position: relative; outline: none;
  --entry-size: 15px;
  --entry-row-height: 28px;
  --entry-padding: 4px 0;
  --entry-line-height: 1.25;
  --entry-paragraph-gap: .2em;
  --entry-marker-offset: .5px;
  @media(pointer: coarse) { --entry-size: 16px; --entry-row-height: 44px; --entry-padding: 10px 0; --entry-line-height: 1.4; }
  @media ${compactViewport} { --entry-row-height: 36px; --entry-padding: 6px 0; --entry-line-height: 1.35; --entry-paragraph-gap: .1em; }
`;
export const List = styled.ul`list-style: none; padding: 0; margin: 0;`;
export const Children = styled(List)<{ $task: boolean }>`
  padding-left: ${({ $task }) => $task ? '28px' : '32px'};
  @media(max-width: 900px) { padding-left: ${({ $task }) => $task ? '20px' : '24px'}; }
  @media(max-width: 440px) { padding-left: 12px; }
  @media ${compactViewport} { padding-left: 9px; }
`;
export const Row = styled.div`position: relative; display: flex; align-items: flex-start; min-height: var(--entry-row-height);`;
export const Item = styled.li<{ $leaving?: boolean; $arriving?: boolean; $gestureSelected?: boolean; $rangeSelected?: boolean; $dragX?: number }>`
  min-width: 0; transform-origin: left center; translate: ${({ $dragX = 0 }) => $dragX ? `${$dragX}px 0` : 'none'};
  opacity: ${({ $leaving }) => $leaving ? 0 : 1};
  transform: ${({ $leaving }) => $leaving ? 'translateY(-3px)' : 'none'};
  transition-property: opacity, transform, translate;
  /* A swipe follows the finger, so only its return trip is animated. */
  transition-duration: ${({ $leaving }) => $leaving ? '180ms, 180ms' : '280ms, 280ms'}, ${({ $dragX = 0 }) => $dragX ? '0s' : '220ms'};
  transition-timing-function: cubic-bezier(.2, 0, 0, 1);
  ${({ $arriving }) => $arriving && css`@starting-style { opacity: 0; transform: translateY(-7px); }`}
  > ${Row} { transition: background-color 120ms ease-out, box-shadow 140ms ease-out; }
  &[data-drop-position="before"] > ${Row} { box-shadow: 0 -1px 0 var(--link); }
  &[data-drop-position="after"] > ${Row} { box-shadow: 0 1px 0 var(--link); }
  /* A selection covering whole entries marks the entries, not their text. */
  ${({ $rangeSelected, $gestureSelected }) => $rangeSelected && !$gestureSelected && css`
    > ${Row} { background: color-mix(in srgb, var(--link) 10%, transparent); border-radius: 6px; }
    > ${Row} ::selection { background: transparent; color: inherit; }
  `}
  ${({ $gestureSelected }) => $gestureSelected && css`
    user-select: none; -webkit-user-select: none;
    > ${Row} { background: color-mix(in srgb, var(--link) 10%, transparent); border-radius: 6px; cursor: grab; }
    > ${Row}:active { cursor: grabbing; }
    /* The whole row is the drag handle: a press on the text must not start a
       text drag, nor collapse the selection before the entry can move. */
    > ${Row} .tiptap { pointer-events: none; }
    > ${Row} .tiptap::selection, > ${Row} .tiptap *::selection { background: transparent; color: inherit; }
  `}
  @media(pointer: coarse) { touch-action: pan-y; }
`;
// How long a branch takes to grow. Anything following that growth, such as
// scrolling a parent up to reveal its children, shares the same window.
export const BRANCH_OPEN_MS = 320;
export const Branch = styled.div<{ $open: boolean; $editing: boolean }>`
  display: grid; min-height: 0;
  grid-template-rows: ${({ $open }) => $open ? '1fr' : '0fr'};
  opacity: ${({ $open }) => $open ? 1 : 0};
  transform: ${({ $open }) => $open ? 'none' : 'translateY(-3px)'};
  visibility: ${({ $open }) => $open ? 'visible' : 'hidden'};
  pointer-events: ${({ $open }) => $open ? 'auto' : 'none'};
  transition-property: grid-template-rows, opacity, transform, visibility;
  transition-duration: ${BRANCH_OPEN_MS}ms, 240ms, ${BRANCH_OPEN_MS}ms, 0s;
  transition-timing-function: cubic-bezier(.2, 0, 0, 1);
  transition-delay: ${({ $open }) => $open ? '0s' : `0s, 60ms, 0s, ${BRANCH_OPEN_MS}ms`};

  > ${Children} { min-height: 0; overflow: hidden; }
  > ${Children} > ${Item} > ${Row} {
    opacity: ${({ $open }) => $open ? 1 : 0};
    transform: ${({ $open }) => $open ? 'none' : 'translateY(-3px)'};
    transition-property: opacity, transform;
    transition-duration: 220ms, 280ms;
    transition-timing-function: ease-out;
  }
  ${({ $open }) => $open && css`
    > ${Children} > ${Item}:nth-child(2) > ${Row} { transition-delay: 35ms; }
    > ${Children} > ${Item}:nth-child(3) > ${Row} { transition-delay: 70ms; }
    > ${Children} > ${Item}:nth-child(4) > ${Row} { transition-delay: 105ms; }
    > ${Children} > ${Item}:nth-child(n + 5) > ${Row} { transition-delay: 140ms; }
  `}
  ${({ $editing }) => $editing && css`
    transition: none;
    > ${Children} > ${Item} > ${Row} { transition: none; }
  `}

  @media (prefers-reduced-motion: reduce) {
    transition: none;
    > ${Children} > ${Item} > ${Row} { transition: none; }
  }
`;
export const ComposerTarget = styled.button<{ $floating: boolean }>`
  display: block; width: 100%; min-height: var(--entry-row-height); padding: 0; border: 0; background: transparent;
  ${({ $floating }) => $floating && 'position: absolute; top: 100%; height: 20px; min-height: 20px;'}
  @media(pointer: coarse) { min-height: 44px; }
  @media ${compactViewport} { min-height: 36px; }
`;
export const Marker = styled.span<{ $task: boolean }>`
  display: flex; width: 40px; min-width: 40px; height: var(--entry-row-height); align-items: center; justify-content: center; color: var(--ink);
  &::before { content: ${({ $task }) => $task ? "''" : "'–'"}; font-size: 14px; translate: 0 var(--entry-marker-offset);
    ${({ $task }) => $task ? 'width: 12px; height: 12px; border: 1.25px solid currentColor; border-radius: 50%;' : ''} }
  @media(pointer: coarse) { width: 44px; min-width: 44px; height: 44px; }
  @media ${compactViewport} { width: 36px; min-width: 36px; height: 36px; }
`;
export const DraftItem = styled(Item)<{ $emptyTask: boolean }>`
  ${({ $emptyTask }) => $emptyTask && css`
    > ${Row} > ${Marker} { visibility: hidden; }
    &:focus-within > ${Row} > ${Marker} { visibility: visible; }
  `}
`;
export const Checkbox = styled.button<{ $checked?: boolean; $suppressPreview?: boolean }>`
  position: relative; display: flex; align-items: center; justify-content: center; width: 40px; min-width: 40px; height: var(--entry-row-height);
  border: 0; padding: 0; background: transparent; border-radius: 50%; color: var(--ink);
  transition: transform 120ms ease-out; &:active { transform: scale(0.96); }
  &:disabled { opacity: 1; }
  &::before { content: ''; width: 12px; height: 12px; border: 1.25px solid currentColor; border-radius: 50%; translate: 0 var(--entry-marker-offset); transition-property: background-color, border-color; transition-duration: 120ms; transition-timing-function: ease-out; }
  &::after { content: ''; position: absolute; width: 7px; height: 7px; background: currentColor;
    mask: url('/icons/check-flaticon.svg') center / contain no-repeat;
    -webkit-mask: url('/icons/check-flaticon.svg') center / contain no-repeat;
    opacity: ${({ $checked }) => $checked ? 1 : 0}; scale: ${({ $checked }) => $checked ? 1 : .25}; translate: 0 var(--entry-marker-offset);
    filter: blur(${({ $checked }) => $checked ? 0 : 4}px);
    transition-property: opacity, scale, filter; transition-duration: 150ms; transition-timing-function: cubic-bezier(.2, 0, 0, 1); }
  @media (hover: hover) {
    ${({ $checked, $suppressPreview }) => !$suppressPreview && css`
      &:hover::before { background: transparent; border-color: var(--link); }
      &:hover::after { opacity: ${$checked ? 0 : 1}; scale: ${$checked ? .25 : 1};
        filter: blur(${$checked ? 4 : 0}px); background: var(--link); }
    `}
  }
  @media(pointer: coarse) { width: 44px; min-width: 44px; height: 44px; }
  @media ${compactViewport} { width: 36px; min-width: 36px; height: 36px; }
`;
export const Disclosure = styled.button<{ $open: boolean; $task: boolean; $done: boolean; $progress: number }>`
  position: relative; width: 40px; min-width: 40px; height: var(--entry-row-height); padding: 0; border: 0;
  display: grid; place-items: center; background: transparent; border-radius: 4px; color: ${({ $task, $done }) => $task && !$done ? 'var(--ink)' : 'var(--muted)'};
  transition: color 140ms ease-out;
  &::before { content: ''; width: 5px; height: 5px; border-right: 1.25px solid currentColor; border-bottom: 1.25px solid currentColor; translate: 0 var(--entry-marker-offset);
    transform: rotate(${({ $open }) => $open ? '45deg' : '-45deg'}); transition: transform 140ms ease-out; }
  /* A parent task wears the same bubble as any task, and the pie fills it in
     only while it is partly done. Finished, it is a parent again. */
  ${({ $task, $done, $progress }) => $task && css`
    &::before { --task-progress: ${$progress * 360}deg; width: 12px; height: 12px; border: 1.25px solid currentColor; border-radius: 50%; transform: none;
      /* Filling the border box leaves no hairline inside the ring, which a
         fractional zoom would otherwise expose. */
      background: ${$done ? 'transparent' : 'conic-gradient(currentColor var(--task-progress), transparent 0)'};
      background-origin: border-box; background-clip: border-box;
      transition: --task-progress ${TASK_PROGRESS_MS}ms cubic-bezier(.2, 0, 0, 1); }
  `}
  /* Three dots mark it as a parent whenever the pie is not showing. The 14px
     box matches the bubble's 12px interior and rendered borders. */
  ${({ $done, $progress }) => {
    const bare = $done || $progress === 0;
    return css`
      > svg { position: absolute; width: 14px; height: 14px; overflow: hidden; pointer-events: none; translate: 0 var(--entry-marker-offset);
        opacity: ${bare ? 1 : 0}; scale: ${bare ? 1 : .25}; filter: blur(${bare ? 0 : 4}px);
        transition: opacity ${TASK_PROGRESS_MS}ms cubic-bezier(.2, 0, 0, 1), scale ${TASK_PROGRESS_MS}ms cubic-bezier(.2, 0, 0, 1), filter ${TASK_PROGRESS_MS}ms cubic-bezier(.2, 0, 0, 1); }
    `;
  }}
  &:disabled { opacity: 1; }
  @media(pointer: coarse) { width: 44px; min-width: 44px; height: 44px;
  }
  @media ${compactViewport} { width: 36px; min-width: 36px; height: 36px; }
`;
export const Text = styled.div<{ $done?: boolean; $action?: boolean; $strikeable?: boolean }>`
  ${richTextStyles}; cursor: text;
  flex: ${({ $action }) => $action ? '0 1 auto' : '1'}; min-width: 0; min-height: var(--entry-row-height); padding: var(--entry-padding); border: 0; background: transparent; color: var(--ink);
  /* A row that can be checked off carries its rule all along, so completing
     it draws the line on rather than striking it through at once. */
  ${({ $strikeable, $done }) => ($strikeable ?? $done) && css`
    text-decoration: line-through;
    text-decoration-color: ${$done ? 'currentColor' : 'transparent'};
    /* Selected text is repainted in the selection's own colours, which would
       draw the rule that is waiting to be drawn. */
    ${!$done && css`&::selection, & *::selection { text-decoration-line: none; }`}
  `}
  ${({ $done }) => $done && css`color: var(--muted); a { color: var(--muted); }`}
  transition: color 200ms ease-out, text-decoration-color 200ms ease-out;
  text-align: left; line-height: var(--entry-line-height); font-size: var(--entry-size); white-space: pre-wrap; overflow-wrap: anywhere;
  &:focus-visible { outline: none; }
`;
