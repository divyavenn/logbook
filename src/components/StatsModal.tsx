import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Download, Flame, X } from 'lucide-react';
import styled, { css } from 'styled-components';
import { completeHabit, createHabit, dateObject, deleteHabit, duration, errorMessage, getHabits, getStats, localDate, renameHabit, reopenHabit } from '../api';
import type { Habit, Stats } from '../types';
import { Field, InlineError, Muted } from '../styles';
import { ConsistencyChart, focusLevels, type ChartOrientation } from './ConsistencyChart';
import { Pill, closePill } from './HabitRows';
import { STREAK_MILESTONES, haptic } from '../haptics';
import { ROW_FADE_MS, collapseRow } from '../motion';
import { Modal } from './Modal';

// Six months on the chart, whichever row it is showing.
const WEEKS = 26;

// The day under the pointer heads the panel: its date, its focus and the
// habits done on it, centred between the edges, on a line that keeps its
// height when empty so nothing moves as the pointer travels.
const Header = styled.div`
  display: grid; grid-template-columns: 40px minmax(0, 1fr) 40px; align-items: center; min-height: 72px; margin: -8px -8px 0;
  > a { grid-column: 3; align-self: start; }
`;
const Day = styled.div`
  grid-column: 2; display: grid; justify-items: center; gap: 8px; font-variant-numeric: tabular-nums;
`;
// The day's focus and habits, under its name. The line is always as large as
// it would be with every habit done and the longest focus: an unseen copy of
// that fullest day sits in the same place, so the panel keeps its size as the
// pointer moves from day to day.
const DayDetails = styled.div`
  display: grid; justify-items: center;
  > * { grid-area: 1 / 1; }
`;
const DayDetail = styled.div`
  min-height: 28px; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 0 10px;
  &[aria-hidden="true"] { visibility: hidden; }
`;
// The day as a heading, which leads to it in the logbook.
const DayTitle = styled.button`
  padding: 0; border: 0; background: transparent; color: var(--link); font-family: var(--date-font); font-variant-numeric: tabular-nums; font-size: 20px; line-height: 1.4; font-weight: 500;
  transition: scale 120ms ease-out; &:active:not(:disabled) { scale: .96; }
  @media (hover: hover) and (pointer: fine) { &:hover { text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 1px; } }
`;
const DayFocus = styled.span`color: var(--muted); font-size: 13px;`;
const DayPills = styled.ul`list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; justify-content: center;`;
const DownloadLink = styled.a`
  width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; color: var(--muted);
  transition: color 120ms ease, scale 120ms ease-out;
  @media (hover: hover) and (pointer: fine) { &:hover { color: var(--link); scale: 1.06; } }
  &:active { scale: .96; }
`;
const Rows = styled.ul`list-style: none; margin: 0; padding: 0; display: grid;`;
const Pick = styled.button`
  min-height: 36px; padding: 0; border: 0; background: transparent; text-align: left; color: inherit; font-size: 14px;
`;
const Figure = styled(Pick)`
  /* Room to press even when there is no streak to show. */
  min-width: 24px; display: flex; align-items: center; justify-content: flex-end; gap: 3px; text-align: right; color: inherit; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap;
  transition: scale 120ms ease-out; &:active:not(:disabled) { scale: .96; }
`;
// The row whose chart is showing is lifted onto a soft ground; the others wait
// on the sheet. A hover only borrows the chart, so it marks the row lightly.
// The row whose chart is showing takes the link's colour, and a row under the
// pointer, whose chart it borrows, the ink's; the rest wait in muted text.
const Row = styled.li<{ $shown: boolean; $pinned: boolean; $fresh?: boolean }>`
  min-height: 44px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 0;
  color: ${({ $pinned, $shown }) => $pinned ? 'var(--link)' : $shown ? 'var(--ink)' : 'var(--muted)'};
  transition: color 140ms ease;
  /* A habit just added rises into the list. */
  ${({ $fresh }) => $fresh ? css`
    transition: color 140ms ease, opacity 180ms var(--ease-out), transform 240ms var(--ease-out);
    @starting-style { opacity: 0; transform: translateY(4px); }
    @media (prefers-reduced-motion: reduce) { @starting-style { transform: none; } }
  ` : ''}
`;
const NameField = styled(Field)`
  min-height: 36px; padding: 6px 0; border: 0; border-radius: 0; background: transparent; box-shadow: none;
  font-size: 14px; color: inherit; text-overflow: ellipsis;
  &:focus, &:focus-visible { border: 0; background: transparent; box-shadow: none; }
`;
const SymbolButton = styled.button`
  display: grid; place-items: center; width: 40px; height: 40px; padding: 0; border: 0; background: transparent;
  color: var(--muted); border-radius: 50%;
  span { display: block; font-size: 19px; font-weight: 200; opacity: .5; transition: transform 140ms ease-out, color 140ms ease, opacity 140ms ease-out; }
  @media (hover: hover) and (pointer: fine) { &:hover span { transform: rotate(90deg); color: var(--ink); opacity: .9; } }
  transition: scale 120ms ease-out; &:active:not(:disabled) { scale: .96; }
`;
// A habit's streak and its remove share one place: pointing at the row turns
// the one into the other, and leaving turns it back. Without hover, the two
// stand side by side.
const SWAP = css`transition: opacity 160ms var(--ease-out), scale 160ms var(--ease-out);
  @media (prefers-reduced-motion: reduce) { transition-property: opacity; }`;
const Slot = styled.span`
  display: grid; grid-auto-flow: column; align-items: center; justify-items: end; gap: 4px; min-width: 40px;
  @media (hover: hover) and (pointer: fine) {
    > * { grid-area: 1 / 1; ${SWAP} }
    > ${SymbolButton} { opacity: 0; scale: .8; }
    li:hover > & > ${Figure}, &:has(${SymbolButton}:focus-visible) > ${Figure} { opacity: 0; scale: .8; pointer-events: none; }
    li:hover > & > ${SymbolButton}, & > ${SymbolButton}:focus-visible { opacity: 1; scale: 1; }
  }
`;
const Confirm = styled.button`
  justify-self: end; min-height: 40px; padding: 0 10px; border: 0; background: transparent; color: var(--danger); font-size: 12px;
  transition: scale 120ms ease-out; &:active:not(:disabled) { scale: .96; }
`;
// The field for a new habit keeps its room at the foot of the list, and names
// itself only when pointed at or written in.
const AddField = styled(NameField)`
  font-size: 13px; color: var(--ink); margin: 2px 0 0;
  &::placeholder { color: transparent; transition: color 140ms ease; }
  &:focus::placeholder { color: var(--muted); }
  @media (hover: none) { &::placeholder { color: var(--muted); } }
  @media (hover: hover) and (pointer: fine) { &:hover::placeholder { color: var(--muted); } }
`;
// With room across, the chart stands beside the list; without it, it lies
// beneath. The window's shape decides, not the sheet's, so the two never trade
// places while the list grows.
const SIDE_BY_SIDE = '(min-aspect-ratio: 1/1) and (min-width: 640px)';
const Layout = styled.div<{ $side: boolean }>`
  display: grid; align-items: start;
  /* Beside the chart, the list is as wide as a habit's name needs and no wider. */
  ${({ $side }) => $side ? css`grid-template-columns: 220px auto; gap: 36px;` : css`grid-template-columns: minmax(0, 1fr);`}
`;
const Chart = styled.section<{ $side: boolean }>`
  /* Beside the list, the chart's first week stands level with the focus row. */
  ${({ $side }) => $side ? css`padding: 14px 0 0 8px;` : css`margin-top: 22px;`}
`;
function useSideBySide() {
  const [side, setSide] = useState(() => window.matchMedia(SIDE_BY_SIDE).matches);
  useEffect(() => {
    const media = window.matchMedia(SIDE_BY_SIDE);
    const update = () => setSide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return side;
}
const Quiet = styled.div`display: grid; place-items: center; min-height: 260px; min-width: min(420px, 100%);`;

const label = (date: string) => dateObject(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
// A day of another year carries its year.
const longLabel = (date: string) => dateObject(date).getFullYear() === new Date().getFullYear() ? label(date)
  : dateObject(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase();

function daysBefore(date: string, days: number) {
  const value = dateObject(date);
  value.setDate(value.getDate() - days);
  return localDate(value);
}

// A streak runs back from today, or from yesterday while today is still to do.
export function streak(done: ReadonlySet<string>, today: string) {
  let day = done.has(today) ? today : daysBefore(today, 1);
  let count = 0;
  while (done.has(day)) { count++; day = daysBefore(day, 1); }
  return count;
}

function HabitName({ habit, onRename, onFocus }: { habit: Habit; onRename: (name: string) => Promise<void>; onFocus: () => void }) {
  const [name, setName] = useState(habit.name);
  useEffect(() => setName(habit.name), [habit.name]);
  const commit = () => {
    const next = name.trim();
    if (!next || next === habit.name) { setName(habit.name); return; }
    void onRename(next).catch(() => setName(habit.name));
  };
  return <NameField aria-label={`Rename ${habit.name}`} value={name} autoComplete="off" spellCheck={false}
    onChange={event => setName(event.target.value)} onFocus={onFocus} onBlur={commit}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape' && name !== habit.name) { event.preventDefault(); event.stopPropagation(); setName(habit.name); }
    }} />;
}

type Shown = 'focus' | number;

export function StatsModal({ open, onClose, onChange, openDate }: {
  open: boolean; onClose: () => void; onChange: () => Promise<void>; openDate: (date: string) => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [habits, setHabits] = useState<Habit[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<number | null>(null);
  const closing = useRef(new Set<string>());
  const [confirming, setConfirming] = useState<number | null>(null);
  const [pinned, setPinned] = useState<Shown>('focus');
  const [previewed, setPreviewed] = useState<Shown | null>(null);
  const today = localDate();
  // The panel's day: today until a square makes it another, previewed by the
  // square under the pointer.
  const [selected, setSelected] = useState(today);
  const [hovered, setHovered] = useState<string | null>(null);
  const day = hovered ?? selected;
  const side = useSideBySide();
  const orientation: ChartOrientation = side ? 'vertical' : 'horizontal';
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(''); setConfirming(null); setPinned('focus'); setPreviewed(null); setSelected(today); setHovered(null);
    const start = daysBefore(today, WEEKS * 7);
    Promise.all([getStats(start, today, controller.signal), getHabits(start, today, controller.signal)])
      .then(([focus, list]) => { setStats(focus); setHabits(list); })
      .catch(value => { if (!controller.signal.aborted) setError(errorMessage(value)); });
    return () => controller.abort();
  }, [open, today]);
  // Each habit change reaches the task list too, where today's habits are.
  const changed = () => void onChange().catch(value => setError(errorMessage(value)));
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const habit = await createHabit(name);
      setHabits(current => [...(current ?? []), habit]); setName(''); setFresh(habit.id);
      changed();
    } catch (value) { setError(errorMessage(value)); }
    finally { setBusy(false); }
  };
  const rename = async (habit: Habit, next: string) => {
    setError('');
    try {
      const renamed = await renameHabit(habit.id, next);
      setHabits(current => current?.map(item => item.id === habit.id ? { ...renamed, done: item.done } : item) ?? null);
      changed();
    } catch (value) { setError(errorMessage(value)); throw value; }
  };
  const remove = async (habit: Habit, row: HTMLElement | null) => {
    setBusy(true); setError(''); setConfirming(null);
    try {
      await deleteHabit(habit.id);
      // The row closes the space it held before it is let go.
      if (row) await collapseRow(row, { fade: ROW_FADE_MS }).finished.catch(() => {});
      setHabits(current => current?.filter(item => item.id !== habit.id) ?? null);
      if (pinned === habit.id) setPinned('focus');
      setPreviewed(null);
      changed();
    } catch (value) { setError(errorMessage(value)); }
    finally { setBusy(false); }
  };
  // A square on a habit's chart marks its day done or not, showing the change
  // at once and taking it back if the server will not have it.
  const toggleDay = (habit: Habit, date: string) => {
    const done = habit.done.includes(date);
    const flip = (on: boolean) => setHabits(current => current?.map(item => item.id !== habit.id ? item
      : { ...item, done: on ? [...item.done, date].sort() : item.done.filter(day => day !== date) }) ?? null);
    flip(!done); setError('');
    if (done) haptic('soft');
    else haptic(STREAK_MILESTONES.has(streak(new Set([...habit.done, date]), today)) ? 'celebrate' : 'success');
    (done ? reopenHabit(habit.id, date) : completeHabit(habit.id, date))
      .then(changed).catch(value => { flip(done); setError(errorMessage(value)); });
  };
  // A pill in the heading takes its day back: saved at once, closing as it
  // goes, the day let go once both are done, and opened again if the server
  // will not have it. A second press on a closing pill does nothing.
  const takeBack = (habit: Habit, date: string, pill: HTMLElement) => {
    const key = `${date}-${habit.id}`;
    if (closing.current.has(key)) return;
    closing.current.add(key);
    haptic('soft'); setError('');
    const animation = closePill(pill);
    Promise.all([reopenHabit(habit.id, date), animation.finished]).then(() => {
      setHabits(current => current?.map(item => item.id !== habit.id ? item : { ...item, done: item.done.filter(day => day !== date) }) ?? null);
      changed();
    }).catch(value => { animation.reverse(); setError(errorMessage(value)); })
      .finally(() => closing.current.delete(key));
  };
  // A press pins a row's chart; pressing it again hands the chart back to focus.
  const pin = (row: Shown) => { haptic('selection'); setPinned(current => current === row && row !== 'focus' ? 'focus' : row); };
  const select = (date: string) => { if (date !== selected) haptic('selection'); setSelected(date); };
  const preview = (row: Shown) => (event: { pointerType: string }) => { if (event.pointerType !== 'touch') setPreviewed(row); };

  const loaded = stats && habits;
  const week = stats?.daily.slice(-7) ?? [];
  const weeklyAverage = week.reduce((total, day) => total + day.focused_seconds, 0) / Math.max(1, week.length);
  const shownId = previewed ?? pinned;
  const shownHabit = habits?.find(habit => habit.id === shownId);
  const chart = !loaded ? null : shownHabit ? (() => {
    const done = new Set(shownHabit.done);
    const recent = Array.from({ length: 30 }, (_, days) => daysBefore(today, days)).filter(day => done.has(day)).length;
    return { levels: new Map(shownHabit.done.map(day => [day, 4])),
      label: `${shownHabit.name}: done ${recent} of the last 30 days.`,
      describe: (date: string, level: number) => `${label(date)} · ${level ? 'done' : '—'}` };
  })() : {
    levels: focusLevels(stats.daily),
    label: `Focus: ${stats.active_days} of the last ${stats.day_count} days.`,
    describe: (date: string, level: number) => `${label(date)} · ${level
      ? duration(stats.daily.find(day => day.date === date)?.focused_seconds ?? 0, false) : '—'}`,
  };

  return <Modal open={open} onClose={onClose} title="Statistics" fit={side}>
    <Header>
      {loaded && <Day aria-live="polite">
        <DayTitle type="button" aria-label={`Open ${longLabel(day)} in the logbook`} onClick={() => { onClose(); openDate(day); }}>{longLabel(day)}</DayTitle>
        <DayDetails>
        <DayDetail aria-hidden="true">
          {(() => { const seconds = Math.max(0, ...stats.daily.map(row => row.focused_seconds)); return seconds > 0 && <DayFocus>{duration(seconds, false)}</DayFocus>; })()}
          <DayPills>{habits.map(habit => <li key={habit.id}><Pill as="span" $fresh={false}>
            <Check size={11} strokeWidth={2.25} />{habit.name}
          </Pill></li>)}</DayPills>
        </DayDetail>
        <DayDetail>
        {(() => { const seconds = stats.daily.find(row => row.date === day)?.focused_seconds ?? 0; return seconds > 0 && <DayFocus>{duration(seconds, false)}</DayFocus>; })()}
        {/* The habits done that day, taken back the way they are in the logbook. */}
        <DayPills aria-label={`Habits done on ${day}`}>{habits.filter(habit => habit.done.includes(day)).map(habit =>
          <li key={`${day}-${habit.id}`}><Pill type="button" $fresh={false} aria-label={`Reopen ${habit.name} on ${day}`}
            onClick={event => takeBack(habit, day, event.currentTarget)}>
            <Check size={11} strokeWidth={2.25} aria-hidden="true" /><X size={11} strokeWidth={2.25} aria-hidden="true" />{habit.name}
          </Pill></li>)}</DayPills>
        </DayDetail>
        </DayDetails>
      </Day>}
      <DownloadLink href="/api/backup" download aria-label="Download SQLite backup" title="Download SQLite backup">
        <Download size={14} aria-hidden="true" />
      </DownloadLink>
    </Header>
    {error && !loaded ? <InlineError role="alert">{error}</InlineError> : !loaded || !chart ? <Quiet><Muted>loading…</Muted></Quiet> : <Layout $side={side}><div>
      <Rows aria-label="Focus and habits" onPointerLeave={() => setPreviewed(null)}>
        <Row $shown={shownId === 'focus'} $pinned={pinned === 'focus'} onPointerEnter={preview('focus')}>
          <Pick type="button" aria-pressed={pinned === 'focus'} aria-label={`Show focus chart, ${duration(weeklyAverage, false)} a day this week`}
            onClick={() => pin('focus')}>focus</Pick>
          {/* Read out with the row's button; the figure is a wider place to press it. */}
          <Figure as="span" aria-hidden="true" onClick={() => pin('focus')}>{duration(weeklyAverage, false)}</Figure>
        </Row>
        {habits.map(habit => {
          const run = streak(new Set(habit.done), today);
          return <Row key={habit.id} $fresh={fresh === habit.id} $shown={shownId === habit.id} $pinned={pinned === habit.id} onPointerEnter={preview(habit.id)}>
            <HabitName habit={habit} onRename={next => rename(habit, next)} onFocus={() => setPinned(habit.id)} />
            {confirming === habit.id
              ? <Confirm type="button" autoFocus disabled={busy} onBlur={() => setConfirming(null)}
                  aria-label={`Remove ${habit.name} for good`} onClick={event => { haptic('warning'); void remove(habit, event.currentTarget.closest('li')); }}>remove</Confirm>
              : <Slot>
                <Figure type="button" aria-pressed={pinned === habit.id} aria-label={`Show ${habit.name} chart, ${run}-day streak`}
                  onClick={() => pin(habit.id)}>{run > 0 && <><Flame size={12} strokeWidth={1.75} aria-hidden="true" />{run}</>}</Figure>
                <SymbolButton type="button" disabled={busy} aria-label={`Remove ${habit.name}`}
                  onClick={() => setConfirming(habit.id)}><span aria-hidden="true">×</span></SymbolButton>
              </Slot>}
          </Row>;
        })}
      </Rows>
      <form onSubmit={add}>
        <AddField aria-label="New habit" value={name} onChange={event => setName(event.target.value)} autoComplete="off"
          placeholder="add a habit" disabled={busy} />
      </form>
      {error && <InlineError role="alert">{error}</InlineError>}
      </div>
      <Chart aria-label="Last six months" $side={side}>
        <ConsistencyChart levels={chart.levels} end={today} weeks={WEEKS} label={chart.label} describe={chart.describe}
          orientation={orientation} selected={selected} onSelect={select}
          onToggle={shownHabit ? date => toggleDay(shownHabit, date) : undefined} onHover={setHovered} />
      </Chart>
    </Layout>}
  </Modal>;
}
