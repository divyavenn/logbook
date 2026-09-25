export type EntryKind = 'notes' | 'tasks';
export type StoredEntryKind = 'note' | 'task';

export type OutlineItem = {
  id: number;
  kind?: EntryKind | StoredEntryKind;
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

export type JournalEntry = Omit<OutlineItem, 'kind'> & { kind: EntryKind };
export type Task = OutlineItem;
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

export type CalendarEventResponse = Omit<CalendarEvent, 'location' | 'description' | 'links'> & {
  location?: string | null;
  description?: string | null;
  links?: string[];
};
export type JournalDayResponse = DayMetrics & {
  entries?: OutlineItem[];
  notes?: OutlineItem[];
  tasks?: OutlineItem[];
  events?: CalendarEventResponse[];
};
export type JournalResponse = Omit<JournalData, 'days'> & { days: JournalDayResponse[] };

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
