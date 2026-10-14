import * as decode from './apiDecoders';
import { array, boolean, object, type Decoder } from './validation';
import type { DocumentChange } from './entryChanges';
import type { CalendarSubscription, CompletionResult, DocumentResult, JournalData, ReopenResult, SearchResults, Session, SessionInput, Stats } from './types';

export { normalizeJournal } from './apiDecoders';

export const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(path: string, method: HttpMethod = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const url = new URL(`/api${path}`, window.location.origin);
  if (!url.pathname.startsWith('/api/auth/')) url.searchParams.set('timezone', timezone);
  let response: Response;
  try {
    response = await fetch(url, {
      method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Couldn’t connect. Please try again in a moment.');
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('still-auth-required'));
    const error: unknown = await response.json().catch(() => null);
    const detail = typeof error === 'object' && error !== null && 'detail' in error ? error.detail : null;
    throw new ApiError(typeof detail === 'string' ? detail : 'Couldn’t save that. Check the values and try again.', response.status);
  }
  return response.status === 204 ? undefined : response.json();
}

async function decoded<T>(path: string, decoder: Decoder<T>, method: HttpMethod = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const value = await request(path, method, body, signal);
  try { return decoder(value); }
  catch (error) {
    console.error('Unexpected API response:', path, error);
    throw new Error('The server returned data we couldn’t read. Please try again.');
  }
}
export function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }

export type JournalQuery = { limit?: number; before?: string; on?: string; tag?: string | null };
export async function getJournal(query: JournalQuery = {}, signal?: AbortSignal): Promise<JournalData> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  if (query.before) parameters.set('before', query.before);
  if (query.on) parameters.set('on', query.on);
  if (query.tag) parameters.set('tag', query.tag);
  const suffix = parameters.size ? `?${parameters}` : '';
  return decoded(`/journal${suffix}`, decode.normalizeJournal, 'GET', undefined, signal);
}

export function editEntries(changes: readonly DocumentChange[], requestId: string): Promise<DocumentResult> {
  return decoded('/document/edit', decode.documentResult, 'POST', { changes, request_id: requestId });
}
export function completeTask(id: number, expectedRevision?: number): Promise<CompletionResult> {
  const query = expectedRevision === undefined ? '' : `?expected_revision=${expectedRevision}`;
  return decoded(`/tasks/${id}/complete${query}`, decode.completion, 'POST');
}
export type ReopenTaskInput = { completed_at?: string | null; expected_revision?: number; record_history?: boolean };
export function reopenTask(id: number, input: ReopenTaskInput = {}): Promise<ReopenResult> {
  return decoded(`/tasks/${id}/reopen`, decode.reopen, 'POST', input);
}
export async function restoreDocumentHistory(operations: readonly string[], redo: boolean): Promise<void> {
  await request('/document/history', 'POST', { operations, redo });
}
export function searchEntries(query: string, offset = 0, signal?: AbortSignal): Promise<SearchResults> {
  return decoded(`/search?${new URLSearchParams({ q: query, offset: String(offset) })}`, decode.search, 'GET', undefined, signal);
}
export function getStats(start: string, end: string, signal?: AbortSignal): Promise<Stats> {
  return decoded(`/stats?${new URLSearchParams({ start, end })}`, decode.stats, 'GET', undefined, signal);
}
export function getSessions(date: string, signal?: AbortSignal): Promise<Session[]> {
  return decoded(`/sessions?${new URLSearchParams({ date })}`, value => array(value, decode.session), 'GET', undefined, signal);
}
export function saveSession(id: number | 'new', input: SessionInput): Promise<Session> {
  return decoded(id === 'new' ? '/sessions' : `/sessions/${id}`, decode.session, id === 'new' ? 'POST' : 'PATCH', input);
}
export async function deleteSession(id: number): Promise<void> { await request(`/sessions/${id}`, 'DELETE'); }
export function startTimer(): Promise<Session> { return decoded('/timer/start', decode.session, 'POST'); }
export function stopTimer(id: number): Promise<Session> { return decoded('/timer/stop', decode.session, 'POST', { session_id: id }); }
export const getCalendarSubscriptions = (): Promise<CalendarSubscription[]> => decoded('/calendars', value => array(value, decode.calendarSubscription));
export const addCalendarSubscription = (url: string, signal?: AbortSignal): Promise<CalendarSubscription> =>
  decoded('/calendars', decode.calendarSubscription, 'POST', { url }, signal);
export async function deleteCalendarSubscription(id: number): Promise<void> { await request(`/calendars/${id}`, 'DELETE'); }
export function getAuthStatus(signal?: AbortSignal): Promise<{ enabled: boolean; authenticated: boolean }> {
  return decoded('/auth/status', value => {
    const status = object(value);
    return { enabled: boolean(status.enabled), authenticated: boolean(status.authenticated) };
  }, 'GET', undefined, signal);
}
export async function login(password: string): Promise<boolean> {
  try { await request('/auth/login', 'POST', { password }); return true; }
  catch (error) { if (error instanceof ApiError && error.status === 401) return false; throw error; }
}

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
