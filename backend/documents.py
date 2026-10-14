"""Apply a group of entry edits together and keep one undo record."""
from datetime import datetime
import json
import sqlite3
from zoneinfo import ZoneInfo
from fastapi import HTTPException
from .db import connection
from .entries import check_revision, create_entry, move_entry, required, update_entry
from .entry_kinds import api_kind, stored_kind
from .hierarchy import remove_preserving_children
from .history import record, snapshot
from .models import Content, DocumentBatch, DocumentChange, EntryText
from .stats import stamp
from .tags import entry_dict
from .task_service import archive_task_tree, finish_ready_parents


def _apply_change(db: sqlite3.Connection, change: DocumentChange, now: str, revision_checked: bool, promoted: list[int]):
    kind = change.kind
    stored = stored_kind(kind)
    item_id = change.id
    if item_id is None and change.client_id:
        existing = db.execute('SELECT id FROM entries WHERE kind = ? AND client_id = ?', (stored, change.client_id)).fetchone()
        item_id = existing['id'] if existing else None
    found = db.execute('SELECT * FROM entries WHERE id = ?', (item_id,)).fetchone() if item_id else None
    row = entry_dict(found) if found and found['kind'] == stored else None

    if change.delete:
        if found and row is None:
            raise HTTPException(409, 'That entry has a different kind.')
        if row:
            if not revision_checked:
                check_revision(row, change.expected_revision)
            promoted.extend(remove_preserving_children(db, kind, item_id))
        return None

    if item_id and row is None:
        raise HTTPException(404, 'That entry no longer exists.')
    if row and not revision_checked:
        check_revision(row, change.expected_revision)

    if change.move:
        kind = move_entry(db, kind, item_id, change.parent_id, change.after_id, now, change.before_id)
        if kind == 'tasks':
            promoted.append(item_id)
        return required(db, kind, item_id)

    try:
        content_model = EntryText if change.allow_empty else Content
        tags = change.tags if change.tags is not None else (row or {}).get('tags', [])
        value = content_model(content=change.content, tags=tags)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if row:
        return update_entry(db, row, value, now)
    return create_entry(db, kind, value, now, day=change.date, client_id=change.client_id,
                        parent_id=change.parent_id, after_id=change.after_id, before_id=change.before_id)


def edit_document(body: DocumentBatch, zone: ZoneInfo, instant: datetime):
    now = stamp(instant)
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        if body.request_id:
            receipt = db.execute('SELECT response FROM document_requests WHERE request_id = ?', (body.request_id,)).fetchone()
            if receipt:
                return json.loads(receipt['response'])

        # Check saved versions before making any changes. Moving one entry may
        # also change its siblings' versions while this batch is being applied.
        prevalidated: set[int] = set()
        for index, change in enumerate(body.changes):
            if change.id is None or change.expected_revision is None:
                continue
            original = db.execute('SELECT * FROM entries WHERE id = ? AND kind = ?', (change.id, stored_kind(change.kind))).fetchone()
            if original:
                check_revision(entry_dict(original), change.expected_revision)
                prevalidated.add(index)

        before = snapshot(db)
        promoted: list[int] = []
        results = [_apply_change(db, change, now, index in prevalidated, promoted) for index, change in enumerate(body.changes)]
        parents = [before['tasks'][change.id]['parent_id'] for change in body.changes if change.kind == 'tasks' and change.id in before['tasks']]
        finished = finish_ready_parents(db, parents, zone, instant)
        for item_id in promoted:
            row = db.execute("SELECT * FROM entries WHERE kind = 'task' AND id = ? AND parent_id IS NULL", (item_id,)).fetchone()
            if row and row['completed_at']:
                archive_task_tree(db, entry_dict(row), zone, instant)

        response = {'items': [required(db, api_kind(item['kind']), item['id']) if item else None for item in results],
                    'operation_id': record(db, before, now), 'completed_task_ids': finished}
        if body.request_id:
            db.execute('INSERT INTO document_requests(request_id, response, created_at) VALUES (?, ?, ?)',
                       (body.request_id, json.dumps(response), now))
        return response
