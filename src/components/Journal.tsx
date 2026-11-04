import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import styled, { css } from 'styled-components';
import { dateObject, duration, localDate } from '../api';
import type { CalendarEvent, DueHabit, JournalDay, Task } from '../types';
import { DoneHabits, DueHabits } from './HabitRows';
import { TextButton, appear, edgeWash, viewEnter } from '../styles';
import { Outline } from './Outline';
import { entryError } from '../entryFeedback';
import { useJournalContext } from '../JournalContext';
import { compactViewport, fullViewport } from '../layout';

const SectionTitle = styled.button`font-size: 20px; line-height: 1.4; margin-bottom: 4px; font-weight: 500; border: 0; padding: 0; height: calc(var(--task-heading-height) - 4px); background: transparent; text-align: left;`;
const TaskSection = styled.section<{ $entering: boolean; $empty: boolean; $fills: boolean }>`
  ${({ $entering }) => viewEnter($entering)};
  align-self: stretch; display: flex; flex-direction: column; flex-shrink: 0; min-width: 180px; width: 100%; padding: 0 12px 4px 8px; margin-bottom: 8px;
  /* Tasks take the room they need. A list long enough to crowd the log out of
     the page is given a pane of its own instead of being clipped into a band.
     An empty list still reserves a generous creation area. */
  min-height: ${({ $empty }) => $empty ? 'min(calc(var(--task-heading-height) + 124px), 30dvh)' : '0'};
  /* In a pane of its own it takes the whole pane, and the list scrolls inside
     it, behind its washes, rather than the pane scrolling under them. */
  ${({ $fills }) => $fills && css`flex: 1; min-height: 0; max-height: 100%;`}
  /* With tasks listed, the composer row is the place to type, so the strip
     under it stays a thin click target instead of padding out the band. */
  ${({ $empty }) => !$empty && css`
    [data-task-creation-area] { flex: 0 0 auto; min-height: 12px; }
  `}
  @media ${compactViewport} {
    min-width: 0; min-height: calc(var(--task-heading-height) + 36px); max-height: none; padding: 0; margin: 0;
  }
`;
const TaskFrame = styled.div<{ $appearing: boolean }>`
  position: relative; flex: 1; min-height: 0; display: flex;
  /* Unfolding animates; the first paint is not a reveal and must not move. */
  ${({ $appearing }) => $appearing && appear('4px', 200)};
  @media ${compactViewport} { overflow-x: clip; }
`;
const TaskViewport = styled.div`
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain;
  display: flex; flex-direction: column;
  /* Inset from the frame so the scrollbar stops short of both washes, with
     enough padding left inside for content to still fade under them. */
  margin: 6px 0; padding: 14px 0 0;
  scrollbar-width: thin; scrollbar-color: var(--scrollbar) transparent;
  @media ${compactViewport} { scrollbar-width: none; &::-webkit-scrollbar { display: none; } }
`;
const TaskEdgeWash = styled.div<{ $edge?: 'top' | 'bottom' }>`
  ${({ $edge = 'top' }) => edgeWash($edge)};
  /* Stop short of the scrollbar column so the bar is never washed over. */
  left: 0; right: 12px; height: 20px;
  ${({ $edge = 'top' }) => $edge === 'top' && 'top: 0;'}
`;
// A day that arrives after the logbook is open, behind today or from further
// back, settles in after the one before it rather than appearing all at once.
const DAY_STAGGER_MS = 40;
const DayBlock = styled.section<{ $today: boolean; $showHistory: boolean; $arrival?: number }>`
  margin-bottom: 20px;
  ${({ $arrival }) => $arrival !== undefined && css`
    opacity: 1; transform: none;
    @starting-style { opacity: 0; transform: translateY(4px); }
    transition: opacity 180ms var(--ease-out) ${$arrival * DAY_STAGGER_MS}ms, transform 240ms var(--ease-out) ${$arrival * DAY_STAGGER_MS}ms;
    @media (prefers-reduced-motion: reduce) { transition-property: opacity; }
  `}
  @media(pointer: coarse) { margin-bottom: 44px; }
  @media ${compactViewport} { display: ${({ $today, $showHistory }) => $today || $showHistory ? 'block' : 'none'}; margin-bottom: 10px; }
  /* The day's focus time and habits keep out of sight until the day is
     pointed at or being worked in. */
  [data-day-reveal] { opacity: 0; transition: opacity 160ms var(--ease-out); }
  &:hover [data-day-reveal], &:focus-within [data-day-reveal] { opacity: 1; }
  /* Without hover nothing would show a hidden pill before it was tapped. */
  @media (hover: none) { [data-day-reveal] { pointer-events: none; } &:focus-within [data-day-reveal] { pointer-events: auto; } }
`;
type Fold = { key: string; dates: string[]; days: Map<string, JournalDay> };
function shiftDate(date: string, days: number) {
  const value = dateObject(date);
  value.setDate(value.getDate() + days);
  return localDate(value);
}
// The date pill's shape, shared with the ghost of one: the bottom inset lifts
// the text to the middle of its outline.
const datePill = css`
  display: inline-block; font-family: var(--date-font); font-variant-numeric: tabular-nums; font-size: 15px; line-height: 20px;
  padding: 4px 10px 5px; margin-left: -6px; border-radius: 9px; transform: translateY(1px);
  @media ${compactViewport} { margin-left: 0; }
`;
// A folded run keeps the room of one day, its date row and the gap after it,
// so the missing day is felt in the rhythm of the log.
const FoldBlock = styled.div<{ $open: boolean }>`margin: 0 0 ${({ $open }) => $open ? '0' : '20px'};`;
// Pointed at, the room shows the ghost of a date: the same pill, its outline
// broken and fainter, holding the count of days it stands for.
const FoldGhost = styled.button`
  display: flex; align-items: center; min-height: 40px; padding: 0; border: 0; background: transparent; cursor: pointer;
  > span { ${datePill}; border: 1px dashed var(--date-bg); color: color-mix(in srgb, var(--muted) 75%, transparent);
    opacity: 0; transition: opacity 160ms var(--ease-out); }
  &:hover > span, &:focus-visible > span { opacity: 1; }
  @media(pointer: coarse) { min-height: 44px; }
`;
// Opened, the run's dates step in, held by a faint spine down their side;
// the spine is what folds them again.
// It runs from the top of the first date to the foot of the last, drawn in
// the dates' own outline.
const FoldSpine = styled.button`
  position: absolute; left: -10px; top: var(--spine-top, 0); height: var(--spine-height, 0); width: 12px;
  padding: 0; border: 0; background: transparent; cursor: pointer;
  &::before { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; translate: -50% 0;
    background: var(--date-bg); transition: background-color 140ms ease; }
  &:hover::before, &:focus-visible::before { background: var(--muted); }
  @media ${compactViewport} { left: -4px; }
`;
// An opened run folds away again once it has been seen and scrolled past.
function FoldRun({ open, root, onLeave, children }: { open: boolean; root: RefObject<HTMLDivElement | null>; onLeave: () => void; children: ReactNode }) {
  const block = useRef<HTMLDivElement>(null);
  const leave = useRef(onLeave);
  leave.current = onLeave;
  useEffect(() => {
    if (!open || !block.current) return;
    let seen = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) seen = true;
      else if (seen) leave.current();
    }, { root: root.current });
    observer.observe(block.current);
    return () => observer.disconnect();
  }, [open, root]);
  // The spine is measured against the dates it holds, whose rows vary.
  useLayoutEffect(() => {
    const days = block.current?.querySelector<HTMLElement>('[data-fold-days]');
    if (!open || !days) return;
    const place = () => {
      const dates = days.querySelectorAll(':scope > [data-day] time');
      if (!dates.length) return;
      const frame = days.getBoundingClientRect();
      const top = dates[0].getBoundingClientRect().top - frame.top;
      const bottom = dates[dates.length - 1].getBoundingClientRect().bottom - frame.top;
      days.style.setProperty('--spine-top', `${top}px`);
      days.style.setProperty('--spine-height', `${bottom - top}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(days);
    return () => observer.disconnect();
  });
  return <FoldBlock ref={block} $open={open}>{children}</FoldBlock>;
}
// The days of an opened run are ghosts of dates, as the run's own mark was,
// and come to themselves while one is pointed at or worked in. A day written
// on leaves the run at the next refresh, and is a date like any other.
const FoldDays = styled.div`
  position: relative; padding: 8px 0 0 14px; opacity: 1; transition: opacity 200ms var(--ease-out);
  @starting-style { opacity: 0; }
  [data-day] time { border-style: dashed; color: color-mix(in srgb, var(--muted) 75%, transparent); transition: color 160ms ease; }
  [data-day]:is(:hover, :focus-within) time { border-style: solid; color: var(--ink); }
`;
// A date with nothing recorded on it at all: only its name, until it is
// pressed to write on.
const QuietDay = styled.div`min-height: 40px; display: flex; align-items: center; margin-bottom: 20px; cursor: text; outline: none;`;
const blankDay = (date: string): JournalDay => ({ date, entries: [], events: [], habits: [], focused_seconds: 0, longest_session_seconds: 0, session_count: 0 });
// The date and, beside it, the habits done that day.
const DayHeadRow = styled.div`display: flex; align-items: center; flex-wrap: wrap; column-gap: 12px;`;
const DateHead = styled.button`
  display: flex; align-items: center; gap: 10px; min-height: 40px; margin-bottom: 3px;
  padding: 0; border: 0; background: transparent; text-align: left; white-space: nowrap;
  &:hover > span { text-decoration: underline; }
  &:disabled { cursor: default; opacity: 1; }
  @media(pointer: coarse) { min-height: 44px; }
  @media ${compactViewport} { min-height: 36px; gap: 6px; margin-bottom: 0; }
`;
// An outline, not a fill: the date is named rather than highlighted.
const DateLabel = styled.time`${datePill}; border: 1px solid var(--date-bg);`;
// Dark enough to clear AA contrast at 12px once the chrome opacity fades it.
const FocusTotal = styled.span`font-size: 12px; line-height: 24px; color: color-mix(in srgb, var(--ink), var(--muted) 40%); font-variant-numeric: tabular-nums;`;
const EventList = styled.ul`
  list-style: none; padding: 0; margin: 0 0 0 20px;
  @media ${compactViewport} { margin-left: 0; }
`;
const EventRow = styled.li`
  min-width: 0; display: flex; align-items: flex-start; min-height: 28px;
  @media(pointer: coarse) { min-height: 44px; }
  @media ${compactViewport} { min-height: 36px; }
`;
const EventContent = styled.div`min-width: 0; flex: 1;`;
const EventMarker = styled.span<{ $cancelled: boolean }>`
  display: flex; width: 40px; min-width: 40px; height: 28px; align-items: center; justify-content: center;
  color: color-mix(in srgb, var(--link), var(--paper) 38%);
  &::before {
    content: ''; width: 6px; height: 6px; border-radius: 50%; translate: 0 -1px;
    background: ${({ $cancelled }) => $cancelled ? 'transparent' : 'currentColor'};
    border: ${({ $cancelled }) => $cancelled ? '1px solid currentColor' : '0'};
  }
  :root[data-theme='night'] & { color: color-mix(in srgb, var(--link), #000 12%); }
  @media(pointer: coarse) { width: 44px; min-width: 44px; height: 44px; }
  @media ${compactViewport} { width: 36px; min-width: 36px; height: 36px; }
`;
const eventEntry = css<{ $cancelled: boolean }>`
  position: relative; display: block; min-width: 0; min-height: 28px; padding: 4px 0; border: 0; background: transparent;
  color: var(--ink); font-size: 15px; line-height: 1.2; overflow-wrap: anywhere;
  text-decoration: ${({ $cancelled }) => $cancelled ? 'line-through' : 'none'};
  @media(pointer: coarse) { min-height: 44px; padding: 10px 0; font-size: 16px; line-height: 1.35; }
  @media ${compactViewport} { min-height: 36px; padding: 6px 0; line-height: 1.3; }
`;
const EventText = styled.span<{ $cancelled: boolean }>`${eventEntry};`;
const EventToggle = styled.button<{ $cancelled: boolean; $linked: boolean }>`
  ${eventEntry}; width: 100%; text-align: left; cursor: pointer;
  color: ${({ $linked }) => $linked ? 'color-mix(in srgb, var(--link), #000 12%)' : 'var(--ink)'};
  &:hover { text-decoration: ${({ $cancelled }) => $cancelled ? 'line-through underline' : 'underline'}; text-underline-offset: 2px; }
`;
const EventTitle = styled.span`font-weight: 400;`;
const EventMeta = styled.span`color: inherit; font-weight: 300; font-variant-numeric: tabular-nums;`;
const EventDetails = styled.div`
  display: grid; gap: 3px; padding: 0 0 8px 12px; color: var(--muted); font-size: 13px; line-height: 1.45;
  overflow-wrap: anywhere;
  ${appear('3px', 160)};
`;
const EventDetail = styled.div`min-width: 0; white-space: pre-wrap;`;
const EventDetailLink = styled.a`color: var(--link); text-decoration: none; text-underline-offset: 2px; &:hover { text-decoration: underline; }`;
const Body = styled.div`
  min-width: 0; padding-left: 20px; flex: 1; display: flex; flex-direction: column;
  > [data-outline-kind='tasks'] { flex: 1; display: flex; flex-direction: column; }
  > [data-outline-kind='tasks'] > [data-task-creation-area] { flex: 1; }
  @media ${compactViewport} { padding-left: 0; }
`;
const Logbook = styled.section<{ $entering: boolean }>`
  ${({ $entering }) => viewEnter($entering)}
  /* Today is the day in hand until another is being worked in, and is again
     once that one is left. */
  &:not(:has([data-day]:not([data-today]):focus-within)) [data-today] [data-day-reveal] { opacity: 1; pointer-events: auto; }
`;
const HistoryEnd = styled.div<{ $showHistory: boolean }>`
  display: flex; justify-content: center; padding: 20px 0; color: var(--sage);
  @media ${compactViewport} { display: ${({ $showHistory }) => $showHistory ? 'flex' : 'none'}; padding: 8px 0; }
`;
type Actions = { refresh: () => Promise<void> };

function eventText(event: CalendarEvent) {
  return `${event.title} ${eventDetail(event)}`;
}

function eventDetail(event: CalendarEvent) {
  if (event.all_day) return '(all day)';
  const format = (value: string) => {
    const date = new Date(value);
    return date.toLocaleTimeString('en-US', date.getMinutes() === 0 ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' });
  };
  return `(${format(event.start)} – ${format(event.end)})`;
}

const detailUrlPattern = /https?:\/\/[^\s<>"']+/gi;

function linkedText(value: string): ReactNode[] {
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(detailUrlPattern)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const url = raw.replace(/[.,;:!?\])}]+$/, '');
    if (start > cursor) content.push(value.slice(cursor, start));
    content.push(<EventDetailLink key={`${start}-${url}`} href={url} target="_blank" rel="noopener noreferrer">{url}</EventDetailLink>);
    if (url.length < raw.length) content.push(raw.slice(url.length));
    cursor = start + raw.length;
  }
  if (cursor < value.length) content.push(value.slice(cursor));
  return content;
}

function linkLabel(value: string) {
  try { return new URL(value).hostname.replace(/^www\./, ''); }
  catch { return value; }
}

export function Tasks({ tasks, habits = [], today, entering = false, fills = false, refresh }: { tasks: Task[]; habits?: DueHabit[]; today: string; entering?: boolean; fills?: boolean } & Actions) {
  const [folded, setFolded] = useState(false);
  const [unfolding, setUnfolding] = useState(false);
  const { target, activeTag } = useJournalContext();
  const section = useRef<HTMLElement>(null);
  useEffect(() => { if (target?.kind === 'tasks') setFolded(false); }, [target]);
  // A filtered view has nothing to add to, so an empty list is just noise.
  // Habits keep to the full list; a filtered view is a list of entries.
  const due = activeTag ? [] : habits;
  if (activeTag && !tasks.length) return null;
  return <TaskSection ref={section} $entering={entering} $empty={!tasks.length} $fills={fills} aria-labelledby="task-title"><SectionTitle id="task-title" data-focus-chrome aria-expanded={!folded} title={folded ? 'Expand to do' : 'Fold to do'} onClick={() => { setUnfolding(true); setFolded(value => !value); }}>to do</SectionTitle>
    {!folded && <TaskFrame $appearing={unfolding}>
      <TaskViewport data-testid="task-scroll"><Body data-task-body><DueHabits habits={due} today={today} refresh={refresh} /><Outline kind="tasks" items={tasks} composer={tasks.length > 0} refresh={refresh} /></Body></TaskViewport>
      <TaskEdgeWash data-testid="task-top-ink-wash" aria-hidden="true" />
      <TaskEdgeWash $edge="bottom" data-testid="task-bottom-ink-wash" aria-hidden="true" />
    </TaskFrame>}
  </TaskSection>;
}

export function Journal({ days, today, refresh, openSessions, openDate, entering = false, sessionsEnabled = true, showHistory = false, secondsForDay, loadMore, hasMore, scrollRoot }: {
  days: JournalDay[]; today: string; openSessions: (date: string) => void; secondsForDay: (day: JournalDay) => number;
  entering?: boolean;
  openDate: (date: string) => void;
  sessionsEnabled?: boolean; showHistory?: boolean; loadMore: () => Promise<void>; hasMore: boolean; scrollRoot: RefObject<HTMLDivElement | null>;
} & Actions) {
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(() => new Set());
  // The dates of the runs that are open, by hand or by a jump to one of them.
  // Kept by date, so a run written into the middle of splits into two runs
  // that are both still open, and fold apart from each other.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  // Dates in an opened run that have been pressed to write on. Until then a
  // date is only its name, so a long run costs no editors.
  const [writing, setWriting] = useState<Set<string>>(() => new Set());
  const startWriting = (date: string) => {
    setWriting(current => new Set([...current, date]));
    // Its outline listens for this once it has mounted.
    requestAnimationFrame(() => requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent('still-new-entry', { detail: `still-draft-${date}` }))));
  };
  useEffect(() => {
    const reveal = (event: Event) => {
      const date = (event as CustomEvent<string>).detail;
      setOpened(current => current.has(date) ? current : new Set([...current, date]));
    };
    window.addEventListener('still-reveal-day', reveal);
    return () => window.removeEventListener('still-reveal-day', reveal);
  }, []);
  const { target, activeTag } = useJournalContext();
  const historyEnd = useRef<HTMLDivElement>(null);
  const loadingLock = useRef(false);
  const [historyError, setHistoryError] = useState(false);
  const loadEarlier = useCallback(async () => {
    if (loadingLock.current) return;
    loadingLock.current = true; setLoadingMore(true);
    try { await loadMore(); setHistoryError(false); }
    catch (e) { setHistoryError(true); entryError(e); }
    finally { setLoadingMore(false); loadingLock.current = false; }
  }, [loadMore]);
  useEffect(() => {
    if (!hasMore || historyError || !historyEnd.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && (showHistory || window.matchMedia(fullViewport).matches)) void loadEarlier();
    }, { root: scrollRoot.current, rootMargin: '200px' });
    observer.observe(historyEnd.current);
    return () => observer.disconnect();
  }, [hasMore, historyError, loadEarlier, scrollRoot, showHistory]);
  const yesterday = dateObject(today); yesterday.setDate(yesterday.getDate() - 1);
  // The days of the first paint arrive with the view. Each later one keeps the
  // place it was given in its batch, so a render while it settles cannot
  // change its timing.
  const firstPaint = useRef<Set<string> | null>(null);
  firstPaint.current ??= new Set(days.map(day => day.date));
  const arrivals = useRef(new Map<string, number>());
  let batch = 0;
  for (const day of days) {
    if (!firstPaint.current.has(day.date) && !arrivals.current.has(day.date)) arrivals.current.set(day.date, Math.min(batch++, 6));
  }
  const renderDay = (day: JournalDay) => {
      const isToday = day.date === today;
      const date = dateObject(day.date);
      const seconds = secondsForDay(day);
      const title = isToday ? 'Today' : date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString(undefined, { weekday: 'long' });
      const entries = day.entries;
      const targeted = target && entries.some(entry => entry.kind === target.kind && entry.id === target.id);
      return <DayBlock key={day.date} data-day={day.date} data-today={isToday || undefined} $today={isToday || !!targeted} $showHistory={showHistory} $arrival={arrivals.current.get(day.date)} aria-label={`${title}, ${day.date}`}
        onClick={event => {
          if ((event.target as Element).closest('button, a, input, [contenteditable], [role="group"], [data-calendar-event], [data-habits]') || window.getSelection()?.toString()) return;
          window.dispatchEvent(new CustomEvent('still-new-entry', { detail: `still-draft-${day.date}` }));
        }}>
        {/* Tags are read-only while filtering, so the date leads back to the full day. */}
        <DayHeadRow><DateHead type="button" data-focus-chrome disabled={!activeTag && !sessionsEnabled}
          aria-label={activeTag ? `Open ${day.date} in the full logbook` : `Focus sessions for ${day.date}`}
          onClick={() => { if (activeTag) openDate(day.date); else if (sessionsEnabled) openSessions(day.date); }}
          title={activeTag ? 'Open this date in the full logbook' : sessionsEnabled ? 'View and edit focus sessions' : undefined}>
          <DateLabel dateTime={day.date}>{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</DateLabel>
          {/* A filtered day is a list of matching entries, not the day itself. */}
          {!activeTag && <FocusTotal data-focus-total data-day-reveal>{duration(seconds, true)}</FocusTotal>}
        </DateHead>
        {!activeTag && <DoneHabits habits={day.habits} date={day.date} refresh={refresh} />}</DayHeadRow>
        {!activeTag && !!day.events?.length && <EventList aria-label={`Calendar events for ${day.date}`}>
          {day.events.map(event => {
            const text = eventText(event);
            const content = <><EventTitle data-calendar-event-title>{event.title}</EventTitle> <EventMeta data-calendar-event-meta>{eventDetail(event)}</EventMeta></>;
            const links = event.links;
            const location = event.location?.trim() || '';
            const description = event.description?.trim() || '';
            const extraLinks = links.filter(link => !location.includes(link) && !description.includes(link));
            const hasDetails = !!(location || description || links.length);
            const eventKey = `${day.date}-${event.id}`;
            const expanded = expandedEvents.has(eventKey);
            const detailsId = `calendar-event-${event.id}-details`;
            return <EventRow key={event.id} data-calendar-event>
              <EventMarker $cancelled={event.cancelled} data-calendar-marker aria-hidden="true" />
              <EventContent>
                {hasDetails
                  ? <EventToggle $cancelled={event.cancelled} $linked={links.length > 0} aria-expanded={expanded} aria-controls={detailsId}
                      aria-label={event.cancelled ? `${text}, cancelled` : text}
                      onClick={() => setExpandedEvents(current => {
                        const next = new Set(current);
                        if (next.has(eventKey)) next.delete(eventKey); else next.add(eventKey);
                        return next;
                      })}>{content}</EventToggle>
                  : <EventText $cancelled={event.cancelled} role="group"
                      aria-label={event.cancelled ? `${text}, cancelled` : text}>{content}</EventText>}
                {expanded && <EventDetails id={detailsId} data-calendar-event-details role="group" aria-label={`Details for ${event.title}`}>
                  {location && <EventDetail>{linkedText(location)}</EventDetail>}
                  {description && <EventDetail>{linkedText(description)}</EventDetail>}
                  {extraLinks.map(link => <EventDetail key={link}><EventDetailLink href={link} target="_blank" rel="noopener noreferrer">{linkLabel(link)}</EventDetailLink></EventDetail>)}
                </EventDetails>}
              </EventContent>
            </EventRow>;
          })}
        </EventList>}
        <Body>
          <Outline kind="mixed" items={entries} day={day.date} archived composer={isToday} refresh={refresh} />

        </Body>
      </DayBlock>;
  };
  // A run of days with nothing written and nothing on the calendar, focus and
  // habits or not, folds away between the days around it, every date in it,
  // recorded or not, a press away. Today is where writing starts, so it never
  // folds; a filtered view has no runs.
  const sequence: ({ kind: 'day'; day: JournalDay } | { kind: 'fold'; fold: Fold })[] = [];
  if (activeTag) for (const day of days) sequence.push({ kind: 'day', day });
  else {
    let fold: Fold | null = null;
    const add = (date: string, day?: JournalDay) => {
      if (day && (day.entries.length || day.events?.length || date === today)) {
        if (fold) sequence.push({ kind: 'fold', fold });
        fold = null;
        sequence.push({ kind: 'day', day });
        return;
      }
      fold ??= { key: date, dates: [], days: new Map() };
      fold.dates.push(date);
      if (day) fold.days.set(date, day);
    };
    days.forEach((day, index) => {
      add(day.date, day);
      const older = days[index + 1]?.date;
      if (older) for (let date = shiftDate(day.date, -1); date > older; date = shiftDate(date, -1)) add(date);
    });
    if (fold) sequence.push({ kind: 'fold', fold });
  }
  const renderFold = (fold: Fold) => {
    const open = fold.dates.some(date => opened.has(date));
    const count = fold.dates.length;
    const without = (current: Set<string>) => new Set([...current].filter(date => !fold.dates.includes(date)));
    const close = () => { setOpened(without); setWriting(without); };
    const label = `${count} ${count === 1 ? 'day' : 'days'} with nothing written`;
    return <FoldRun key={`fold-${fold.key}`} open={open} root={scrollRoot} onLeave={close}>
      {!open && <FoldGhost type="button" data-focus-chrome aria-expanded={false} aria-label={`Show ${label}`}
        onClick={() => setOpened(current => new Set([...current, ...fold.dates]))}><span>{count} {count === 1 ? 'day' : 'days'}</span></FoldGhost>}
      {open && <FoldDays data-fold-days>
        <FoldSpine type="button" data-focus-chrome aria-expanded aria-label={`Hide ${label}`} onClick={close} />
        {fold.dates.map(date => {
        const day = fold.days.get(date) ?? (writing.has(date) ? blankDay(date) : null);
        return day ? renderDay(day) : <QuietDay key={date} data-day={date} role="button" tabIndex={0}
          aria-label={`Write on ${date}`} onClick={() => startWriting(date)}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startWriting(date); } }}>
          <DateLabel dateTime={date}>{dateObject(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</DateLabel>
        </QuietDay>;
      })}</FoldDays>}
    </FoldRun>;
  };
  return <Logbook aria-label="Logbook" $entering={entering}>
    {sequence.map(item => item.kind === 'day' ? renderDay(item.day) : renderFold(item.fold))}
    <HistoryEnd ref={historyEnd} $showHistory={showHistory}>{hasMore && <TextButton disabled={loadingMore} onClick={() => void loadEarlier()}>{historyError ? 'Retry' : 'Earlier days'}</TextButton>}</HistoryEnd>
  </Logbook>;
}
