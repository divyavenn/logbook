from contextlib import asynccontextmanager
from datetime import date as CalendarDate, datetime, timedelta, timezone as dt_timezone
from pathlib import Path
import hmac
import json
import os
import sqlite3
import tempfile
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator
from starlette.background import BackgroundTask

from .db import connection, ensure_day, initialize
from .tags import bullet_dict, list_tags, matching_ids, normalize_tag, normalize_tags
from .stats import EMPTY_TOTALS, daily_totals, parse, slices, stamp
from .hierarchy import descendants, next_position, place, remove_preserving_children, validate_parent
from .tasks import visible_tasks
from .history import snapshot, record, restore
from .agent import AgentJournal, AgentQuery, DISCOVERY_LINKS, READ_HEADERS, markdown_journal, read_journal
from .calendars import CalendarLoadError, calendar_content, calendar_host, calendar_name, drop_calendar, load_calendar, normalize_calendar_url
from .calendar_store import events_from_subscriptions


def utcnow():
    return datetime.now(dt_timezone.utc)


def get_zone(name):
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(422, "Use a valid IANA timezone, such as America/Los_Angeles.")


@asynccontextmanager
async def lifespan(_app):
    if auth_enabled() and not os.environ.get('STILL_AUTH_PASSWORD'):
        raise RuntimeError('STILL_AUTH_PASSWORD is required when STILL_AUTH_ENABLED is true.')
    initialize()
    yield


app = FastAPI(title="Still Logbook API", version="1.0.0", lifespan=lifespan,
              description="Personal focus journal. Timestamps are UTC; daily statistics use the requested IANA timezone.")


def auth_enabled():
    return os.environ.get('STILL_AUTH_ENABLED', '').strip().lower() in ('1', 'true', 'yes', 'on')


AUTH_COOKIE = 'still_session'
PUBLIC_AUTH_PATHS = {'/api/health', '/api/auth/status', '/api/auth/login'}


def auth_token(password):
    return hmac.new(password.encode(), b'still-session-v1', 'sha256').hexdigest()


def valid_auth(request, password):
    cookie = request.cookies.get(AUTH_COOKIE, '')
    if cookie and hmac.compare_digest(cookie, auth_token(password)):
        return True
    supplied = request.headers.get('authorization', '')
    return supplied.startswith('Bearer ') and hmac.compare_digest(supplied[7:], password)


@app.middleware('http')
async def authenticate(request: Request, call_next):
    path = request.url.path
    protected = path.startswith('/api/') or path == '/journal.md'
    if not auth_enabled() or not protected or path in PUBLIC_AUTH_PATHS:
        return await call_next(request)
    password = os.environ.get('STILL_AUTH_PASSWORD', '')
    if not valid_auth(request, password):
        return JSONResponse({'detail': 'Password required.'}, status_code=401)
    return await call_next(request)


class PasswordLogin(BaseModel):
    password: str = Field(min_length=1, max_length=1000)


@app.get('/api/auth/status')
def authentication_status(request: Request):
    enabled = auth_enabled()
    return {'enabled': enabled, 'authenticated': not enabled or valid_auth(request, os.environ.get('STILL_AUTH_PASSWORD', ''))}


@app.post('/api/auth/login', status_code=204)
def authentication_login(body: PasswordLogin, request: Request):
    password = os.environ.get('STILL_AUTH_PASSWORD', '')
    if not auth_enabled() or not hmac.compare_digest(body.password, password):
        raise HTTPException(401, 'Wrong password.')
    response = Response(status_code=204)
    response.set_cookie(AUTH_COOKIE, auth_token(password), httponly=True, secure=request.url.scheme == 'https', samesite='strict', path='/')
    return response


@app.post('/api/auth/logout', status_code=204)
def authentication_logout():
    response = Response(status_code=204)
    response.delete_cookie(AUTH_COOKIE, path='/', samesite='strict')
    return response


class Content(BaseModel):
    content: str = Field(max_length=10000, description="Markdown text only. Tags are separate metadata, not hashtags embedded in content.")
    tags: list[str] | None = Field(default=None, max_length=50, description="Optional list of tag names. Omit when editing to preserve existing tags; use [] to clear them.")
    expected_revision: int | None = Field(default=None, ge=1, exclude=True)

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, value):
        return normalize_tags(value) if value is not None else None

    @model_validator(mode="after")
    def nonempty(self):
        if not self.content.strip() and not self.tags:
            raise ValueError("A bullet needs text or a tag.")
        return self


class NewBullet(Content):
    client_id: str | None = Field(default=None, min_length=1, max_length=80)
    parent_id: int | None = Field(default=None, ge=1)
    after_id: int | None = Field(default=None, ge=1)


class NewNote(NewBullet):
    date: CalendarDate


class BulletLocation(BaseModel):
    parent_id: int | None = Field(ge=1)
    after_id: int | None = Field(default=None, ge=1)
    expected_revision: int | None = Field(default=None, ge=1, exclude=True)


class SessionEdit(BaseModel):
    started_at: datetime
    duration_seconds: float = Field(gt=0, le=604800)

    @field_validator("started_at")
    @classmethod
    def aware(cls, value):
        if value.tzinfo is None:
            raise ValueError("Include a timezone offset in started_at.")
        return value.astimezone(dt_timezone.utc)


class StopTimer(BaseModel):
    session_id: int


def required(db, table, item_id):
    # table names are internal constants, never supplied by the caller.
    if table in ('notes', 'tasks'):
        kind = 'note' if table == 'notes' else 'task'
        row = db.execute("SELECT * FROM entries WHERE id = ? AND kind = ?", (item_id, kind)).fetchone()
    else:
        row = db.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "That item no longer exists.")
    return bullet_dict(row)


def check_revision(row, expected):
    if expected is not None and row['revision'] != expected:
        raise HTTPException(409, 'This entry changed elsewhere. Your local draft was preserved.')


def move_entry(db, table, item_id, parent_id, after_id, now):
    """Move an entry and let its new parent determine note/task identity."""
    row = required(db, table, item_id)
    parent = db.execute('SELECT * FROM entries WHERE id = ?', (parent_id,)).fetchone() if parent_id is not None else None
    if parent_id is not None and parent is None:
        raise HTTPException(404, 'The parent entry no longer exists.')
    target_kind = parent['kind'] if parent else ('task' if row['day_id'] is None else 'note')
    target_table = 'tasks' if target_kind == 'task' else 'notes'
    if parent and parent['day_id'] != row['day_id']:
        raise HTTPException(409, 'Nested entries must belong to the same list or date.')
    tree = descendants(db, table, item_id)
    if parent_id in {entry['id'] for entry, _ in tree}:
        raise HTTPException(409, 'A bullet cannot be nested inside itself or its descendants.')
    if target_table != table:
        old_parent = row['parent_id']
        db.execute('UPDATE entries SET parent_id = NULL, revision = revision + 1 WHERE id = ?', (item_id,))
        if old_parent is not None:
            old_siblings = db.execute('SELECT id FROM entries WHERE kind = ? AND parent_id = ? ORDER BY position, id',
                                      (row['kind'], old_parent)).fetchall()
            for position, sibling in enumerate(old_siblings):
                db.execute('UPDATE entries SET position = ?, revision = revision + 1 WHERE id = ? AND position != ?',
                           (position, sibling['id'], position))
        for entry, _ in tree:
            completed_at = now if target_kind == 'task' and entry['day_id'] is not None else None
            db.execute('UPDATE entries SET kind = ?, completed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
                       (target_kind, completed_at, now, entry['id']))
    elif target_kind == 'task' and parent and parent['completed_at']:
        # A checked group cannot contain unchecked descendants. Moving a branch
        # into it has the same semantics as creating a new checked subtask.
        for entry, _ in tree:
            db.execute('UPDATE entries SET completed_at = COALESCE(completed_at, ?), updated_at = ?, revision = revision + 1 WHERE id = ?',
                       (now, now, entry['id']))
    place(db, target_table, item_id, parent_id, after_id,
          allow_completed_parent=bool(parent and parent['completed_at']))
    return target_table


def session_dict(row, now=None):
    result = dict(row)
    end = parse(result["ended_at"]) if result["ended_at"] else (now or utcnow())
    result["duration_seconds"] = max(0, (end - parse(result["started_at"])).total_seconds())
    return result


@app.get("/api/health")
def health():
    return {"status": "ok", "storage": "sqlite"}


if os.environ.get('STILL_TEST_MODE') == '1':
    @app.delete('/api/test/reset', status_code=204, include_in_schema=False)
    def reset_test_database():
        """Give each browser test a clean database; this route does not exist in production."""
        with connection() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM document_changes')
            db.execute('DELETE FROM document_operations')
            db.execute('DELETE FROM document_requests')
            db.execute('DELETE FROM entries')
            db.execute('DELETE FROM sessions')
            db.execute('DELETE FROM days')
            db.execute('DELETE FROM calendar_subscriptions')
            db.execute("DELETE FROM sqlite_sequence WHERE name = 'entries'")
        drop_calendar()
        return Response(status_code=204)


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


def calendar_subscription(row: sqlite3.Row) -> CalendarSubscriptionOutput:
    return CalendarSubscriptionOutput(
        id=row['id'], name=row['name'] or calendar_host(row['url']), host=calendar_host(row['url']),
        status=row['status'], error=row['error'], created_at=row['created_at'],
    )


MAX_CALENDAR_SUBSCRIPTIONS = 5


@app.get('/api/calendars')
def list_calendars() -> list[CalendarSubscriptionOutput]:
    with connection() as db:
        return [calendar_subscription(row) for row in db.execute('SELECT * FROM calendar_subscriptions ORDER BY id')]


def connect_calendar(calendar_id: int, url: str) -> None:
    try:
        calendar = load_calendar(url, force=True)
        name, status, error, feed_cache = calendar_name(calendar, url), 'connected', None, calendar_content(url)
    except CalendarLoadError as failure:
        name, status, error, feed_cache = calendar_host(url), 'error', str(failure), None
    with connection() as db:
        db.execute('UPDATE calendar_subscriptions SET name = ?, status = ?, error = ?, feed_cache = COALESCE(?, feed_cache) WHERE id = ?',
                   (name, status, error, feed_cache, calendar_id))


@app.post('/api/calendars', status_code=201)
def add_calendar(body: CalendarSubscriptionInput, background_tasks: BackgroundTasks) -> CalendarSubscriptionOutput:
    with connection() as db:
        existing = db.execute('SELECT * FROM calendar_subscriptions WHERE url = ?', (body.url,)).fetchone()
        if existing:
            raise HTTPException(409, 'That calendar is already connected.')
        if db.execute('SELECT COUNT(*) FROM calendar_subscriptions').fetchone()[0] >= MAX_CALENDAR_SUBSCRIPTIONS:
            raise HTTPException(409, 'You can connect up to five calendars.')
    with connection() as db:
        try:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT * FROM calendar_subscriptions WHERE url = ?', (body.url,)).fetchone()
            if existing:
                raise HTTPException(409, 'That calendar is already connected.')
            if db.execute('SELECT COUNT(*) FROM calendar_subscriptions').fetchone()[0] >= MAX_CALENDAR_SUBSCRIPTIONS:
                raise HTTPException(409, 'You can connect up to five calendars.')
            cursor = db.execute("INSERT INTO calendar_subscriptions(url, name, status, created_at) VALUES (?, ?, 'connecting', ?)",
                                (body.url, calendar_host(body.url), stamp(utcnow())))
        except sqlite3.IntegrityError as error:
            raise HTTPException(409, 'That calendar is already connected.') from error
        row = db.execute('SELECT * FROM calendar_subscriptions WHERE id = ?', (cursor.lastrowid,)).fetchone()
        background_tasks.add_task(connect_calendar, row['id'], row['url'])
        return calendar_subscription(row)


@app.delete('/api/calendars/{calendar_id}', status_code=204)
def delete_calendar(calendar_id: int) -> Response:
    with connection() as db:
        row = db.execute('SELECT * FROM calendar_subscriptions WHERE id = ?', (calendar_id,)).fetchone()
        if row:
            db.execute('DELETE FROM calendar_subscriptions WHERE id = ?', (calendar_id,))
            drop_calendar(row['url'])
    return Response(status_code=204)


@app.get("/api/journal")
def journal(timezone: str = "UTC", before: CalendarDate | None = None, tag: str | None = None, on: CalendarDate | None = None,
            limit: Annotated[int, Query(ge=1, le=100)] = 21):
    zone = get_zone(timezone)
    try:
        tag = normalize_tag(tag) if tag else None
    except ValueError as error:
        raise HTTPException(422, str(error))
    now = utcnow()
    today_date = now.astimezone(zone).date()
    today = today_date.isoformat()
    with connection() as db:
        first_entry_date = db.execute(
            "SELECT MIN(days.date) FROM entries JOIN days ON entries.day_id = days.id"
        ).fetchone()[0]
    calendar_floor = CalendarDate.fromisoformat(first_entry_date) if first_entry_date else today_date
    calendar_end = on + timedelta(days=1) if on else before or today_date + timedelta(days=1)
    calendar_start = max(on or calendar_floor, calendar_floor)
    calendar_days = events_from_subscriptions(calendar_start, calendar_end, zone)
    with connection() as db:
        sessions = [dict(r) for r in db.execute("SELECT * FROM sessions ORDER BY started_at")]
        totals = daily_totals(sessions, zone, now)
        dates = {r["date"] for r in db.execute("SELECT date FROM days")}
        dates.update(totals)
        dates.add(today)
        if not tag:
            dates.update(calendar_days)
        note_ids = matching_ids(db, "notes", tag) if tag else None
        task_ids = set(matching_ids(db, "tasks", tag)) if tag else None
        if note_ids is not None:
            all_ids = [*note_ids, *task_ids]
            dates = {r[0] for r in db.execute("SELECT DISTINCT days.date FROM days JOIN entries ON entries.day_id = days.id WHERE entries.id IN (SELECT value FROM json_each(?))", (json.dumps(all_ids),))}
        if tag:
            dates.add(today)
        ordered = sorted((d for d in dates if (before is None or d < before.isoformat()) and (on is None or d == str(on))), reverse=True)
        selected = ordered[:limit]
        entries = {}
        if selected:
            placeholders = ",".join("?" for _ in selected)
            for row in db.execute(f"SELECT entries.*, days.date FROM entries JOIN days ON entries.day_id = days.id WHERE days.date IN ({placeholders}) ORDER BY entries.position, entries.id", selected):
                included = note_ids is None or row['kind'] == 'note' and row['id'] in note_ids or row['kind'] == 'task' and row['id'] in task_ids
                if included:
                    item = {**bullet_dict(row), 'kind': 'notes' if row['kind'] == 'note' else 'tasks'}
                    entries.setdefault(row['date'], []).append(item)
        days = []
        for d in selected:
            day_entries = entries.get(d, [])
            # `entries` is canonical. Keep these projections only for older API consumers.
            day_notes = [row for row in day_entries if row['kind'] == 'notes']
            day_tasks = [row for row in day_entries if row['kind'] == 'tasks']
            days.append({"date": d, "notes": day_notes, "tasks": day_tasks,
                         "entries": day_entries,
                         "events": calendar_days.get(d, []),
                         **totals.get(d, EMPTY_TOTALS)})
        tasks = visible_tasks(db)
        if task_ids is not None:
            tasks = [task for task in tasks if task["id"] in task_ids]
        active = next((session_dict(s, now) for s in sessions if s["ended_at"] is None), None)
        return {"today": today, "content_format": "markdown", "tag": normalize_tag(tag) if tag else None, "tags": list_tags(db), "days": days, "tasks": tasks, "active_session": active,
                "server_time": stamp(now), "next_cursor": selected[-1] if len(ordered) > limit else None}


@app.get("/api/tags")
def tags():
    with connection() as db:
        return list_tags(db)


class DocumentChange(BaseModel):
    kind: Literal['notes', 'tasks']
    id: int | None = Field(default=None, ge=1)
    delete: bool = False
    content: str = Field(default='', max_length=10000)
    tags: list[str] | None = None
    date: CalendarDate | None = None
    parent_id: int | None = None
    after_id: int | None = None
    client_id: str | None = None
    move: bool = False
    expected_revision: int | None = Field(default=None, ge=1)


class DocumentBatch(BaseModel):
    changes: list[DocumentChange] = Field(min_length=1, max_length=1000)
    request_id: str | None = Field(default=None, min_length=1, max_length=80)


@app.post('/api/document/edit')
def edit_document(body: DocumentBatch, timezone: str = "UTC"):
    now = stamp(utcnow())
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        if body.request_id:
            receipt = db.execute('SELECT response FROM document_requests WHERE request_id = ?', (body.request_id,)).fetchone()
            if receipt:
                return json.loads(receipt['response'])
        # A document edit is one atomic operation. Validate every explicit
        # revision against the document as it existed at the start of the
        # batch: deleting or moving an earlier sibling can legitimately bump
        # later siblings' revisions while the batch is being applied.
        prevalidated = set()
        for index, change in enumerate(body.changes):
            if change.id is None or change.expected_revision is None:
                continue
            entry_kind = 'note' if change.kind == 'notes' else 'task'
            original = db.execute('SELECT * FROM entries WHERE id = ? AND kind = ?', (change.id, entry_kind)).fetchone()
            if original:
                check_revision(bullet_dict(original), change.expected_revision)
                prevalidated.add(index)
        before = snapshot(db)
        results = []
        promoted = []
        for index, change in enumerate(body.changes):
            table = change.kind
            entry_kind = 'note' if table == 'notes' else 'task'
            item_id = change.id
            if item_id is None and change.client_id:
                existing = db.execute('SELECT id FROM entries WHERE kind = ? AND client_id = ?', (entry_kind, change.client_id)).fetchone()
                item_id = existing['id'] if existing else None
            found = db.execute('SELECT * FROM entries WHERE id = ?', (item_id,)).fetchone() if item_id else None
            row = bullet_dict(found) if found and found['kind'] == entry_kind else None
            if change.delete:
                if row:
                    if index not in prevalidated:
                        check_revision(row, change.expected_revision)
                    promoted.extend(remove_preserving_children(db, table, item_id))
                elif found:
                    raise HTTPException(409, 'That entry has a different kind.')
                results.append(None)
                continue
            if item_id and row is None:
                raise HTTPException(404, 'That item no longer exists.')
            if row and index not in prevalidated:
                check_revision(row, change.expected_revision)
            if change.move and row:
                table = move_entry(db, table, item_id, change.parent_id, change.after_id, now)
                if table == 'tasks':
                    promoted.append(item_id)
            else:
                try:
                    value = Content(content=change.content, tags=change.tags if change.tags is not None else (row or {}).get('tags', []))
                except ValueError as error:
                    raise HTTPException(422, str(error))
                encoded = json.dumps(value.tags or [])
                if row:
                    if row['content'] != value.content or row['tags'] != (value.tags or []):
                        db.execute('UPDATE entries SET content = ?, tags = ?, updated_at = ?, revision = revision + 1 WHERE id = ?', (value.content, encoded, now, item_id))
                else:
                    if table == 'notes':
                        if not change.date:
                            raise HTTPException(422, 'A note needs a date.')
                        day_id = ensure_day(db, change.date, now)
                        validate_parent(db, table, change.parent_id, day_id)
                        cursor = db.execute("INSERT INTO entries(kind, day_id, content, tags, created_at, updated_at, parent_id, client_id) VALUES ('note', ?, ?, ?, ?, ?, ?, ?)", (day_id, value.content, encoded, now, now, change.parent_id, change.client_id))
                    else:
                        parent = required(db, 'tasks', change.parent_id) if change.parent_id is not None else None
                        completed_at = now if parent and parent['completed_at'] else None
                        day_id = parent['day_id'] if parent else None
                        validate_parent(db, table, change.parent_id, day_id, allow_completed=bool(completed_at))
                        cursor = db.execute("INSERT INTO entries(kind, day_id, content, tags, created_at, updated_at, completed_at, parent_id, client_id) VALUES ('task', ?, ?, ?, ?, ?, ?, ?, ?)",
                                            (day_id, value.content, encoded, now, now, completed_at, change.parent_id, change.client_id))
                    item_id = cursor.lastrowid
                    place(db, table, item_id, change.parent_id, change.after_id,
                          allow_completed_parent=table == 'tasks' and bool(completed_at))
            results.append(required(db, table, item_id))
        parents = [before['tasks'][change.id]['parent_id'] for change in body.changes if change.kind == 'tasks' and change.id in before['tasks']]
        zone, instant = get_zone(timezone), utcnow()
        finished = finish_ready_parents(db, parents, zone, instant)
        for item_id in promoted:
            row = db.execute("SELECT * FROM entries WHERE kind = 'task' AND id = ? AND parent_id IS NULL", (item_id,)).fetchone()
            if row and row['completed_at']:
                archive_task_tree(db, bullet_dict(row), zone, instant)
        response = {'items': [required(db, 'notes' if item['kind'] == 'note' else 'tasks', item['id']) if item else None for item in results],
                    'operation_id': record(db, before, now), 'completed_task_ids': finished}
        if body.request_id:
            db.execute('INSERT INTO document_requests(request_id, response, created_at) VALUES (?, ?, ?)',
                       (body.request_id, json.dumps(response), now))
        return response


class HistoryDirection(BaseModel):
    redo: bool = False


class HistoryBatch(HistoryDirection):
    operations: list[str] = Field(min_length=1, max_length=1000)


@app.post('/api/document/history')
def restore_document_batch(body: HistoryBatch):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        for operation in body.operations:
            restore(db, operation, body.redo)
    return {'restored': True}


@app.post('/api/document/history/{operation_id}')
def restore_document(operation_id: str, body: HistoryDirection):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        restore(db, operation_id, body.redo)
    return {'restored': True}


@app.get("/api/search")
def search(q: Annotated[str, Query(min_length=1, max_length=200)],
           offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=100)] = 40):
    terms = q.casefold().split()
    with connection() as db:
        rows = [{**bullet_dict(r), 'kind': 'notes'} for r in db.execute(
            "SELECT entries.*, days.date FROM entries JOIN days ON entries.day_id = days.id WHERE entries.kind = 'note' ORDER BY days.date DESC, entries.position, entries.id")]
        archived = [{**bullet_dict(r), 'kind': 'tasks'} for r in db.execute(
            "SELECT entries.*, days.date FROM entries JOIN days ON entries.day_id = days.id WHERE entries.kind = 'task' ORDER BY days.date DESC, entries.position, entries.id")]
        active = [{**bullet_dict(r), 'kind': 'tasks', 'date': None} for r in db.execute(
            "SELECT * FROM entries WHERE kind = 'task' AND day_id IS NULL ORDER BY position, id")]
        rows = active + archived + rows
        matches = [r for r in rows if terms and all(term in (r['content'] + ' ' + ' '.join('#' + tag for tag in r['tags'])).casefold() for term in terms)]
        return {'results': matches[offset:offset + limit], 'next_offset': offset + limit if len(matches) > offset + limit else None}


@app.post("/api/notes", status_code=201)
def add_note(body: NewNote):
    now = stamp(utcnow())
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        if body.client_id:
            existing = db.execute("SELECT entries.*, days.date FROM entries JOIN days ON days.id = entries.day_id WHERE kind = 'note' AND client_id = ?", (body.client_id,)).fetchone()
            if existing:
                tags = body.tags if body.tags is not None else json.loads(existing["tags"])
                db.execute("UPDATE entries SET content = ?, tags = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", (body.content, json.dumps(tags), now, existing["id"]))
                return {**required(db, 'notes', existing['id']), 'date': existing['date']}
        day_id = ensure_day(db, body.date, now)
        validate_parent(db, "notes", body.parent_id, day_id)
        cursor = db.execute("INSERT INTO entries(kind, day_id, content, tags, created_at, updated_at, client_id, parent_id) VALUES ('note', ?, ?, ?, ?, ?, ?, ?)",
                            (day_id, body.content, json.dumps(body.tags or []), now, now, body.client_id, body.parent_id))
        place(db, "notes", cursor.lastrowid, body.parent_id, body.after_id)
        return {**required(db, "notes", cursor.lastrowid), "date": str(body.date)}


@app.patch("/api/notes/{note_id}")
def edit_note(note_id: int, body: Content):
    with connection() as db:
        note = required(db, "notes", note_id)
        check_revision(note, body.expected_revision)
        tags = body.tags if body.tags is not None else note["tags"]
        db.execute("UPDATE entries SET content = ?, tags = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", (body.content, json.dumps(tags), stamp(utcnow()), note_id))
        return required(db, "notes", note_id)


@app.delete("/api/notes/{note_id}", status_code=204)
def delete_note(note_id: int):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT 1 FROM entries WHERE id = ? AND kind = 'note'", (note_id,)).fetchone():
            return
        remove_preserving_children(db, "notes", note_id)


@app.patch("/api/notes/{note_id}/location")
def move_note(note_id: int, body: BulletLocation):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        check_revision(required(db, 'notes', note_id), body.expected_revision)
        final_table = move_entry(db, "notes", note_id, body.parent_id, body.after_id, stamp(utcnow()))
        db.execute("UPDATE entries SET updated_at = ?, revision = revision + 1 WHERE id = ?", (stamp(utcnow()), note_id))
        return required(db, final_table, note_id)


@app.post("/api/tasks", status_code=201)
def add_task(body: NewBullet):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        if body.client_id:
            existing = db.execute("SELECT * FROM entries WHERE kind = 'task' AND client_id = ?", (body.client_id,)).fetchone()
            if existing:
                if existing["completed_at"]:
                    parent = db.execute("SELECT completed_at FROM entries WHERE kind = 'task' AND id = ?", (existing["parent_id"],)).fetchone()
                    if not parent or not parent["completed_at"]:
                        raise HTTPException(409, "That to-do has already been completed.")
                tags = body.tags if body.tags is not None else json.loads(existing["tags"])
                db.execute("UPDATE entries SET content = ?, tags = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", (body.content, json.dumps(tags), stamp(utcnow()), existing["id"]))
                return required(db, 'tasks', existing['id'])
        parent = required(db, "tasks", body.parent_id) if body.parent_id is not None else None
        now = stamp(utcnow())
        completed_at = now if parent and parent["completed_at"] else None
        day_id = parent['day_id'] if parent else None
        validate_parent(db, "tasks", body.parent_id, day_id, allow_completed=bool(completed_at))
        cursor = db.execute("INSERT INTO entries(kind, day_id, content, tags, created_at, updated_at, completed_at, parent_id, client_id) VALUES ('task', ?, ?, ?, ?, ?, ?, ?, ?)",
                            (day_id, body.content, json.dumps(body.tags or []), now, now, completed_at, body.parent_id, body.client_id))
        place(db, "tasks", cursor.lastrowid, body.parent_id, body.after_id, allow_completed_parent=bool(completed_at))
        return required(db, "tasks", cursor.lastrowid)


@app.patch("/api/tasks/{task_id}/location")
def move_task(task_id: int, body: BulletLocation, timezone: str = "UTC"):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        task = required(db, "tasks", task_id)
        check_revision(task, body.expected_revision)
        final_table = move_entry(db, "tasks", task_id, body.parent_id, body.after_id, stamp(utcnow()))
        zone, now = get_zone(timezone), utcnow()
        finish_ready_parents(db, [task["parent_id"]], zone, now)
        moved = required(db, final_table, task_id)
        if final_table == 'tasks' and moved['parent_id'] is None and moved['completed_at']:
            archive_task_tree(db, moved, zone, now)
        return required(db, final_table, task_id)


@app.patch("/api/tasks/{task_id}")
def edit_task(task_id: int, body: Content):
    with connection() as db:
        task = required(db, "tasks", task_id)
        check_revision(task, body.expected_revision)
        tags = body.tags if body.tags is not None else task["tags"]
        db.execute("UPDATE entries SET content = ?, tags = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", (body.content, json.dumps(tags), stamp(utcnow()), task_id))
        return required(db, "tasks", task_id)


def finish_task(db, task, now):
    completed_ids = []
    child = task
    while child and not child['completed_at']:
        completed_ids.append(child['id'])
        db.execute("UPDATE entries SET completed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", (stamp(now), stamp(now), child["id"]))
        parent = child['parent_id']
        if parent is None or db.execute("SELECT 1 FROM entries WHERE kind = 'task' AND parent_id = ? AND completed_at IS NULL", (parent,)).fetchone():
            break
        child = required(db, 'tasks', parent)
    return completed_ids


def root_task(db, task):
    while task['parent_id'] is not None:
        task = required(db, 'tasks', task['parent_id'])
    return task


def archive_task_tree(db, task, zone, now):
    root = root_task(db, required(db, 'tasks', task['id']))
    if not root['completed_at'] or root['day_id'] is not None:
        return
    day_id = ensure_day(db, now.astimezone(zone).date(), stamp(now))
    position = next_position(db, 'tasks', None, day_id)
    tree = descendants(db, 'tasks', root['id'])
    if any(not row['completed_at'] for row, _ in tree):
        raise HTTPException(409, 'A completed task tree cannot contain unfinished descendants.')
    db.execute('UPDATE entries SET day_id = ?, position = ?, revision = revision + 1 WHERE id = ?', (day_id, position, root['id']))
    for row, _ in tree[1:]:
        db.execute('UPDATE entries SET day_id = ?, revision = revision + 1 WHERE id = ?', (day_id, row['id']))


def finish_ready_parents(db, parents, zone, now):
    completed = []
    for parent in set(parents):
        if parent is None:
            continue
        row = db.execute("SELECT * FROM entries WHERE kind = 'task' AND id = ?", (parent,)).fetchone()
        children = db.execute("SELECT completed_at FROM entries WHERE kind = 'task' AND parent_id = ?", (parent,)).fetchall()
        if row and not row['completed_at'] and children and all(child['completed_at'] for child in children):
            finished = finish_task(db, bullet_dict(row), now)
            completed.extend(finished)
            archive_task_tree(db, required(db, 'tasks', finished[-1]), zone, now)
    return completed


@app.post("/api/tasks/{task_id}/complete")
def complete_task(task_id: int, timezone: str = "UTC", expected_revision: int | None = Query(default=None, ge=1)):
    zone = get_zone(timezone)
    now = utcnow()
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        task = required(db, "tasks", task_id)
        if task["completed_at"]:
            return {"completed": True, "task_ids": [], "completed_at": task['completed_at']}
        check_revision(task, expected_revision)
        if db.execute("SELECT 1 FROM entries WHERE kind = 'task' AND parent_id = ? AND completed_at IS NULL", (task_id,)).fetchone():
            raise HTTPException(409, 'Complete the children to finish this parent.')
        completed_ids = finish_task(db, task, now)
        archive_task_tree(db, task, zone, now)
        return {"completed": True, "task_ids": completed_ids, "completed_at": stamp(now)}


class ReopenTask(BaseModel):
    completed_at: str | None = None
    record_history: bool = False
    expected_revision: int | None = Field(default=None, ge=1)


@app.post('/api/tasks/{task_id}/reopen')
def reopen_task(task_id: int, body: ReopenTask):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        before = snapshot(db) if body.record_history else None
        task = required(db, 'tasks', task_id)
        if not task['completed_at']:
            return {'reopened': []}
        check_revision(task, body.expected_revision)
        if body.completed_at and task['completed_at'] != body.completed_at:
            raise HTTPException(409, 'This task has changed since that completion.')
        root = root_task(db, task)
        if root['day_id'] is not None:
            active_position = next_position(db, 'tasks', None, None)
            tree = descendants(db, 'tasks', root['id'])
            db.execute('UPDATE entries SET day_id = NULL, position = ?, revision = revision + 1 WHERE id = ?', (active_position, root['id']))
            for row, _ in tree[1:]:
                db.execute('UPDATE entries SET day_id = NULL, revision = revision + 1 WHERE id = ?', (row['id'],))
        # A root unchecks its descendants. A leaf unchecks itself and completed
        # ancestors, preserving the checked state of its siblings.
        reopen = [r['id'] for r, _ in descendants(db, 'tasks', task_id) if r['completed_at']]
        parent = task['parent_id']
        while parent is not None:
            ancestor = required(db, 'tasks', parent)
            if ancestor['completed_at']:
                reopen.append(parent)
            parent = ancestor['parent_id']
        for item_id in reopen:
            db.execute('UPDATE entries SET completed_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?', (stamp(utcnow()), item_id))
        return {'reopened': reopen, 'operation_id': record(db, before, stamp(utcnow())) if before is not None else None}


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, timezone: str = "UTC"):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM entries WHERE id = ? AND kind = 'task'", (task_id,)).fetchone()
        if row is None:
            return
        task = bullet_dict(row)
        promoted = remove_preserving_children(db, "tasks", task_id)
        finish_ready_parents(db, [task["parent_id"]], get_zone(timezone), utcnow())
        for item_id in promoted:
            row = db.execute("SELECT * FROM entries WHERE kind = 'task' AND id = ? AND parent_id IS NULL", (item_id,)).fetchone()
            if row and row['completed_at']:
                archive_task_tree(db, bullet_dict(row), get_zone(timezone), utcnow())


@app.get("/api/timer")
def timer():
    with connection() as db:
        row = db.execute("SELECT * FROM sessions WHERE ended_at IS NULL").fetchone()
        return {"active_session": session_dict(row) if row else None, "server_time": stamp(utcnow())}


@app.post("/api/timer/start")
def start_timer():
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM sessions WHERE ended_at IS NULL").fetchone()
        if row:
            return session_dict(row)
        cursor = db.execute("INSERT INTO sessions(started_at) VALUES (?)", (stamp(utcnow()),))
        return session_dict(required(db, "sessions", cursor.lastrowid))


@app.post("/api/timer/stop")
def stop_timer(body: StopTimer):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = required(db, "sessions", body.session_id)
        if not row["ended_at"]:
            db.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (stamp(utcnow()), body.session_id))
        return session_dict(required(db, "sessions", body.session_id))


@app.get("/api/sessions")
def list_sessions(date: CalendarDate, timezone: str = "UTC"):
    zone = get_zone(timezone)
    now = utcnow()
    with connection() as db:
        result = []
        for row in db.execute("SELECT * FROM sessions ORDER BY started_at DESC"):
            parts = list(slices(row, zone, now))
            part = next((p for p in parts if p[0] == str(date)), None)
            if part:
                result.append({**session_dict(row, now), "seconds_on_day": part[1]})
        return result


def validate_session(db, body, exclude_id=None):
    start = body.started_at
    end = start + timedelta(seconds=body.duration_seconds)
    if end > utcnow() + timedelta(seconds=1):
        raise HTTPException(422, "A saved session cannot end in the future.")
    for row in db.execute("SELECT * FROM sessions"):
        if row["id"] == exclude_id:
            continue
        other_end = parse(row["ended_at"]) if row["ended_at"] else datetime.max.replace(tzinfo=dt_timezone.utc)
        if start < other_end and end > parse(row["started_at"]):
            raise HTTPException(409, "This overlaps another focus session. Adjust the start or duration.")
    return stamp(start), stamp(end)


@app.post("/api/sessions", status_code=201)
def create_session(body: SessionEdit):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        start, end = validate_session(db, body)
        cursor = db.execute("INSERT INTO sessions(started_at, ended_at) VALUES (?, ?)", (start, end))
        return session_dict(required(db, "sessions", cursor.lastrowid))


@app.patch("/api/sessions/{session_id}")
def edit_session(session_id: int, body: SessionEdit):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = required(db, "sessions", session_id)
        if row["ended_at"] is None:
            raise HTTPException(409, "Stop this session before editing it.")
        start, end = validate_session(db, body, session_id)
        db.execute("UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?", (start, end, session_id))
        return session_dict(required(db, "sessions", session_id))


@app.delete("/api/sessions/{session_id}", status_code=204)
def delete_session(session_id: int):
    with connection() as db:
        row = required(db, "sessions", session_id)
        if row["ended_at"] is None:
            raise HTTPException(409, "Stop this session before deleting it.")
        db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))


def stats_data(start, end, timezone):
    zone = get_zone(timezone)
    now = utcnow()
    end = end or now.astimezone(zone).date()
    start = start or end - timedelta(days=6)
    count = (end - start).days + 1
    if not 1 <= count <= 3660:
        raise HTTPException(422, "Choose an ordered date range of at most 3,660 days.")
    with connection() as db:
        # Completed sessions only: statistics stay reproducible while a timer runs.
        sessions = [dict(r) for r in db.execute("SELECT * FROM sessions WHERE ended_at IS NOT NULL")]
        totals = daily_totals(sessions, zone, now)
        notes = {r["date"]: r["count"] for r in db.execute("SELECT days.date, COUNT(entries.id) AS count FROM days JOIN entries ON days.id = entries.day_id WHERE entries.kind = 'note' GROUP BY days.date")}
        completed = {}
        for row in db.execute("SELECT completed_at FROM entries WHERE kind = 'task' AND completed_at IS NOT NULL"):
            d = parse(row["completed_at"]).astimezone(zone).date().isoformat()
            completed[d] = completed.get(d, 0) + 1
    daily = []
    for i in range(count):
        d = (start + timedelta(days=i)).isoformat()
        daily.append({"date": d, **totals.get(d, EMPTY_TOTALS), "note_count": notes.get(d, 0), "completed_task_count": completed.get(d, 0)})
    active_days = sum(d["focused_seconds"] > 0 for d in daily)
    total = sum(d["focused_seconds"] for d in daily)
    longest_total = sum(d["longest_session_seconds"] for d in daily)
    session_count = sum(any(start.isoformat() <= p[0] <= end.isoformat() for p in slices(s, zone, now)) for s in sessions)
    return {"timezone": timezone, "start": str(start), "end": str(end), "day_count": count,
            "active_days": active_days, "total_focused_seconds": total, "session_count": session_count,
            "average_daily_focused_seconds": total / count,
            "average_daily_longest_session_seconds": longest_total / count,
            "average_active_day_focused_seconds": total / active_days if active_days else 0,
            "average_active_day_longest_session_seconds": longest_total / active_days if active_days else 0,
            "daily": daily, "includes_running_session": False}


@app.get("/api/stats")
def stats(start: CalendarDate | None = None, end: CalendarDate | None = None, timezone: str = "UTC"):
    return stats_data(start, end, timezone)


@app.get("/api/stats/daily")
def daily_stats(start: CalendarDate | None = None, end: CalendarDate | None = None, timezone: str = "UTC"):
    result = stats_data(start, end, timezone)
    return {key: result[key] for key in ("timezone", "start", "end", "daily", "includes_running_session")}


@app.get("/api/export")
def export():
    with connection() as db:
        entries = [bullet_dict(r) for r in db.execute('SELECT * FROM entries ORDER BY id')]
        return {"schema_version": 8, "content_format": "markdown", "exported_at": stamp(utcnow()),
                "days": [dict(r) for r in db.execute('SELECT * FROM days ORDER BY id')],
                "entries": entries,
                # Compatibility views for existing exports and clients.
                "notes": [row for row in entries if row['kind'] == 'note'],
                "tasks": [row for row in entries if row['kind'] == 'task'],
                "sessions": [dict(r) for r in db.execute('SELECT * FROM sessions ORDER BY id')]}


@app.get("/api/backup", response_class=FileResponse)
def backup_database():
    temporary = tempfile.NamedTemporaryFile(prefix="still-backup-", suffix=".sqlite3", delete=False)
    path = Path(temporary.name)
    temporary.close()
    try:
        with connection() as source, sqlite3.connect(path) as destination:
            source.backup(destination)
            if destination.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("SQLite could not verify the backup.")
        return FileResponse(
            path,
            media_type="application/vnd.sqlite3",
            filename=f"still-logbook-{utcnow().date().isoformat()}.sqlite3",
            headers={"Cache-Control": "no-store"},
            background=BackgroundTask(path.unlink, missing_ok=True),
        )
    except Exception:
        path.unlink(missing_ok=True)
        raise


def agent_snapshot(query):
    zone = get_zone(query.timezone)
    now = utcnow()
    try:
        end = query.end or now.astimezone(zone).date()
        start = query.start or end - timedelta(days=29)
        if not 1 <= (end - start).days + 1 <= 3660:
            raise ValueError('Choose an ordered date range of at most 3,660 days.')
        query = query.model_copy(update={
            'start': start, 'end': end, 'tag': normalize_tag(query.tag) if query.tag else None,
            'q': query.q.strip() if query.q else None,
        })
        with connection() as db:
            db.execute('BEGIN')
            return read_journal(db, query, zone, now)
    except (ValueError, OverflowError) as error:
        raise HTTPException(422, str(error))


class AgentJSONResponse(JSONResponse):
    def render(self, content):
        return json.dumps(content, ensure_ascii=False, allow_nan=False, indent=2).encode('utf-8')


class MarkdownResponse(PlainTextResponse):
    media_type = 'text/markdown'


@app.get('/api/agent/journal', response_model=AgentJournal, response_class=AgentJSONResponse, tags=['Agent reads'],
         summary='Read a queryable logbook snapshot, including collapsed descendants',
         description='Read-only, versioned JSON. All calendar days are included; q/tag filter bullets, never focus totals. '
                     'Times are UTC and durations are seconds. next_url preserves filters and omits repeated to-dos.')
def agent_journal(query: Annotated[AgentQuery, Query()], response: Response):
    response.headers.update(READ_HEADERS)
    return agent_snapshot(query)


@app.get('/journal.md', response_class=MarkdownResponse, tags=['Agent reads'], summary='Read the same query as Markdown, without JavaScript')
def agent_markdown(query: Annotated[AgentQuery, Query()]):
    return MarkdownResponse(markdown_journal(agent_snapshot(query)), headers=READ_HEADERS)


@app.get('/llms.txt', response_class=PlainTextResponse, tags=['Agent reads'], summary='Discover the logbook data contract and query examples')
def agent_guide():
    return PlainTextResponse(Path(__file__).with_name('agent-guide.md').read_text(), headers={'Link': DISCOVERY_LINKS})


dist = Path(os.environ.get('STILL_DIST_PATH', Path(__file__).resolve().parents[1] / 'dist'))
if dist.is_dir():
    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
    app.mount("/fonts", StaticFiles(directory=dist / "fonts"), name="fonts")
    app.mount("/icons", StaticFiles(directory=dist / "icons"), name="icons")

    @app.get("/")
    def index(request: Request, query: Annotated[AgentQuery, Query()]):
        choices = []
        for index, part in enumerate(request.headers.get('accept', 'text/html').split(',')):
            media, *parameters = part.strip().lower().split(';')
            try:
                quality = next((float(p.strip()[2:]) for p in parameters if p.strip().startswith('q=')), 1)
            except ValueError:
                continue
            if quality > 0 and media in ('text/html', '*/*', 'application/json', 'text/markdown'):
                choices.append((quality, -index, media))
        preferred = max(choices)[2] if choices else 'text/html'
        headers = {**READ_HEADERS, 'Vary': 'Accept'}
        if preferred == 'text/markdown':
            return MarkdownResponse(markdown_journal(agent_snapshot(query)), headers=headers)
        if preferred == 'application/json':
            return AgentJSONResponse(agent_snapshot(query).model_dump(mode='json'), headers=headers)
        return FileResponse(dist / "index.html", headers=headers)

    @app.get("/favicon.svg")
    def favicon():
        return FileResponse(dist / "favicon.svg")
