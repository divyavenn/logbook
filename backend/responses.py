"""Response models shared by routes and the published API schema."""
from typing import Literal
from pydantic import BaseModel, Field
from .calendars import CalendarEvent
from .entry_kinds import EntryKind, StoredEntryKind


class EntryOutput(BaseModel):
    id: int = Field(ge=1)
    kind: StoredEntryKind
    day_id: int | None = None
    # The entry as an editor document, absent only on rows written before it
    # was kept. Content is its projection: the same text, as markdown.
    document: dict | None = None
    content: str
    tags: list[str] = Field(default_factory=list)
    parent_id: int | None
    position: int = Field(ge=0)
    created_at: str
    updated_at: str | None = None
    completed_at: str | None = None
    client_id: str | None = None
    revision: int = Field(ge=1)
    date: str | None = None
    child_count: int | None = Field(default=None, ge=0)
    completed_child_count: int | None = Field(default=None, ge=0)


class JournalEntryOutput(EntryOutput):
    kind: EntryKind


class TaskOutput(EntryOutput):
    kind: Literal['task']


class TagOutput(BaseModel):
    name: str
    note_count: int = Field(ge=0)
    task_count: int = Field(ge=0)


class StoredSession(BaseModel):
    id: int = Field(ge=1)
    started_at: str
    ended_at: str | None


class SessionOutput(StoredSession):
    duration_seconds: float = Field(ge=0)
    seconds_on_day: float | None = Field(default=None, ge=0)


class DayMetrics(BaseModel):
    date: str
    focused_seconds: float = Field(ge=0)
    longest_session_seconds: float = Field(ge=0)
    session_count: int = Field(ge=0)
    first_started_at: str | None = None
    last_ended_at: str | None = None


class JournalDayOutput(DayMetrics):
    entries: list[JournalEntryOutput]
    # Older clients still read these two views of the same entries.
    notes: list[JournalEntryOutput]
    tasks: list[JournalEntryOutput]
    events: list[CalendarEvent]


class JournalOutput(BaseModel):
    today: str
    content_format: Literal['markdown']
    tag: str | None
    tags: list[TagOutput]
    days: list[JournalDayOutput]
    tasks: list[TaskOutput]
    active_session: SessionOutput | None
    server_time: str
    next_cursor: str | None


class DocumentOutput(BaseModel):
    items: list[EntryOutput | None]
    operation_id: str | None
    completed_task_ids: list[int]


class CompletionOutput(BaseModel):
    completed: Literal[True]
    task_ids: list[int]
    completed_at: str
    items: list[TaskOutput]


class ReopenOutput(BaseModel):
    reopened: list[int]
    operation_id: str | None
    items: list[TaskOutput]


class SearchOutput(BaseModel):
    results: list[JournalEntryOutput]
    next_offset: int | None


class DailyStat(DayMetrics):
    note_count: int = Field(ge=0)
    completed_task_count: int = Field(ge=0)


class DailyStatsOutput(BaseModel):
    timezone: str
    start: str
    end: str
    daily: list[DailyStat]
    includes_running_session: Literal[False]


class StatsOutput(DailyStatsOutput):
    day_count: int = Field(ge=1)
    active_days: int = Field(ge=0)
    total_focused_seconds: float = Field(ge=0)
    session_count: int = Field(ge=0)
    average_daily_focused_seconds: float = Field(ge=0)
    average_daily_longest_session_seconds: float = Field(ge=0)
    average_active_day_focused_seconds: float = Field(ge=0)
    average_active_day_longest_session_seconds: float = Field(ge=0)


class TimerOutput(BaseModel):
    active_session: SessionOutput | None
    server_time: str


class AuthStatusOutput(BaseModel):
    enabled: bool
    authenticated: bool


class RestoredOutput(BaseModel):
    restored: Literal[True]


class HealthOutput(BaseModel):
    status: Literal['ok']
    storage: Literal['sqlite']


class StoredDay(BaseModel):
    id: int
    date: str
    created_at: str


class ExportOutput(BaseModel):
    schema_version: int
    content_format: Literal['markdown']
    exported_at: str
    days: list[StoredDay]
    entries: list[EntryOutput]
    notes: list[EntryOutput]
    tasks: list[TaskOutput]
    sessions: list[StoredSession]
