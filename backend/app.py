from contextlib import asynccontextmanager
from datetime import date as CalendarDate, datetime, timedelta, timezone as dt_timezone
from pathlib import Path
import hmac
import json
import os
import sqlite3
import tempfile
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from .db import connection, initialize
from .tags import entry_dict, list_tags, matching_ids, normalize_tag
from .stats import EMPTY_TOTALS, daily_totals, parse, slices, stamp
from .hierarchy import descendants, next_position, remove_preserving_children
from .tasks import visible_tasks
from .history import snapshot, record, restore
from .agent import AgentJournal, AgentQuery, DISCOVERY_LINKS, READ_HEADERS, markdown_journal, read_journal
from .calendars import CalendarLoadError, calendar_content, calendar_host, calendar_name, drop_calendar, load_calendar
from .calendar_store import events_from_subscriptions
from .entries import required, check_revision, move_entry, create_entry, update_entry
from .task_service import finish_task, root_task, archive_task_tree, finish_ready_parents
from .entry_kinds import api_kind
from .documents import edit_document as apply_document_edits
from .responses import (AuthStatusOutput, CompletionOutput, DailyStatsOutput, DocumentOutput, EntryOutput, ExportOutput, HealthOutput, JournalOutput, ReopenOutput, RestoredOutput, SearchOutput, SessionOutput, StatsOutput, TagOutput, TaskOutput, TimerOutput)
from .models import (PasswordLogin, Content, NewEntry, NewNote, EntryLocation, SessionEdit, StopTimer, CalendarSubscriptionInput, CalendarSubscriptionOutput, DocumentBatch, HistoryDirection, HistoryBatch, ReopenTask)


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
AUTH_COOKIE_AGE = int(timedelta(days=30).total_seconds())
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


@app.get('/api/auth/status', response_model=AuthStatusOutput, response_model_exclude_unset=True)
def authentication_status(request: Request):
    enabled = auth_enabled()
    return {'enabled': enabled, 'authenticated': not enabled or valid_auth(request, os.environ.get('STILL_AUTH_PASSWORD', ''))}


@app.post('/api/auth/login', status_code=204)
def authentication_login(body: PasswordLogin, request: Request):
    password = os.environ.get('STILL_AUTH_PASSWORD', '')
    if not auth_enabled() or not hmac.compare_digest(body.password, password):
        raise HTTPException(401, 'Wrong password.')
    response = Response(status_code=204)
    response.set_cookie(AUTH_COOKIE, auth_token(password), max_age=AUTH_COOKIE_AGE, httponly=True,
                        secure=request.url.scheme == 'https', samesite='strict', path='/')
    return response


@app.post('/api/auth/logout', status_code=204)
def authentication_logout():
    response = Response(status_code=204)
    response.delete_cookie(AUTH_COOKIE, path='/', samesite='strict')
    return response


def session_dict(row, now=None):
    result = dict(row)
    end = parse(result["ended_at"]) if result["ended_at"] else (now or utcnow())
    result["duration_seconds"] = max(0, (end - parse(result["started_at"])).total_seconds())
    return result


@app.get("/api/health", response_model=HealthOutput, response_model_exclude_unset=True)
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


@app.get("/api/journal", response_model=JournalOutput, response_model_exclude_unset=True)
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
                    item = {**entry_dict(row), 'kind': api_kind(row['kind'])}
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


@app.get("/api/tags", response_model=list[TagOutput], response_model_exclude_unset=True)
def tags():
    with connection() as db:
        return list_tags(db)


@app.post('/api/document/edit', response_model=DocumentOutput, response_model_exclude_unset=True)
def edit_document(body: DocumentBatch, timezone: str = "UTC"):
    zone = get_zone(timezone)
    return apply_document_edits(body, zone, utcnow())


@app.post('/api/document/history', response_model=RestoredOutput, response_model_exclude_unset=True)
def restore_document_batch(body: HistoryBatch):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        for operation in body.operations:
            restore(db, operation, body.redo)
    return {'restored': True}


@app.post('/api/document/history/{operation_id}', response_model=RestoredOutput, response_model_exclude_unset=True)
def restore_document(operation_id: str, body: HistoryDirection):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        restore(db, operation_id, body.redo)
    return {'restored': True}


@app.get("/api/search", response_model=SearchOutput, response_model_exclude_unset=True)
def search(q: Annotated[str, Query(min_length=1, max_length=200)],
           offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=100)] = 40):
    terms = q.casefold().split()
    with connection() as db:
        rows = [{**entry_dict(r), 'kind': 'notes'} for r in db.execute(
            "SELECT entries.*, days.date FROM entries JOIN days ON entries.day_id = days.id WHERE entries.kind = 'note' ORDER BY days.date DESC, entries.position, entries.id")]
        archived = [{**entry_dict(r), 'kind': 'tasks'} for r in db.execute(
            "SELECT entries.*, days.date FROM entries JOIN days ON entries.day_id = days.id WHERE entries.kind = 'task' ORDER BY days.date DESC, entries.position, entries.id")]
        active = [{**entry_dict(r), 'kind': 'tasks', 'date': None} for r in db.execute(
            "SELECT * FROM entries WHERE kind = 'task' AND day_id IS NULL ORDER BY position, id")]
        rows = active + archived + rows
        matches = [r for r in rows if terms and all(term in (r['content'] + ' ' + ' '.join('#' + tag for tag in r['tags'])).casefold() for term in terms)]
        return {'results': matches[offset:offset + limit], 'next_offset': offset + limit if len(matches) > offset + limit else None}


@app.post("/api/notes", status_code=201, response_model=EntryOutput, response_model_exclude_unset=True)
def add_note(body: NewNote):
    now = stamp(utcnow())
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute("SELECT entries.*, days.date FROM entries JOIN days ON days.id = entries.day_id WHERE kind = 'note' AND client_id = ?", (body.client_id,)).fetchone() if body.client_id else None
        if existing:
            return {**update_entry(db, entry_dict(existing), body, now), 'date': existing['date']}
        row = create_entry(db, 'notes', body, now, day=body.date, client_id=body.client_id, parent_id=body.parent_id, after_id=body.after_id)
        return {**row, 'date': str(body.date)}


@app.patch("/api/notes/{note_id}", response_model=EntryOutput, response_model_exclude_unset=True)
def edit_note(note_id: int, body: Content):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        note = required(db, 'notes', note_id)
        check_revision(note, body.expected_revision)
        return update_entry(db, note, body, stamp(utcnow()))


@app.delete("/api/notes/{note_id}", status_code=204)
def delete_note(note_id: int):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT 1 FROM entries WHERE id = ? AND kind = 'note'", (note_id,)).fetchone():
            return
        remove_preserving_children(db, "notes", note_id)


@app.patch("/api/notes/{note_id}/location", response_model=EntryOutput, response_model_exclude_unset=True)
def move_note(note_id: int, body: EntryLocation):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        check_revision(required(db, 'notes', note_id), body.expected_revision)
        final_table = move_entry(db, "notes", note_id, body.parent_id, body.after_id, stamp(utcnow()))
        db.execute("UPDATE entries SET updated_at = ?, revision = revision + 1 WHERE id = ?", (stamp(utcnow()), note_id))
        return required(db, final_table, note_id)


@app.post("/api/tasks", status_code=201, response_model=TaskOutput, response_model_exclude_unset=True)
def add_task(body: NewEntry):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute("SELECT * FROM entries WHERE kind = 'task' AND client_id = ?", (body.client_id,)).fetchone() if body.client_id else None
        if existing:
            if existing['completed_at']:
                parent = db.execute("SELECT completed_at FROM entries WHERE kind = 'task' AND id = ?", (existing['parent_id'],)).fetchone()
                if not parent or not parent['completed_at']:
                    raise HTTPException(409, 'That task has already been completed.')
            return update_entry(db, entry_dict(existing), body, stamp(utcnow()))
        return create_entry(db, 'tasks', body, stamp(utcnow()), client_id=body.client_id, parent_id=body.parent_id, after_id=body.after_id)


@app.patch("/api/tasks/{task_id}/location", response_model=EntryOutput, response_model_exclude_unset=True)
def move_task(task_id: int, body: EntryLocation, timezone: str = "UTC"):
    zone, now = get_zone(timezone), utcnow()
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        task = required(db, "tasks", task_id)
        check_revision(task, body.expected_revision)
        final_table = move_entry(db, "tasks", task_id, body.parent_id, body.after_id, stamp(utcnow()))
        finish_ready_parents(db, [task["parent_id"]], zone, now)
        moved = required(db, final_table, task_id)
        if final_table == 'tasks' and moved['parent_id'] is None and moved['completed_at']:
            archive_task_tree(db, moved, zone, now)
        return required(db, final_table, task_id)


@app.patch("/api/tasks/{task_id}", response_model=TaskOutput, response_model_exclude_unset=True)
def edit_task(task_id: int, body: Content):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        task = required(db, 'tasks', task_id)
        check_revision(task, body.expected_revision)
        return update_entry(db, task, body, stamp(utcnow()))


@app.post("/api/tasks/{task_id}/complete", response_model=CompletionOutput, response_model_exclude_unset=True)
def complete_task(task_id: int, timezone: str = "UTC", expected_revision: int | None = Query(default=None, ge=1)):
    zone = get_zone(timezone)
    now = utcnow()
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        task = required(db, "tasks", task_id)
        if task["completed_at"]:
            return {"completed": True, "task_ids": [], "completed_at": task['completed_at'], "items": [task]}
        check_revision(task, expected_revision)
        if db.execute("SELECT 1 FROM entries WHERE kind = 'task' AND parent_id = ? AND completed_at IS NULL", (task_id,)).fetchone():
            raise HTTPException(409, 'Complete the children to finish this parent.')
        completed_ids = finish_task(db, task, now)
        archive_task_tree(db, task, zone, now)
        root = root_task(db, required(db, 'tasks', task_id))
        return {"completed": True, "task_ids": completed_ids, "completed_at": stamp(now),
                "items": [entry_dict(row) for row, _ in descendants(db, 'tasks', root['id'])]}


@app.post('/api/tasks/{task_id}/reopen', response_model=ReopenOutput, response_model_exclude_unset=True)
def reopen_task(task_id: int, body: ReopenTask):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        task = required(db, 'tasks', task_id)
        if not task['completed_at']:
            return {'reopened': [], 'operation_id': None, 'items': [task]}
        check_revision(task, body.expected_revision)
        if body.completed_at and task['completed_at'] != body.completed_at:
            raise HTTPException(409, 'This task has changed since that completion.')
        before = snapshot(db) if body.record_history else None
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
        return {'reopened': reopen, 'operation_id': record(db, before, stamp(utcnow())) if before is not None else None,
                'items': [entry_dict(row) for row, _ in descendants(db, 'tasks', root['id'])]}


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, timezone: str = "UTC"):
    zone = get_zone(timezone)
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM entries WHERE id = ? AND kind = 'task'", (task_id,)).fetchone()
        if row is None:
            return
        task = entry_dict(row)
        promoted = remove_preserving_children(db, "tasks", task_id)
        finish_ready_parents(db, [task["parent_id"]], zone, utcnow())
        for item_id in promoted:
            row = db.execute("SELECT * FROM entries WHERE kind = 'task' AND id = ? AND parent_id IS NULL", (item_id,)).fetchone()
            if row and row['completed_at']:
                archive_task_tree(db, entry_dict(row), zone, utcnow())


@app.get("/api/timer", response_model=TimerOutput, response_model_exclude_unset=True)
def timer():
    with connection() as db:
        row = db.execute("SELECT * FROM sessions WHERE ended_at IS NULL").fetchone()
        return {"active_session": session_dict(row) if row else None, "server_time": stamp(utcnow())}


@app.post("/api/timer/start", response_model=SessionOutput, response_model_exclude_unset=True)
def start_timer():
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM sessions WHERE ended_at IS NULL").fetchone()
        if row:
            return session_dict(row)
        cursor = db.execute("INSERT INTO sessions(started_at) VALUES (?)", (stamp(utcnow()),))
        return session_dict(required(db, "sessions", cursor.lastrowid))


@app.post("/api/timer/stop", response_model=SessionOutput, response_model_exclude_unset=True)
def stop_timer(body: StopTimer):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = required(db, "sessions", body.session_id)
        if not row["ended_at"]:
            db.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (stamp(utcnow()), body.session_id))
        return session_dict(required(db, "sessions", body.session_id))


@app.get("/api/sessions", response_model=list[SessionOutput], response_model_exclude_unset=True)
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


@app.post("/api/sessions", status_code=201, response_model=SessionOutput, response_model_exclude_unset=True)
def create_session(body: SessionEdit):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        start, end = validate_session(db, body)
        cursor = db.execute("INSERT INTO sessions(started_at, ended_at) VALUES (?, ?)", (start, end))
        return session_dict(required(db, "sessions", cursor.lastrowid))


@app.patch("/api/sessions/{session_id}", response_model=SessionOutput, response_model_exclude_unset=True)
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


@app.get("/api/stats", response_model=StatsOutput, response_model_exclude_unset=True)
def stats(start: CalendarDate | None = None, end: CalendarDate | None = None, timezone: str = "UTC"):
    return stats_data(start, end, timezone)


@app.get("/api/stats/daily", response_model=DailyStatsOutput, response_model_exclude_unset=True)
def daily_stats(start: CalendarDate | None = None, end: CalendarDate | None = None, timezone: str = "UTC"):
    result = stats_data(start, end, timezone)
    return {key: result[key] for key in ("timezone", "start", "end", "daily", "includes_running_session")}


@app.get("/api/export", response_model=ExportOutput, response_model_exclude_unset=True)
def export():
    with connection() as db:
        entries = [entry_dict(r) for r in db.execute('SELECT * FROM entries ORDER BY id')]
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
         description='Read-only, versioned JSON. All calendar days are included; q/tag filter entries, never focus totals. '
                     'Times are UTC and durations are seconds. next_url preserves filters and omits repeated tasks.')
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

    @app.get("/index.html", include_in_schema=False)
    def index_html():
        # The precached shell is fetched by this name, not by "/".
        return FileResponse(dist / "index.html", headers=READ_HEADERS)

    @app.get("/favicon.svg")
    def favicon():
        return FileResponse(dist / "favicon.svg")

    @app.get("/sw.js")
    def service_worker():
        # Served from the root so its scope covers the whole app, and never
        # cached itself, so a new build replaces the old shell.
        return FileResponse(dist / "sw.js", media_type="text/javascript",
                            headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})
