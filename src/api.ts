import type { CalendarEvent, CalendarEventResponse, CalendarSubscription, EntryKind, JournalData, JournalDay, JournalEntry, JournalResponse, OutlineItem } from './types';

export const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, method: HttpMethod = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const url = new URL(`/api${path}`, window.location.origin);
  url.searchParams.set('timezone', timezone);
  let response: Response;
  try {
    response = await fetch(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined, signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Couldn’t connect. Your draft is safe on this device; try again in a moment.');
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('still-auth-required'));
    const error: unknown = await response.json().catch(() => null);
    const detail = typeof error === 'object' && error !== null && 'detail' in error ? (error as { detail?: unknown }).detail : null;
    throw new ApiError(typeof detail === 'string' ? detail : 'Couldn’t save that. Check the values and try again.', response.status);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

const normalizedItem = (item: OutlineItem): OutlineItem => ({
  ...item,
  parent_id: item.parent_id ?? null,
  position: item.position ?? 0,
  revision: item.revision ?? 1,
  tags: item.tags ?? [],
});

const normalizedKind = (kind: OutlineItem['kind'], fallback: EntryKind): EntryKind =>
  kind === 'task' || kind === 'tasks' ? 'tasks' : kind === 'note' || kind === 'notes' ? 'notes' : fallback;

const normalizedEntry = (item: OutlineItem, fallback: EntryKind): JournalEntry => ({
  ...normalizedItem(item),
  kind: normalizedKind(item.kind, fallback),
});

const normalizedEvent = ({ links, ...event }: CalendarEventResponse): CalendarEvent => ({
  ...event,
  location: event.location ?? null,
  description: event.description ?? null,
  links: [...new Set(links ?? [])],
});

const normalizedDay = (day: JournalResponse['days'][number]): JournalDay => {
  const entries = day.entries?.length
    ? day.entries.map(item => normalizedEntry(item, 'notes'))
    : [
        ...(day.notes ?? []).map(item => normalizedEntry(item, 'notes')),
        ...(day.tasks ?? []).map(item => normalizedEntry(item, 'tasks')),
      ];
  return {
    date: day.date,
    focused_seconds: day.focused_seconds ?? 0,
    longest_session_seconds: day.longest_session_seconds ?? 0,
    session_count: day.session_count ?? 0,
    entries,
    events: (day.events ?? []).map(normalizedEvent),
  };
};

export function normalizeJournal(response: JournalResponse): JournalData {
  return {
    ...response,
    tag: response.tag ?? null,
    tags: response.tags ?? [],
    tasks: (response.tasks ?? []).map(normalizedItem),
    days: response.days.map(normalizedDay),
  };
}

export type JournalQuery = { limit?: number; before?: string; on?: string; tag?: string | null };
export async function getJournal(query: JournalQuery = {}): Promise<JournalData> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  if (query.before) parameters.set('before', query.before);
  if (query.on) parameters.set('on', query.on);
  if (query.tag) parameters.set('tag', query.tag);
  const suffix = parameters.size ? `?${parameters}` : '';
  return normalizeJournal(await api<JournalResponse>(`/journal${suffix}`));
}

export const getCalendarSubscriptions = (): Promise<CalendarSubscription[]> => api('/calendars');
export const addCalendarSubscription = (url: string, signal?: AbortSignal): Promise<CalendarSubscription> =>
  api('/calendars', 'POST', { url }, signal);
export const deleteCalendarSubscription = (id: number): Promise<void> => api(`/calendars/${id}`, 'DELETE');

export function localDate(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
export function dateObject(value: string) { return new Date(`${value}T12:00:00`); }
export function duration(seconds: number, includeSeconds = true) {
  const total = Math.floor(Math.max(0, seconds));
  const minutes = Math.floor(total / 60);
  const hoursAndMinutes = `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  if (!includeSeconds) return hoursAndMinutes;
  if (total < 60) return `${total}s`;
  return `${minutes < 60 ? `${minutes}m` : hoursAndMinutes} ${String(total % 60).padStart(2, '0')}s`;
}
export function timerDuration(seconds: number) {
  const total = Math.floor(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return [hours, minutes, total % 60].map(value => String(value).padStart(2, '0')).join(':');
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

let recovery: Promise<boolean> | null = null;
/** Recover pending drafts whose composer disappeared at midnight or while the page was closed. */
export function recoverEarlierDrafts(today: string): Promise<boolean> {
  if (recovery) return recovery;
  recovery = (async () => {
    let changed = false;
    for (const key of Object.keys(localStorage)) {
      if (!/^still-draft-\d{4}-\d{2}-\d{2}$/.test(key) || key === `still-draft-${today}`) continue;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const draft = JSON.parse(raw) as { id: number | null; kind?: 'notes' | 'tasks'; revision?: number | null; requestId?: string; content: string; saved: string; tags?: string[]; savedTags?: string[]; clientId?: string; parentId?: number | null; afterId?: number | null };
        if (typeof draft.content !== 'string' || typeof draft.saved !== 'string') continue;
        if (draft.content !== draft.saved || JSON.stringify(draft.tags ?? []) !== JSON.stringify(draft.savedTags ?? [])) {
          if (!draft.clientId) draft.clientId = crypto.randomUUID();
          if (!draft.requestId) draft.requestId = crypto.randomUUID();
          localStorage.setItem(key, JSON.stringify(draft));
          const kind = draft.kind === 'tasks' ? 'tasks' : 'notes';
          const change = draft.content.trim() || draft.tags?.length ? {
            kind, id: draft.id, content: draft.content, tags: draft.tags, date: key.slice('still-draft-'.length), client_id: draft.clientId,
            parent_id: draft.parentId ?? null, after_id: draft.afterId ?? null, expected_revision: draft.revision ?? null,
          } : { kind, id: draft.id, delete: true, expected_revision: draft.revision ?? null };
          await api('/document/edit', 'POST', { changes: [change], request_id: draft.requestId });
          changed = true;
          // An unmounting composer can still be finishing a save. Do not erase newer recovery data.
          const latest = localStorage.getItem(key);
          if (latest === JSON.stringify(draft)) localStorage.removeItem(key);
        } else {
          localStorage.removeItem(key);
        }
      } catch {
        // One malformed or conflicting draft must not block recovery of the rest.
        continue;
      }
    }
    return changed;
  })().finally(() => { recovery = null; });
  return recovery;
}
