"""Relational before/after images for undoable unified-entry edits."""
import uuid

from fastapi import HTTPException
from .entry_kinds import api_kind

SCHEMA = '''
CREATE TABLE IF NOT EXISTS document_operations (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS document_changes (
 operation_id TEXT NOT NULL REFERENCES document_operations(id),
 entity TEXT NOT NULL CHECK(entity IN ('notes','tasks')), row_id INTEGER NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('before','after')), present INTEGER NOT NULL,
 kind TEXT, content TEXT, tags TEXT, day_id INTEGER, parent_id INTEGER, position INTEGER,
    created_at TEXT, updated_at TEXT, completed_at TEXT, client_id TEXT, revision INTEGER,
 PRIMARY KEY(operation_id, entity, row_id, phase)
);
'''
FIELDS = ['kind', 'content', 'tags', 'day_id', 'parent_id', 'position', 'created_at', 'updated_at', 'completed_at', 'client_id', 'revision']


def snapshot(db):
    result = {'notes': {}, 'tasks': {}}
    for row in db.execute('SELECT * FROM entries'):
        result[api_kind(row['kind'])][row['id']] = dict(row)
    return result


def record(db, before, now):
    after = snapshot(db)
    changes = [(table, row_id) for table in before for row_id in before[table].keys() | after[table].keys()
               if before[table].get(row_id) != after[table].get(row_id)]
    if not changes:
        return None
    operation = str(uuid.uuid4())
    db.execute('INSERT INTO document_operations(id, created_at) VALUES (?, ?)', (operation, now))
    for table, row_id in changes:
        for phase, state in [('before', before), ('after', after)]:
            row = state[table].get(row_id)
            values = [operation, table, row_id, phase, int(row is not None)] + [(row or {}).get(field) for field in FIELDS]
            db.execute(f"INSERT INTO document_changes(operation_id, entity, row_id, phase, present, {','.join(FIELDS)}) VALUES ({','.join('?' for _ in values)})", values)
    return operation


def restore(db, operation, redo=False):
    event = db.execute('SELECT * FROM document_operations WHERE id = ?', (operation,)).fetchone()
    if not event:
        raise HTTPException(404, 'Edit history not found.')
    if bool(event['undone']) != redo:
        return
    expected_phase, desired_phase = ('before', 'after') if redo else ('after', 'before')
    columns = [row['name'] for row in db.execute('PRAGMA table_info(entries)')]
    phases = {}
    for phase in (expected_phase, desired_phase):
        phases[phase] = {(row['entity'], row['row_id']): (
            {'id': row['row_id'], **{key: row[key] for key in columns if key != 'id'}} if row['present'] else None
        ) for row in db.execute('SELECT * FROM document_changes WHERE operation_id = ? AND phase = ?', (operation, phase))}
    expected, desired = phases[expected_phase], phases[desired_phase]
    current = snapshot(db)
    for (table, row_id), row in expected.items():
        actual = current[table].get(row_id)
        comparable = lambda value: {key: item for key, item in value.items() if key not in ('updated_at', 'revision')} if value else None
        if comparable(actual) != comparable(row):
            raise HTTPException(409, 'This entry changed elsewhere. Undo would overwrite those changes.')
        if desired[(table, row_id)] is None:
            for child in current[table].values():
                if child['parent_id'] == row_id and (table, child['id']) not in desired:
                    raise HTTPException(409, 'New children were added to this entry. Undo would move them.')
    for _, row_id in desired:
        db.execute('UPDATE entries SET parent_id = NULL WHERE id = ?', (row_id,))
    for (_, row_id), row in desired.items():
        if row is None:
            db.execute('DELETE FROM entries WHERE id = ?', (row_id,))
    for _, row in desired.items():
        if row is None:
            continue
        actual = current[api_kind(row['kind'])].get(row['id'])
        restored = {**row, 'parent_id': None,
                    'revision': max(row.get('revision') or 1, (actual or {}).get('revision') or 0) + 1}
        db.execute(f"INSERT INTO entries({','.join(columns)}) VALUES ({','.join('?' for _ in columns)}) "
                   f"ON CONFLICT(id) DO UPDATE SET {','.join(key + '=excluded.' + key for key in columns if key != 'id')}",
                   [restored[key] for key in columns])
    for (_, row_id), row in desired.items():
        if row is not None:
            db.execute('UPDATE entries SET parent_id = ? WHERE id = ?', (row['parent_id'], row_id))
    db.execute('UPDATE document_operations SET undone = ? WHERE id = ?', (int(not redo), operation))
