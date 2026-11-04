import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, X } from 'lucide-react';
import styled, { css } from 'styled-components';
import { completeHabit, orderHabits, reopenHabit } from '../api';
import { entryError } from '../entryFeedback';
import { ROW_FADE_MS, collapseRow, reducedMotion, restoreRow } from '../motion';
import { TASK_PROGRESS_MS } from '../taskCompletion';
import type { DoneHabit, DueHabit } from '../types';
import { Checkbox, Item, List, OutlineSurface, Row, Text } from './OutlineStyles';

// Habits are drawn as tasks but are not entries: the text is the habit's name
// and is not edited here, and a habit holds nothing beneath it.
const Label = styled(Text)`cursor: default; user-select: none; -webkit-user-select: none;`;

const SHIFT_MS = 180;

function useLeaving() {
  const leaving = useRef(new Map<number, { row: HTMLElement; animation: Animation }>());
  const leave = (id: number, row: HTMLElement | null) => {
    if (row) leaving.current.set(id, { row, animation: collapseRow(row, { after: TASK_PROGRESS_MS, fade: ROW_FADE_MS }) });
  };
  const stay = (id: number) => {
    const exit = leaving.current.get(id);
    if (exit) restoreRow(exit.row, exit.animation);
    leaving.current.delete(id);
  };
  return { leave, stay };
}

// Today's habits, at the head of the task list. A check sends the day to the
// logbook; Alt with an arrow changes the order they come in.
export function DueHabits({ habits, today, refresh }: { habits: DueHabit[]; today: string; refresh: () => Promise<void> }) {
  const [checked, setChecked] = useState(new Set<number>());
  const [order, setOrder] = useState<number[] | null>(null);
  const rows = useRef(new Map<number, HTMLLIElement>());
  const before = useRef<Map<number, number> | null>(null);
  const { leave, stay } = useLeaving();

  // The server's order, unless a move has set one it has not caught up with.
  const ids = habits.map(habit => habit.id);
  const local = order && order.length === ids.length && order.every(id => ids.includes(id)) ? order : ids;
  const shown = local.map(id => habits.find(habit => habit.id === id)!);

  // A habit moved past another slides there rather than jumping.
  useLayoutEffect(() => {
    const previous = before.current;
    before.current = null;
    if (!previous || reducedMotion()) return;
    for (const [id, top] of previous) {
      const row = rows.current.get(id);
      const delta = row ? top - row.getBoundingClientRect().top : 0;
      if (row && Math.abs(delta) > .5) row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: SHIFT_MS, easing: 'cubic-bezier(.23, 1, .32, 1)' });
    }
  }, [local.join(',')]);

  const check = (habit: DueHabit) => {
    if (checked.has(habit.id)) return;
    setChecked(current => new Set([...current, habit.id]));
    leave(habit.id, rows.current.get(habit.id) ?? null);
    completeHabit(habit.id, today).then(() => refresh()).catch(error => {
      stay(habit.id);
      setChecked(current => { const next = new Set(current); next.delete(habit.id); return next; });
      entryError(error, rows.current.get(habit.id));
    });
  };
  const nudge = (event: KeyboardEvent, id: number) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const index = local.indexOf(id), target = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (target < 0 || target >= local.length) return;
    const next = [...local];
    [next[index], next[target]] = [next[target], next[index]];
    before.current = new Map([...rows.current].map(([key, row]) => [key, row.getBoundingClientRect().top]));
    setOrder(next);
    orderHabits(next).catch(error => { setOrder(null); entryError(error, rows.current.get(id)); void refresh().catch(() => {}); });
  };

  if (!habits.length) return null;
  return <OutlineSurface data-habits><List aria-label="Today's habits">
    {shown.map(habit => {
      const done = checked.has(habit.id);
      return <Item key={habit.id} ref={(row: HTMLLIElement | null) => { if (row) rows.current.set(habit.id, row); else rows.current.delete(habit.id); }}
        data-habit={habit.key} data-depth="0">
        <Row>
          <Checkbox type="button" data-focus-chrome $checked={done} aria-pressed={done} aria-label={`Complete ${habit.name}`}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onKeyDown={event => nudge(event, habit.id)} onClick={() => check(habit)} />
          <Label>{habit.name}</Label>
        </Row>
      </Item>;
    })}
  </List></OutlineSurface>;
}

// The habits done on a day, as pills beside its date: a wash of the accent,
// set apart from the outlined date and from tags. Pressing one takes the day
// back; a habit given up keeps its days.
const Pills = styled.ul`list-style: none; display: flex; flex-wrap: wrap; align-items: center; margin: 0; padding: 0;`;
const PILL_GAP = 6;
export const Pill = styled.button<{ $fresh: boolean }>`
  position: relative; display: inline-flex; align-items: center; gap: 4px; height: 22px; margin: 2px ${PILL_GAP}px 2px 0;
  /* The bottom inset lifts the text to the middle of the marks beside it. */
  padding: 0 9px 2px 7px; border: 0; border-radius: 999px; white-space: nowrap; overflow: hidden;
  font-size: 12px; color: var(--habit-pill-ink); background: var(--habit-pill);
  transition: background-color 140ms ease, scale 120ms ease-out;
  ${({ $fresh }) => $fresh ? css`
    transition-property: background-color, scale, opacity; transition-duration: 140ms, 120ms, 200ms;
    @starting-style { opacity: 0; scale: .9; }
  ` : ''}
  &:active:not(:disabled) { scale: .96; }
  &:disabled { cursor: default; opacity: 1; }
  /* The check gives way to a cross while a press would take the day back. */
  > svg { flex: none; translate: 0 1px; transition: opacity 140ms ease, scale 140ms var(--ease-out); }
  > svg + svg { position: absolute; left: 7px; opacity: 0; scale: .6; }
  @media (hover: hover) { &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--link) 38%, transparent);
    > svg:first-of-type { opacity: 0; scale: .6; }
    > svg + svg { opacity: 1; scale: 1; }
  } }
  @media(pointer: coarse) { height: 28px; }
`;

// A pill taken back fades, then closes its gap, so the ones after it slide over.
export function closePill(pill: HTMLElement) {
  const width = `${pill.offsetWidth}px`;
  return pill.animate([
    { opacity: 1, width, marginRight: `${PILL_GAP}px`, paddingLeft: '7px', paddingRight: '9px' },
    { opacity: 0, width, marginRight: `${PILL_GAP}px`, paddingLeft: '7px', paddingRight: '9px', offset: reducedMotion() ? 1 : .45 },
    { opacity: 0, width: '0px', marginRight: '0px', paddingLeft: '0px', paddingRight: '0px' },
  ], { duration: reducedMotion() ? ROW_FADE_MS : ROW_FADE_MS + 160, easing: 'cubic-bezier(.77, 0, .175, 1)', fill: 'both' });
}

export function DoneHabits({ habits, date, refresh }: { habits: DoneHabit[]; date: string; refresh: () => Promise<void> }) {
  const [leaving, setLeaving] = useState(new Set<number>());
  const pills = useRef(new Map<number, HTMLButtonElement>());
  const reopen = (habit: DoneHabit) => {
    const pill = pills.current.get(habit.id);
    if (leaving.has(habit.id) || habit.archived || !pill) return;
    setLeaving(current => new Set([...current, habit.id]));
    const closing = closePill(pill);
    reopenHabit(habit.id, date).then(() => refresh()).catch(error => {
      closing.cancel();
      setLeaving(current => { const next = new Set(current); next.delete(habit.id); return next; });
      entryError(error, pill);
    });
  };
  if (!habits.length) return null;
  return <Pills aria-label={`Habits done on ${date}`} data-habits data-day-reveal>
    {habits.map(habit => <li key={habit.id} data-habit={habit.key}>
      <Pill type="button" ref={(pill: HTMLButtonElement | null) => { if (pill) pills.current.set(habit.id, pill); else pills.current.delete(habit.id); }}
        $fresh={Date.now() - Date.parse(habit.completed_at) < 4000} disabled={habit.archived}
        aria-label={habit.archived ? `${habit.name}, done` : `Reopen ${habit.name}`} onClick={() => reopen(habit)}>
        <Check size={11} strokeWidth={2.25} aria-hidden="true" />
        {!habit.archived && <X size={11} strokeWidth={2.25} aria-hidden="true" />}
        {habit.name}
      </Pill>
    </li>)}
  </Pills>;
}
