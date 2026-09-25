"""SQLite storage for the unified note/task entry tree."""
import json
import os
import shutil
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .history import FIELDS as HISTORY_FIELDS, SCHEMA as HISTORY_SCHEMA
from .tags import initialize_tags

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT / "data/still.sqlite3"
DEFAULT_SEED_PATH = ROOT / "seed/still-seed.sqlite3"

BASE_SCHEMA = """
CREATE TABLE IF NOT EXISTS days (id INTEGER PRIMARY KEY, date TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
    CHECK(ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_session ON sessions((1)) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_start ON sessions(started_at);
CREATE TABLE IF NOT EXISTS calendar_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connecting', 'connected', 'error')),
    error TEXT,
    feed_cache BLOB,
    created_at TEXT NOT NULL
);
"""

SCHEMA_VERSION = 12

ENTRY_SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('note', 'task')),
    day_id INTEGER REFERENCES days(id),
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'),
    parent_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
    position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT,
    completed_at TEXT,
    client_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    CHECK(kind != 'note' OR (day_id IS NOT NULL AND completed_at IS NULL)),
    CHECK(kind != 'task' OR day_id IS NULL OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS entries_client_id ON entries(kind, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entries_day_order ON entries(day_id, parent_id, position, id);
CREATE INDEX IF NOT EXISTS entries_kind_order ON entries(kind, parent_id, position, id);
CREATE TABLE IF NOT EXISTS document_requests (
    request_id TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS entries_parent_insert BEFORE INSERT ON entries WHEN NEW.parent_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'Nested entries must have the same kind and display location') WHERE EXISTS (
        SELECT 1 FROM entries parent WHERE parent.id = NEW.parent_id
          AND (parent.kind != NEW.kind OR parent.day_id IS NOT NEW.day_id)
    );
END;
CREATE TRIGGER IF NOT EXISTS entries_parent_update BEFORE UPDATE OF parent_id, kind, day_id ON entries BEGIN
    SELECT RAISE(ABORT, 'Nested entries must have the same kind and display location') WHERE
        EXISTS (SELECT 1 FROM entries parent WHERE parent.id = NEW.parent_id
                AND (parent.kind != NEW.kind OR parent.day_id IS NOT NEW.day_id));
END;
CREATE TRIGGER IF NOT EXISTS entries_no_cycle_insert BEFORE INSERT ON entries WHEN NEW.parent_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'Entry hierarchy cannot contain a cycle') WHERE NEW.id = NEW.parent_id;
END;
CREATE TRIGGER IF NOT EXISTS entries_no_cycle_update BEFORE UPDATE OF parent_id ON entries WHEN NEW.parent_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'Entry hierarchy cannot contain a cycle') WHERE NEW.id = NEW.parent_id OR NEW.id IN (
        WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT id, parent_id FROM entries WHERE id = NEW.parent_id
            UNION ALL SELECT entry.id, entry.parent_id FROM entries entry JOIN ancestors ON entry.id = ancestors.parent_id
        ) SELECT id FROM ancestors
    );
END;
"""

LEGACY_SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY, day_id INTEGER NOT NULL REFERENCES days(id), content TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_task_id INTEGER UNIQUE REFERENCES tasks(id), client_id TEXT
);
"""


def db_path():
    return Path(os.environ.get("STILL_DB_PATH", DEFAULT_DB_PATH))


def _seed_on_first_run(path):
    configured = os.environ.get("STILL_SEED_ON_FIRST_RUN")
    if configured is None:
        return path == DEFAULT_DB_PATH
    return configured.strip().lower() in ("1", "true", "yes", "on")


def _install_seed(path):
    """Atomically install the public sample database when no runtime DB exists."""
    if path.exists() or not _seed_on_first_run(path):
        return False
    seed = Path(os.environ.get("STILL_SEED_PATH", DEFAULT_SEED_PATH))
    if not seed.is_file():
        return False

    # Build the copy beside its destination, then link it into place without
    # replacing a database another process may have created in the meantime.
    temporary = path.with_name(f".{path.name}.{os.getpid()}.seed")
    shutil.copyfile(seed, temporary)
    try:
        try:
            os.link(temporary, path)
            return True
        except FileExistsError:
            return False
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def connection():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    try:
        with db:
            yield db
    finally:
        db.close()


def ensure_day(db, day, now):
    db.execute("INSERT OR IGNORE INTO days(date, created_at) VALUES (?, ?)", (str(day), now))
    return db.execute("SELECT id FROM days WHERE date = ?", (str(day),)).fetchone()["id"]


def _prepare_legacy(db):
    """Bring every pre-unification database to the version-6 row shape."""
    _execute_schema(db, LEGACY_SCHEMA)
    columns = {row["name"] for row in db.execute("PRAGMA table_info(notes)")}
    if "client_id" not in columns:
        db.execute("ALTER TABLE notes ADD COLUMN client_id TEXT")
    for table in ("tasks", "notes"):
        columns = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
        if "parent_id" not in columns:
            db.execute(f"ALTER TABLE {table} ADD COLUMN parent_id INTEGER REFERENCES {table}(id) ON DELETE SET NULL")
        if "position" not in columns:
            db.execute(f"ALTER TABLE {table} ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0)")
            db.execute(f"UPDATE {table} SET position = id")
    if "client_id" not in {row["name"] for row in db.execute("PRAGMA table_info(tasks)")}:
        db.execute("ALTER TABLE tasks ADD COLUMN client_id TEXT")
    initialize_tags(db)


def _automatic_completion_note(note, tasks):
    task = tasks.get(note.get("source_task_id"))
    if not task or note["updated_at"] != note["created_at"] or json.loads(note["tags"]) != json.loads(task["tags"]):
        return False
    return note["content"] in ("finished " + task["content"], "finished\n\n" + task["content"])


def _migrate_entries(db):
    notes = [dict(row) for row in db.execute("SELECT * FROM notes ORDER BY id")]
    tasks = {row["id"]: dict(row) for row in db.execute("SELECT * FROM tasks ORDER BY id")}
    source_days = {row["source_task_id"]: row["day_id"] for row in notes if row.get("source_task_id")}
    kept_notes = {row["id"]: row for row in notes if not _automatic_completion_note(row, tasks)}
    task_offset = max(kept_notes, default=0)
    task_ids = {old_id: task_offset + index for index, old_id in enumerate(tasks, 1)}

    _create_entry_schema(db)
    for note in kept_notes.values():
        db.execute("""INSERT INTO entries(id, kind, day_id, content, tags, position, created_at, updated_at, client_id)
                      VALUES (?, 'note', ?, ?, ?, ?, ?, ?, ?)""",
                   (note["id"], note["day_id"], note["content"], note["tags"], note["position"],
                    note["created_at"], note["updated_at"], note["client_id"]))

    children = {}
    for task in tasks.values():
        children.setdefault(task["parent_id"], []).append(task)
    task_days = {}
    for root in children.get(None, []):
        if not root["completed_at"]:
            continue
        day_id = source_days.get(root["id"])
        if day_id is None:
            day_id = ensure_day(db, root["completed_at"][:10], root["completed_at"])
        stack = [root]
        while stack:
            item = stack.pop()
            task_days[item["id"]] = day_id
            stack.extend(reversed(children.get(item["id"], [])))
    for task in tasks.values():
        db.execute("""INSERT INTO entries(id, kind, day_id, content, tags, position, created_at, completed_at, client_id)
                      VALUES (?, 'task', ?, ?, ?, ?, ?, ?, ?)""",
                   (task_ids[task["id"]], task_days.get(task["id"]), task["content"], task["tags"], task["position"],
                    task["created_at"], task["completed_at"], task["client_id"]))

    def kept_note_parent(parent_id):
        while parent_id is not None and parent_id not in kept_notes:
            parent_id = next((row["parent_id"] for row in notes if row["id"] == parent_id), None)
        return parent_id

    for note in kept_notes.values():
        db.execute("UPDATE entries SET parent_id = ? WHERE id = ?", (kept_note_parent(note["parent_id"]), note["id"]))
    for task in tasks.values():
        db.execute("UPDATE entries SET parent_id = ? WHERE id = ?", (task_ids.get(task["parent_id"]), task_ids[task["id"]]))

    # Legacy note positions are user-controlled. Preserve that order. Finished
    # tasks did not previously share a list with notes, so append their roots in
    # their own saved order instead of re-sorting either list by timestamp.
    for day in db.execute("SELECT id FROM days"):
        roots = list(db.execute("""SELECT id FROM entries WHERE day_id = ? AND parent_id IS NULL
                                  ORDER BY CASE kind WHEN 'note' THEN 0 ELSE 1 END, position, id""", (day["id"],)))
        for position, row in enumerate(roots):
            db.execute("UPDATE entries SET position = ? WHERE id = ?", (position, row["id"]))
    for position, row in enumerate(db.execute("SELECT id FROM entries WHERE kind = 'task' AND day_id IS NULL AND parent_id IS NULL ORDER BY position, id")):
        db.execute("UPDATE entries SET position = ? WHERE id = ?", (position, row["id"]))

    db.execute("DROP TABLE IF EXISTS document_changes")
    db.execute("DROP TABLE IF EXISTS document_operations")
    db.execute("DROP TABLE notes")
    db.execute("DROP TABLE tasks")


def _statements(script):
    """Yield complete SQLite statements without losing trigger bodies."""
    statement = ''
    for line in script.splitlines():
        statement += line + '\n'
        if sqlite3.complete_statement(statement):
            if statement.strip():
                yield statement
            statement = ''
    if statement.strip():
        raise sqlite3.OperationalError('Incomplete schema statement')


def _execute_schema(db, script):
    for statement in _statements(script):
        db.execute(statement)


def _create_entry_schema(db):
    _execute_schema(db, ENTRY_SCHEMA)


def _upgrade_entries_v8(db):
    columns = {row['name'] for row in db.execute('PRAGMA table_info(entries)')}
    sql = db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'").fetchone()['sql']
    if 'revision' in columns and 'AUTOINCREMENT' in sql.upper():
        return
    db.execute('DROP TRIGGER IF EXISTS entries_parent_insert')
    db.execute('DROP TRIGGER IF EXISTS entries_parent_update')
    db.execute('DROP TRIGGER IF EXISTS entries_no_cycle_insert')
    db.execute('DROP TRIGGER IF EXISTS entries_no_cycle_update')
    db.execute('DROP INDEX IF EXISTS entries_client_id')
    db.execute('DROP INDEX IF EXISTS entries_day_order')
    db.execute('DROP INDEX IF EXISTS entries_kind_order')
    db.execute('''CREATE TABLE entries_v8 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK(kind IN ('note', 'task')),
        day_id INTEGER REFERENCES days(id), content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'),
        parent_id INTEGER REFERENCES entries_v8(id) ON DELETE SET NULL,
        position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
        created_at TEXT NOT NULL, updated_at TEXT, completed_at TEXT, client_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        CHECK(kind != 'note' OR (day_id IS NOT NULL AND completed_at IS NULL)),
        CHECK(kind != 'task' OR day_id IS NULL OR completed_at IS NOT NULL)
    )''')
    revision = 'revision' if 'revision' in columns else '1'
    db.execute(f'''INSERT INTO entries_v8(id, kind, day_id, content, tags, parent_id, position,
                                         created_at, updated_at, completed_at, client_id, revision)
                   SELECT id, kind, day_id, content, tags, parent_id, position,
                          created_at, updated_at, completed_at, client_id, {revision} FROM entries''')
    db.execute('DROP TABLE entries')
    db.execute('ALTER TABLE entries_v8 RENAME TO entries')
    _create_entry_schema(db)


def initialize():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    _install_seed(path)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA foreign_keys = OFF')
        db.execute('PRAGMA journal_mode = WAL')
        db.execute('BEGIN IMMEDIATE')
        _execute_schema(db, BASE_SCHEMA)
        calendar_columns = {row['name'] for row in db.execute('PRAGMA table_info(calendar_subscriptions)')}
        if 'name' not in calendar_columns:
            db.execute('ALTER TABLE calendar_subscriptions ADD COLUMN name TEXT')
        if 'status' not in calendar_columns:
            db.execute("ALTER TABLE calendar_subscriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'connected'")
        if 'error' not in calendar_columns:
            db.execute('ALTER TABLE calendar_subscriptions ADD COLUMN error TEXT')
        if 'feed_cache' not in calendar_columns:
            db.execute('ALTER TABLE calendar_subscriptions ADD COLUMN feed_cache BLOB')
        db.execute("UPDATE calendar_subscriptions SET status = 'error', error = 'Connection was interrupted. Remove and add this calendar again.' WHERE status = 'connecting'")
        version = db.execute('PRAGMA user_version').fetchone()[0]
        entries = db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'").fetchone()
        legacy = db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes'").fetchone()
        if version < 7 and legacy:
            # A previous migration may have stopped after creating an empty
            # entries table. Legacy tables are authoritative until v7 commits.
            if entries:
                db.execute('DROP TABLE entries')
            _prepare_legacy(db)
            _migrate_entries(db)
        elif not entries:
            _create_entry_schema(db)
        _upgrade_entries_v8(db)
        # Trigger bodies are not replaced by CREATE TRIGGER IF NOT EXISTS.
        db.execute("DROP TRIGGER IF EXISTS entries_parent_update")
        _create_entry_schema(db)
        history = db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_changes'").fetchone()
        if history:
            columns = {row['name'] for row in db.execute('PRAGMA table_info(document_changes)')}
            required = {'operation_id', 'entity', 'row_id', 'phase', 'present', *HISTORY_FIELDS}
            if not required <= columns:
                # Pre-unification history refers to two independent ID spaces
                # and cannot be replayed safely against unified entries.
                db.execute('DROP TABLE document_changes')
                db.execute('DROP TABLE IF EXISTS document_operations')
        _execute_schema(db, HISTORY_SCHEMA)
        violations = db.execute('PRAGMA foreign_key_check').fetchall()
        if violations:
            raise RuntimeError(f'Schema migration would break {len(violations)} foreign-key reference(s).')
        db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
