"""Task visibility and logbook placement are derived from the normalized task tree."""
from .tags import entry_dict


def visible_tasks(db):
    rows = [entry_dict(r) for r in db.execute("SELECT * FROM entries WHERE kind = 'task' AND day_id IS NULL ORDER BY position, id")]
    children = {}
    for row in rows:
        children.setdefault(row['parent_id'], []).append(row)
    visible = []
    stack = list(reversed([r for r in children.get(None, []) if not r['completed_at']]))
    while stack:
        row = stack.pop()
        direct = children.get(row['id'], [])
        visible.append({**row, 'child_count': len(direct),
                        'completed_child_count': sum(bool(child['completed_at']) for child in direct)})
        if not row['completed_at']:
            stack.extend(reversed(direct))
    return visible
