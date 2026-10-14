"""Task completion and movement between the active list and journal."""
from fastapi import HTTPException
from .db import ensure_day
from .entries import required
from .hierarchy import descendants, next_position
from .stats import stamp
from .tags import entry_dict


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
            finished = finish_task(db, entry_dict(row), now)
            completed.extend(finished)
            archive_task_tree(db, required(db, 'tasks', finished[-1]), zone, now)
    return completed
