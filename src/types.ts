import type { JSONContent } from '@tiptap/core';

export type EntryDocument = JSONContent;

export const ENTRY_KINDS = { note: 'notes', task: 'tasks' } as const;
export type StoredEntryKind = keyof typeof ENTRY_KINDS;
export type EntryKind = typeof ENTRY_KINDS[StoredEntryKind];

export type OutlineItem = {
  id: number;
  kind: EntryKind;
  // The stored entry. Content is its projection as markdown, kept for search,
  // export and the clipboard; only rows written before documents lack one.
  document?: EntryDocument | null;
  content: string;
  parent_id: number | null;
  position: number;
  revision: number;
  tags: string[];
  created_at?: string;
  client_id?: string | null;
  completed_at?: string | null;
  child_count?: number;
  completed_child_count?: number;
};

export type JournalEntry = OutlineItem;
export type Task = OutlineItem & { kind: 'tasks' };
export type Session = {
  id: number;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  seconds_on_day?: number;
};
export type Tag = { name: string; note_count: number; task_count: number };

export type CalendarSubscriptionStatus = 'connecting' | 'connected' | 'error';
export type CalendarSubscription = {
  id: number;
  name: string;
  host: string;
  status: CalendarSubscriptionStatus;
  error: string | null;
  created_at: string;
};

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  cancelled: boolean;
  location: string | null;
  description: string | null;
  links: string[];
};

export type DayMetrics = {
  date: string;
  focused_seconds: number;
  longest_session_seconds: number;
  session_count: number;
};
export type JournalDay = DayMetrics & { entries: JournalEntry[]; events: CalendarEvent[] };
export type JournalData = {
  tag: string | null;
  tags: Tag[];
  today: string;
  days: JournalDay[];
  tasks: Task[];
  active_session: Session | null;
  server_time: string;
  next_cursor: string | null;
};

export type SearchHit = OutlineItem & { date: string | null };
export type SearchResults = { results: SearchHit[]; next_offset: number | null };
export type SessionInput = { started_at: string; duration_seconds: number };
export type CompletionResult = { task_ids: number[]; completed_at: string; items: Task[] };
export type ReopenResult = { reopened: number[]; operation_id: string | null; items: Task[] };
export type DocumentResult = { items: (OutlineItem | null)[]; operation_id: string | null };

export type DailyStat = DayMetrics & { completed_task_count: number; note_count: number };
export type Stats = {
  start: string;
  end: string;
  day_count: number;
  active_days: number;
  total_focused_seconds: number;
  session_count: number;
  average_daily_focused_seconds: number;
  average_daily_longest_session_seconds: number;
  daily: DailyStat[];
};
