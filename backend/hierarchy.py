"""Parent and sibling order shared by notes and tasks."""
from fastapi import HTTPException
from .entry_kinds import stored_kind as entry_kind
from .policy import entry_policy

MAX_LEVELS = entry_policy.max_depth


def get_row(db, table, item_id):
    row = db.execute("SELECT * FROM entries WHERE id = ? AND kind = ?", (item_id, entry_kind(table))).fetchone()
    if row is None:
        raise HTTPException(404, "Entry not found.")
    return dict(row)


def siblings(db, table, parent_id, day_id=None):
    # Notes and completed tasks share the day's root list. Child entries
    # stay with their parent's kind, and active tasks have their own root list.
    mixed_roots = parent_id is None and day_id is not None
    query = "SELECT * FROM entries WHERE parent_id IS ?"
    params = [parent_id]
    if not mixed_roots:
        query += " AND kind = ?"
        params.append(entry_kind(table))
    if parent_id is None:
        query += " AND day_id IS ?"
        params.append(day_id)
    return [dict(r) for r in db.execute(query + " ORDER BY position, id", params)]


def descendants(db, table, item_id):
    """Preorder traversal, including the root. No recursion-depth dependency."""
    rows = [dict(r) for r in db.execute("SELECT * FROM entries WHERE kind = ? ORDER BY position, id", (entry_kind(table),))]
    children = {}
    by_id = {r["id"]: r for r in rows}
    for row in rows:
        children.setdefault(row["parent_id"], []).append(row)
    stack = [(by_id[item_id], 0)]
    result = []
    while stack:
        row, depth = stack.pop()
        result.append((row, depth))
        stack.extend((child, depth + 1) for child in reversed(children.get(row["id"], [])))
    return result


def validate_parent(db, table, parent_id, day_id=None, item_id=None, allow_completed=False):
    level = 1
    seen = {item_id} if item_id is not None else set()
    cursor = parent_id
    while cursor is not None:
        if cursor in seen:
            raise HTTPException(409, "An entry cannot be nested inside itself or its descendants.")
        seen.add(cursor)
        parent = get_row(db, table, cursor)
        if parent["day_id"] != day_id:
            raise HTTPException(409, "Nested entries must belong to the same list or date.")
        if table == "tasks" and parent["completed_at"] and not allow_completed:
            raise HTTPException(409, "Cannot nest under a completed task.")
        level += 1
        cursor = parent["parent_id"]
    height = max((depth for _, depth in descendants(db, table, item_id)), default=0) if item_id else 0
    if level + height > MAX_LEVELS:
        raise HTTPException(422, f"Entries support up to {MAX_LEVELS} levels.")


def place(db, table, item_id, parent_id, after_id=None, allow_completed_parent=False, before_id=None):
    row = get_row(db, table, item_id)
    day_id = row.get("day_id")
    validate_parent(db, table, parent_id, day_id, item_id, allow_completed_parent)
    group = [r for r in siblings(db, table, parent_id, day_id) if r["id"] != item_id]
    ids = [r["id"] for r in group]
    if after_id is not None and after_id not in ids:
        raise HTTPException(409, "The preceding entry must be a sibling.")
    if before_id is not None and before_id not in ids:
        raise HTTPException(409, "The following entry must be a sibling.")
    index = ids.index(before_id) if before_id is not None else ids.index(after_id) + 1 if after_id is not None else len(ids)
    ids.insert(index, item_id)
    db.execute("UPDATE entries SET parent_id = ?, revision = revision + 1 WHERE id = ? AND parent_id IS NOT ?",
               (parent_id, item_id, parent_id))
    for position, sibling_id in enumerate(ids):
        db.execute("UPDATE entries SET position = ?, revision = revision + 1 WHERE id = ? AND position != ?",
                   (position, sibling_id, position))
    if row["parent_id"] != parent_id:
        for position, sibling in enumerate(siblings(db, table, row["parent_id"], day_id)):
            db.execute("UPDATE entries SET position = ?, revision = revision + 1 WHERE id = ? AND position != ?",
                       (position, sibling["id"], position))


def remove_with_children(db, table, item_id):
    """A deleted entry takes its branch with it, finished children included.

    Undo restores the whole branch: history images the rows themselves, so
    every deleted descendant is already part of the operation's before state.
    """
    row = get_row(db, table, item_id)
    doomed = [r["id"] for r in db.execute(
        "WITH branch(id) AS (SELECT id FROM entries WHERE id = ?"
        " UNION ALL SELECT entries.id FROM entries JOIN branch ON entries.parent_id = branch.id)"
        " SELECT id FROM branch", (item_id,))]
    db.execute(f"DELETE FROM entries WHERE id IN ({','.join('?' for _ in doomed)})", doomed)
    for position, sibling in enumerate(siblings(db, table, row["parent_id"], row.get("day_id"))):
        db.execute("UPDATE entries SET position = ?, revision = revision + 1 WHERE id = ? AND position != ?",
                   (position, sibling["id"], position))
    return doomed


def next_position(db, table, parent_id, day_id=None):
    group = siblings(db, table, parent_id, day_id)
    return max((r["position"] for r in group), default=-1) + 1
