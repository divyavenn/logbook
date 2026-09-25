import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import styled, { css } from 'styled-components';
import { dateObject, duration, errorMessage } from '../api';
import type { CalendarEvent, Day, Task } from '../types';
import { TextButton } from '../styles';
import { Outline } from './Outline';
import { useJournalContext } from '../JournalContext';
import { compactViewport, fullViewport } from '../layout';

const SectionTitle = styled.button`font-size: 20px; line-height: 1.4; margin-bottom: 4px; font-weight: 500; border: 0; padding: 0; height: calc(var(--todo-heading-height) - 4px); background: transparent; text-align: left;`;
const TodoSection = styled.section`
  align-self: stretch; display: flex; flex-direction: column; flex-shrink: 0; min-width: 180px; min-height: calc(var(--todo-heading-height) + 100px); width: 100%; padding: 0 12px 4px 8px; margin-bottom: 16px;
  @media ${compactViewport} {
    min-width: 0; min-height: calc(var(--todo-heading-height) + 36px); padding: 0; margin: 0;
  }
`;
const DayBlock = styled.section<{ $today: boolean; $showHistory: boolean }>`
  margin-bottom: 20px;
  @media(pointer: coarse) { margin-bottom: 44px; }
  @media ${compactViewport} { display: ${({ $today, $showHistory }) => $today || $showHistory ? 'block' : 'none'}; margin-bottom: 10px; }
`;
const DateHead = styled.button`
  display: flex; align-items: center; gap: 10px; min-height: 40px; margin-bottom: 3px;
  padding: 0; border: 0; background: transparent; text-align: left; white-space: nowrap;
  &:hover > span { text-decoration: underline; }
  &:disabled { cursor: default; opacity: 1; }
  @media(pointer: coarse) { min-height: 44px; }
  @media ${compactViewport} { min-height: 36px; gap: 6px; margin-bottom: 0; }
`;
const DateLabel = styled.time`
  display: inline-block; font-size: 15px; line-height: 24px; padding: 0 6px; margin-left: -6px;
  border-radius: 9px; background: var(--date-bg); transform: translateY(1px);
  @media ${compactViewport} { margin-left: 0; }
`;
const FocusTotal = styled.span`font-size: 12px; line-height: 24px; color: var(--muted); font-variant-numeric: tabular-nums;`;
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
`;
const EventDetail = styled.div`min-width: 0; white-space: pre-wrap;`;
const EventDetailLink = styled.a`color: var(--link); text-decoration: none; text-underline-offset: 2px; &:hover { text-decoration: underline; }`;
const Body = styled.div`
  min-width: 0; padding-left: 20px; flex: 1; display: flex; flex-direction: column;
  > [data-outline-kind='tasks'] { flex: 1; display: flex; flex-direction: column; }
  > [data-outline-kind='tasks'] > [data-task-creation-area] { flex: 1; }
  @media ${compactViewport} { padding-left: 0; }
`;
const HistoryEnd = styled.div<{ $showHistory: boolean }>`
  display: flex; justify-content: center; padding: 20px 0; color: var(--sage);
  @media ${compactViewport} { display: ${({ $showHistory }) => $showHistory ? 'flex' : 'none'}; padding: 8px 0; }
`;
type Actions = { refresh: () => Promise<void>; notify: (message: string) => void };

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

export function Todos({ tasks, refresh, notify }: { tasks: Task[] } & Actions) {
  const [folded, setFolded] = useState(false);
  const { target } = useJournalContext();
  const section = useRef<HTMLElement>(null);
  useEffect(() => { if (target?.kind === 'tasks') setFolded(false); }, [target]);
  return <TodoSection ref={section} aria-labelledby="todo-title"><SectionTitle id="todo-title" data-focus-chrome aria-expanded={!folded} title={folded ? 'Expand to-dos' : 'Fold to-dos'} onClick={() => setFolded(value => !value)}>to do</SectionTitle>
    {!folded && <Body><Outline kind="tasks" items={tasks} composer={tasks.length > 0} refresh={refresh} notify={notify} /></Body>}
  </TodoSection>;
}

export function Journal({ days, today, refresh, notify, openSessions, sessionsEnabled = true, showHistory = false, secondsForDay, loadMore, hasMore, scrollRoot }: {
  days: Day[]; today: string; openSessions: (date: string) => void; secondsForDay: (day: Day) => number;
  sessionsEnabled?: boolean; showHistory?: boolean; loadMore: () => Promise<void>; hasMore: boolean; scrollRoot: RefObject<HTMLDivElement | null>;
} & Actions) {
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(() => new Set());
  const { target } = useJournalContext();
  const historyEnd = useRef<HTMLDivElement>(null);
  const loadingLock = useRef(false);
  const [historyError, setHistoryError] = useState(false);
  const loadEarlier = useCallback(async () => {
    if (loadingLock.current) return;
    loadingLock.current = true; setLoadingMore(true);
    try { await loadMore(); setHistoryError(false); }
    catch (e) { setHistoryError(true); notify(errorMessage(e)); }
    finally { setLoadingMore(false); loadingLock.current = false; }
  }, [loadMore, notify]);
  useEffect(() => {
    if (!hasMore || historyError || !historyEnd.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && (showHistory || window.matchMedia(fullViewport).matches)) void loadEarlier();
    }, { root: scrollRoot.current, rootMargin: '200px' });
    observer.observe(historyEnd.current);
    return () => observer.disconnect();
  }, [hasMore, historyError, loadEarlier, scrollRoot, showHistory]);
  const yesterday = dateObject(today); yesterday.setDate(yesterday.getDate() - 1);
  return <section aria-label="Logbook">
    {days.map(day => {
      const isToday = day.date === today;
      const date = dateObject(day.date);
      const seconds = secondsForDay(day);
      const title = isToday ? 'Today' : date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString(undefined, { weekday: 'long' });
      const entries = day.entries?.length ? day.entries : [
        ...day.notes.map(note => ({ ...note, kind: 'notes' as const })),
        ...(day.tasks ?? []).map(task => ({ ...task, kind: 'tasks' as const })),
      ];
      const targeted = target && entries.some(entry => entry.kind === target.kind && entry.id === target.id);
      return <DayBlock key={day.date} $today={isToday || !!targeted} $showHistory={showHistory} aria-label={`${title}, ${day.date}`}
        onClick={event => {
          if ((event.target as Element).closest('button, a, input, [contenteditable], [role="group"], [data-calendar-event]') || window.getSelection()?.toString()) return;
          window.dispatchEvent(new CustomEvent('still-new-bullet', { detail: `still-draft-${day.date}` }));
        }}>
        <DateHead type="button" data-focus-chrome aria-label={`Focus sessions for ${day.date}`} disabled={!sessionsEnabled}
          onClick={() => { if (sessionsEnabled) openSessions(day.date); }} title={sessionsEnabled ? 'View and edit focus sessions' : undefined}>
          <DateLabel dateTime={day.date}>{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</DateLabel>
          {seconds >= 1 && <FocusTotal>{duration(seconds, true)}</FocusTotal>}
        </DateHead>
        {!!day.events?.length && <EventList aria-label={`Calendar events for ${day.date}`}>
          {day.events.map(event => {
            const text = eventText(event);
            const content = <><EventTitle data-calendar-event-title>{event.title}</EventTitle> <EventMeta data-calendar-event-meta>{eventDetail(event)}</EventMeta></>;
            const links = [...new Set(event.links ?? (event.url ? [event.url] : []))];
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
          <Outline kind="mixed" items={entries} day={day.date} archived composer={isToday} refresh={refresh} notify={notify} />
        </Body>
      </DayBlock>;
    })}
    <HistoryEnd ref={historyEnd} $showHistory={showHistory}>{hasMore && <TextButton disabled={loadingMore} onClick={() => void loadEarlier()}>{historyError ? 'Retry' : 'Earlier days'}</TextButton>}</HistoryEnd>
  </section>;
}
