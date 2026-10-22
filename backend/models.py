"""Shared request types. Validate input before changing saved entries."""
import json
from datetime import date as CalendarDate, datetime, timezone as dt_timezone
from typing import Annotated, Literal, Self
from pydantic import BaseModel, Field, StrictBool, StrictInt, field_validator, model_validator
from .tags import normalize_tags
from .calendars import normalize_calendar_url
from .entry_kinds import EntryKind
from .policy import entry_policy

SavedId = Annotated[StrictInt, Field(ge=1)]
ClientId = Annotated[str, Field(min_length=1, max_length=entry_policy.max_client_id_length)]
EntryContent = Annotated[str, Field(max_length=entry_policy.max_content_length)]
EntryTags = Annotated[list[str], Field(max_length=entry_policy.max_tags)]
EntryNodes = dict
# A document carries node and mark names around the same text, so it is allowed
# several times the text limit before it is refused outright.
DOCUMENT_RATIO = 12


class PasswordLogin(BaseModel):
    password: str = Field(min_length=1, max_length=1000)


class EntryText(BaseModel):
    content: EntryContent = Field(description="Markdown text only. Tags are stored separately.")
    tags: EntryTags | None = Field(default=None, description="Omit to keep saved tags; use [] to clear them.")
    document: EntryNodes | None = Field(default=None, description=(
        "The entry as an editor document. Stored as given; content and tags are "
        "its projection, kept beside it for search, export and tag filtering."))
    expected_revision: SavedId | None = Field(default=None, exclude=True)

    @field_validator("document")
    @classmethod
    def whole_document(cls, value: dict | None) -> dict | None:
        if value is None:
            return None
        if value.get("type") != "doc" or not isinstance(value.get("content"), list):
            raise ValueError("A document needs a doc node with content.")
        if len(json.dumps(value, separators=(',', ':'))) > entry_policy.max_content_length * DOCUMENT_RATIO:
            raise ValueError("That document is too large.")
        return value

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, value: list[str] | None) -> list[str] | None:
        return normalize_tags(value) if value is not None else None


class Content(EntryText):
    @model_validator(mode="after")
    def nonempty(self) -> Self:
        if not self.content.strip() and not self.tags:
            raise ValueError("An entry needs text or a tag.")
        return self


class NewEntry(Content):
    client_id: ClientId | None = None
    parent_id: SavedId | None = None
    after_id: SavedId | None = None


class NewNote(NewEntry):
    date: CalendarDate


class EntryLocation(BaseModel):
    parent_id: SavedId | None
    after_id: SavedId | None = None
    expected_revision: SavedId | None = Field(default=None, exclude=True)


class SessionEdit(BaseModel):
    started_at: datetime
    duration_seconds: float = Field(gt=0, le=604800)

    @field_validator("started_at")
    @classmethod
    def aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("Include a timezone offset in started_at.")
        return value.astimezone(dt_timezone.utc)


class StopTimer(BaseModel):
    session_id: SavedId


class CalendarSubscriptionInput(BaseModel):
    url: str = Field(min_length=1, max_length=2048)

    @field_validator('url')
    @classmethod
    def clean_url(cls, value: str) -> str:
        try:
            return normalize_calendar_url(value)
        except ValueError as error:
            raise ValueError(str(error)) from error


class CalendarSubscriptionOutput(BaseModel):
    id: int
    name: str
    host: str
    status: Literal['connecting', 'connected', 'error']
    error: str | None
    created_at: str


class DocumentChange(EntryText):
    kind: EntryKind
    id: SavedId | None = None
    delete: StrictBool = False
    allow_empty: StrictBool = False
    content: EntryContent = ''
    date: CalendarDate | None = None
    parent_id: SavedId | None = None
    after_id: SavedId | None = None
    before_id: SavedId | None = None
    client_id: ClientId | None = None
    move: StrictBool = False

    @model_validator(mode='after')
    def one_action(self) -> Self:
        if self.delete and self.move:
            raise ValueError('An edit cannot move and delete the same entry.')
        if (self.delete or self.move) and self.id is None:
            raise ValueError('Moving or deleting an entry requires its ID.')
        return self


class DocumentBatch(BaseModel):
    changes: list[DocumentChange] = Field(min_length=1, max_length=1000)
    request_id: ClientId | None = None


class HistoryDirection(BaseModel):
    redo: StrictBool = False


class HistoryBatch(HistoryDirection):
    operations: list[str] = Field(min_length=1, max_length=1000)


class ReopenTask(BaseModel):
    completed_at: str | None = None
    record_history: StrictBool = False
    expected_revision: SavedId | None = None
