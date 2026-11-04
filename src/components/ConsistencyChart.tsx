import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import styled, { css } from 'styled-components';
import { dateObject, localDate } from '../api';

// A day's square deepens from the chart's resting colour to today's as the
// level rises; an empty day keeps the quiet ground of the sheet.
const shade = (level: number) => level <= 0 ? 'var(--soft)'
  : `color-mix(in srgb, var(--chart-today) ${Math.round((level - 1) / 3 * 100)}%, var(--chart))`;

export type ChartOrientation = 'vertical' | 'horizontal';

const CELL = 16;
const GAP = 4;
// Enough weeks to read the recent run at a glance; older ones are a scroll away.
const VISIBLE_WEEKS = 8;
const FADE = 20;

// Upright, weeks run down from this one and fade at the bottom; lying down,
// they run left to this one, which is where the chart opens, and fade at the left.
const Viewport = styled.div<{ $orientation: ChartOrientation }>`
  max-width: 100%; scrollbar-width: thin; scrollbar-color: var(--scrollbar) transparent;
  ${({ $orientation }) => $orientation === 'vertical' ? css`
    width: fit-content; max-height: ${VISIBLE_WEEKS * (CELL + GAP) + FADE}px; overflow-y: auto; overscroll-behavior-y: contain;
    padding: 0 10px ${FADE}px 0;
    mask-image: linear-gradient(to bottom, #000 calc(100% - ${FADE}px), transparent);
  ` : css`
    overflow-x: auto; overscroll-behavior-x: contain; padding: 0 0 8px ${FADE}px;
    mask-image: linear-gradient(to right, transparent, #000 ${FADE}px);
  `}
`;
const Frame = styled.div<{ $orientation: ChartOrientation; $weeks: number }>`
  display: grid; gap: ${GAP}px; width: max-content; color: var(--muted); font-size: 9px; line-height: 1;
  ${({ $orientation, $weeks }) => $orientation === 'vertical'
    ? css`grid-template-columns: repeat(7, ${CELL}px); grid-auto-rows: ${CELL}px;`
    : css`grid-template-columns: repeat(${$weeks}, ${CELL}px); grid-template-rows: repeat(7, ${CELL}px);`}
`;
// The selected day is filled with the chart's mark; a day under the pointer is
// half way there.
const Cell = styled.span<{ $level: number; $future: boolean; $selected?: boolean }>`
  display: block; padding: 0; border: 0; border-radius: 3px;
  background: ${({ $level, $selected }) => $selected ? 'var(--chart-select)' : shade($level)};
  visibility: ${({ $future }) => $future ? 'hidden' : 'visible'};
  /* A day's colour eases as it is marked or as the chart changes hands; the
     day under the pointer, or moved to by the keyboard, shows at once. */
  transition: background-color 120ms ease;
  &:hover, &[aria-current] { transition: none; }
  @media (hover: hover) and (pointer: fine) { &:hover { background: ${({ $level, $selected }) => $selected ? 'var(--chart-select)' : `color-mix(in srgb, var(--chart-select) 50%, ${shade($level)})`}; } }
  &:is(button) { cursor: pointer; &:active { scale: .96; } transition: background-color 120ms ease, scale 120ms ease-out; }
  &:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
`;

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

// Each day that has come is a button. Pressing a day selects it; pressing the
// selected day again toggles it, where the chart has anything to toggle. The
// chart is one stop for the keyboard: its arrows move the selection by day and
// by week the way the squares lie, and Enter toggles. onHover hears of the day
// under the pointer as it changes.
export function ConsistencyChart({ levels, end, weeks = 26, label, describe, orientation = 'vertical', selected, onSelect, onToggle, onHover }: {
  levels: ReadonlyMap<string, number>; end: string; weeks?: number; label: string;
  describe: (date: string, level: number) => string; orientation?: ChartOrientation;
  selected: string; onSelect: (date: string) => void; onToggle?: (date: string) => void; onHover?: (date: string | null) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const last = dateObject(end);
  const sunday = addDays(last, -last.getDay());
  // Newest week first; lying down, the chart reads it from the right.
  const recent = Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => localDate(addDays(sunday, day - week * 7))));
  const vertical = orientation === 'vertical';
  const first = localDate(addDays(sunday, -(weeks - 1) * 7));
  const press = (date: string) => { if (date === selected) onToggle?.(date); else onSelect(date); };
  const step = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle?.(selected); return; }
    const moves: Record<string, number> = vertical
      ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 7, ArrowDown: -7 }
      : { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    let next = localDate(addDays(dateObject(selected), moves[event.key]));
    if (next > end) next = end;
    if (next < first) next = first;
    onSelect(next);
    viewport.current?.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus();
  };
  // The chart opens on this week, whichever way it lies.
  useLayoutEffect(() => {
    const pane = viewport.current;
    if (pane) { pane.scrollTop = 0; pane.scrollLeft = vertical ? 0 : pane.scrollWidth; }
  }, [vertical, end]);
  return <Viewport ref={viewport} $orientation={orientation}>
    <Frame role="group" aria-label={label} $orientation={orientation} $weeks={weeks} onKeyDown={step}
      onPointerOver={event => { if (event.pointerType === 'touch') return; const date = (event.target as HTMLElement).dataset.date; onHover?.(date && date <= end ? date : null); }}
      onPointerLeave={() => onHover?.(null)}>
      {recent.flatMap((days, week) => {
        const line = vertical ? week + 1 : weeks - week;
        return days.map((date, day) => {
          const level = levels.get(date) ?? 0;
          const place = vertical ? { gridRow: line, gridColumn: day + 1 } : { gridRow: day + 1, gridColumn: line };
          return date > end
            ? <Cell key={date} data-date={date} data-level={level} $level={level} $future style={place} />
            : <Cell key={date} as="button" type="button" data-date={date} data-level={level} $level={level} $future={false}
                style={place} aria-label={describe(date, level)} aria-pressed={onToggle ? level > 0 : undefined}
                $selected={date === selected} aria-current={date === selected ? 'date' : undefined} tabIndex={date === selected ? 0 : -1}
                onClick={() => press(date)} />;
        });
      })}
    </Frame>
  </Viewport>;
}

// The commit chart reads focus in four steps, each a quarter of the days that
// had any, so one long day does not leave the rest looking empty.
export function focusLevels(daily: { date: string; focused_seconds: number }[]) {
  const active = daily.map(day => day.focused_seconds).filter(seconds => seconds > 0).sort((a, b) => a - b);
  const quartile = (fraction: number) => active[Math.min(active.length - 1, Math.floor(active.length * fraction))];
  const steps = active.length ? [quartile(.25), quartile(.5), quartile(.75)] : [];
  return new Map(daily.map(day => [day.date,
    day.focused_seconds <= 0 ? 0 : 1 + steps.filter(step => day.focused_seconds > step).length]));
}
