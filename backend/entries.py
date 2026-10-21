"""Shared rules for creating, editing, and moving entries."""
import json
import sqlite3
from datetime import date
from fastapi import HTTPException
from .db import ensure_day
from .entry_kinds import EntryKind, api_kind, stored_kind
from .hierarchy import descendants, place, siblings, validate_parent
from .models import EntryText
from .tags import entry_dict


def required(db, table, item_id):
    # table names are internal constants, never supplied by the caller.
    if table in ('notes', 'tasks'):
        kind = stored_kind(table)
        row = db.execute("SELECT * FROM entries WHERE id = ? AND kind = ?", (item_id, kind)).fetchone()
    elif table == 'sessions':
        row = db.execute('SELECT * FROM sessions WHERE id = ?', (item_id,)).fetchone()
    else:
        raise ValueError('Unknown entry table.')
    if not row:
        raise HTTPException(404, "That item no longer exists.")
    return entry_dict(row)


def update_entry(db: sqlite3.Connection, row, value: EntryText, now: str):
    tags = value.tags if value.tags is not None else row['tags']
    if row['content'] != value.content or row['tags'] != tags:
        db.execute('UPDATE entries SET content = ?, tags = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
                   (value.content, json.dumps(tags), now, row['id']))
    return required(db, api_kind(row['kind']), row['id'])


def create_entry(db: sqlite3.Connection, kind: EntryKind, value: EntryText, now: str, *,
                 day: date | None = None, client_id: str | None = None, parent_id: int | None = None,
                 after_id: int | None = None, before_id: int | None = None):
    completed_at = None
    if kind == 'notes':
        if day is None:
            raise HTTPException(422, 'A note needs a date.')
        day_id = ensure_day(db, day, now)
    else:
        parent = required(db, 'tasks', parent_id) if parent_id is not None else None
        completed_at = now if parent and parent['completed_at'] else None
        day_id = parent['day_id'] if parent else None
    validate_parent(db, kind, parent_id, day_id, allow_completed=bool(completed_at))
    cursor = db.execute('''INSERT INTO entries(kind, day_id, content, tags, created_at, updated_at, completed_at, parent_id, client_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                        (stored_kind(kind), day_id, value.content, json.dumps(value.tags or []), now, now, completed_at, parent_id, client_id))
    place(db, kind, cursor.lastrowid, parent_id, after_id, allow_completed_parent=bool(completed_at), before_id=before_id)
    return required(db, kind, cursor.lastrowid)


def check_revision(row, expected):
    if expected is not None and row['revision'] != expected:
        raise HTTPException(409, 'This entry changed elsewhere. Your local draft was preserved.')


def move_entry(db, table, item_id, parent_id, after_id, now, before_id=None, day=None):
    """Move an entry and let its new parent or date determine note/task identity."""
    row = required(db, table, item_id)
    parent = db.execute('SELECT * FROM entries WHERE id = ?', (parent_id,)).fetchone() if parent_id is not None else None
    if parent_id is not None and parent is None:
        raise HTTPException(404, 'The parent entry no longer exists.')
    day_id = ensure_day(db, day, now) if day is not None else row['day_id']
    target_kind = parent['kind'] if parent else ('task' if day_id is None else 'note')
    target_table = api_kind(target_kind)
    if parent and parent['day_id'] != day_id:
        raise HTTPException(409, 'Nested entries must belong to the same list or date.')
    tree = descendants(db, table, item_id)
    if parent_id in {entry['id'] for entry, _ in tree}:
        raise HTTPException(409, 'An entry cannot be nested inside itself or its descendants.')
    previous_day_id, previous_parent_id = row['day_id'], row['parent_id']
    if day_id != previous_day_id:
        # A dated entry takes its whole branch to the new day.
        for entry, _ in tree:
            db.execute('UPDATE entries SET day_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
                       (day_id, now, entry['id']))
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
          allow_completed_parent=bool(parent and parent['completed_at']), before_id=before_id)
    if day_id != previous_day_id and previous_parent_id is None:
        # place() repacks the old list only when the parent changed.
        for position, sibling in enumerate(siblings(db, target_table, None, previous_day_id)):
            db.execute('UPDATE entries SET position = ?, revision = revision + 1 WHERE id = ? AND position != ?',
                       (position, sibling['id'], position))
    return target_table
