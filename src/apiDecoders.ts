import { ENTRY_KINDS, type CalendarEvent, type CalendarSubscription, type CompletionResult, type DayMetrics, type DocumentResult,
  type EntryDocument, type EntryKind, type JournalData, type JournalDay, type OutlineItem, type ReopenResult, type SearchResults, type Session, type SharedEntry, type Stats, type Task } from './types';
import { array, boolean, integer, nonnegative, nullable, object, optional, positiveId, strings, text } from './validation';

export function entryKind(value: unknown, fallback: EntryKind): EntryKind {
  if (value == null) return fallback;
  if (value === 'note' || value === 'task') return ENTRY_KINDS[value];
  if (value === 'notes' || value === 'tasks') return value;
  throw new Error('Unknown entry kind.');
}

// A document is kept as the server sent it. Its shape is the editor's to read,
// and a malformed one is simply absent: the markdown projection still renders.
export function entryDocument(value: unknown): EntryDocument | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const node = value as { type?: unknown; content?: unknown };
  return node.type === 'doc' && Array.isArray(node.content) ? (value as EntryDocument) : null;
}

export function entry(value: unknown, fallback: EntryKind = 'notes'): OutlineItem {
  const row = object(value);
  return {
    id: positiveId(row.id), kind: entryKind(row.kind, fallback), content: text(row.content),
    document: entryDocument(row.document),
    parent_id: nullable(row.parent_id, positiveId), position: optional(row.position, nonnegative, 0),
    revision: optional(row.revision, positiveId, 1), tags: [...new Set(optional(row.tags, strings, []))],
    created_at: row.created_at == null ? undefined : text(row.created_at),
    client_id: nullable(row.client_id, text), completed_at: nullable(row.completed_at, text),
    child_count: row.child_count == null ? undefined : nonnegative(row.child_count),
    completed_child_count: row.completed_child_count == null ? undefined : nonnegative(row.completed_child_count),
    // Signs a link to this entry. Absent on a row saved while offline, which
    // has no link to copy until the server has seen it.
    signature: optional(row.signature, text, ''),
  };
}
export function task(value: unknown): Task {
  const row = entry(value, 'tasks');
  if (row.kind !== 'tasks') throw new Error('Expected a task.');
  return { ...row, kind: 'tasks' };
}
export function session(value: unknown): Session {
  const row = object(value);
  return { id: positiveId(row.id), started_at: text(row.started_at), ended_at: nullable(row.ended_at, text),
    duration_seconds: nonnegative(row.duration_seconds),
    seconds_on_day: row.seconds_on_day == null ? undefined : nonnegative(row.seconds_on_day) };
}
function metrics(value: unknown): DayMetrics {
  const row = object(value);
  return { date: text(row.date), focused_seconds: optional(row.focused_seconds, nonnegative, 0),
    longest_session_seconds: optional(row.longest_session_seconds, nonnegative, 0), session_count: optional(row.session_count, nonnegative, 0) };
}
function calendarEvent(value: unknown): CalendarEvent {
  const row = object(value);
  return { id: text(row.id), title: text(row.title), start: text(row.start), end: text(row.end),
    all_day: boolean(row.all_day), cancelled: optional(row.cancelled, boolean, false),
    location: nullable(row.location, text), description: nullable(row.description, text), links: [...new Set(optional(row.links, strings, []))] };
}
function day(value: unknown): JournalDay {
  const row = object(value);
  // An empty current list is still the source of truth. Only missing lists use the old fields.
  const entries = row.entries == null
    ? [...array(row.notes ?? [], item => entry(item, 'notes')), ...array(row.tasks ?? [], item => entry(item, 'tasks'))]
    : array(row.entries, item => entry(item));
  return { ...metrics(row), entries, events: array(row.events ?? [], calendarEvent) };
}
export function normalizeJournal(value: unknown): JournalData {
  const row = object(value);
  return {
    tag: nullable(row.tag, text), today: text(row.today), server_time: text(row.server_time),
    next_cursor: nullable(row.next_cursor, text), active_session: nullable(row.active_session, session),
    tags: array(row.tags ?? [], value => {
      const tag = object(value);
      return { name: text(tag.name), note_count: optional(tag.note_count, nonnegative, 0), task_count: optional(tag.task_count, nonnegative, 0) };
    }),
    days: array(row.days ?? [], day), tasks: array(row.tasks ?? [], task),
  };
}
export function calendarSubscription(value: unknown): CalendarSubscription {
  const row = object(value);
  const status = row.status;
  if (status !== 'connecting' && status !== 'connected' && status !== 'error') throw new Error('Unknown calendar status.');
  return { id: positiveId(row.id), name: text(row.name), host: text(row.host), status,
    error: nullable(row.error, text), created_at: text(row.created_at) };
}
export function documentResult(value: unknown): DocumentResult {
  const row = object(value);
  return { items: array(row.items, value => nullable(value, entry)), operation_id: nullable(row.operation_id, text) };
}
export function completion(value: unknown): CompletionResult {
  const row = object(value);
  return { task_ids: array(row.task_ids, positiveId), completed_at: text(row.completed_at), items: array(row.items, task) };
}
export function reopen(value: unknown): ReopenResult {
  const row = object(value);
  return { reopened: array(row.reopened, positiveId), operation_id: nullable(row.operation_id, text), items: array(row.items, task) };
}
export function search(value: unknown): SearchResults {
  const row = object(value);
  return { results: array(row.results, value => ({ ...entry(value), date: nullable(object(value).date, text) })),
    next_offset: nullable(row.next_offset, integer) };
}
export function sharedEntry(value: unknown): SharedEntry {
  const row = object(value);
  return { date: nullable(row.date, text), entry: entry(row.entry), children: array(row.children, value => entry(value)) };
}
export function stats(value: unknown): Stats {
  const row = object(value);
  const daily = array(row.daily ?? [], value => {
    const day = object(value);
    return { ...metrics(day), completed_task_count: optional(day.completed_task_count, nonnegative, 0), note_count: optional(day.note_count, nonnegative, 0) };
  });
  const dayCount = optional(row.day_count, nonnegative, daily.length);
  const total = optional(row.total_focused_seconds, nonnegative, daily.reduce((sum, day) => sum + day.focused_seconds, 0));
  const longest = daily.reduce((sum, day) => sum + day.longest_session_seconds, 0);
  // Older responses may omit averages. The daily values are enough to rebuild them.
  return { start: text(row.start), end: text(row.end), day_count: dayCount,
    active_days: optional(row.active_days, nonnegative, daily.filter(day => day.focused_seconds > 0).length),
    total_focused_seconds: total, session_count: optional(row.session_count, nonnegative, daily.reduce((sum, day) => sum + day.session_count, 0)),
    average_daily_focused_seconds: optional(row.average_daily_focused_seconds, nonnegative, dayCount ? total / dayCount : 0),
    average_daily_longest_session_seconds: optional(row.average_daily_longest_session_seconds, nonnegative, dayCount ? longest / dayCount : 0),
    daily };
}
