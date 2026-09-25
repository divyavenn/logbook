import sqlite3

import pytest

from backend.db import connection, initialize
from .test_app import client  # noqa: F401 -- shared isolated database fixture


def create(client, kind, content, parent=None, after=None, day="2026-09-16"):
    response = client.post(f"/api/{kind}", json={"content": content, "date": day, "parent_id": parent, "after_id": after})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.parametrize("kind", ["notes", "tasks"])
def test_eight_levels_and_depth_limit(client, kind):
    parent = None
    chain = []
    for level in range(8):
        row = create(client, kind, f"Level {level + 1}", parent)
        assert row["parent_id"] == parent
        chain.append(row)
        parent = row["id"]
    response = client.post(f"/api/{kind}", json={"content": "Too deep", "date": "2026-09-16", "parent_id": parent})
    assert response.status_code == 422
    data = client.get("/api/journal").json()
    rows = data["tasks"] if kind == "tasks" else data["days"][0]["notes"]
    assert len(rows) == 8
    assert {row["id"]: row["parent_id"] for row in rows} == {row["id"]: row["parent_id"] for row in chain}


@pytest.mark.parametrize("kind", ["notes", "tasks"])
def test_move_subtree_outdent_order_and_cycles(client, kind):
    root = create(client, kind, "Root")
    sibling = create(client, kind, "Sibling")
    child = create(client, kind, "Child", sibling["id"])
    move = client.patch(f"/api/{kind}/{sibling['id']}/location", json={"parent_id": root["id"]})
    assert move.status_code == 200
    assert client.patch(f"/api/{kind}/{root['id']}/location", json={"parent_id": child["id"]}).status_code == 409
    assert client.patch(f"/api/{kind}/{root['id']}/location", json={"parent_id": root["id"]}).status_code == 409
    outdent = client.patch(f"/api/{kind}/{child['id']}/location", json={"parent_id": None, "after_id": root["id"]})
    assert outdent.status_code == 200 and outdent.json()["position"] == 1
    tail = create(client, kind, "Tail")
    between = create(client, kind, "Between", after=root["id"])
    exported = client.get("/api/export").json()[kind]
    roots = sorted((row for row in exported if row["parent_id"] is None), key=lambda row: row["position"])
    assert [row["id"] for row in roots] == [root["id"], between["id"], child["id"], tail["id"]]


@pytest.mark.parametrize("kind", ["notes", "tasks"])
def test_deletion_promotes_children_in_place(client, kind):
    before = create(client, kind, "Before")
    parent = create(client, kind, "Parent")
    after = create(client, kind, "After")
    child1 = create(client, kind, "Child one", parent["id"])
    child2 = create(client, kind, "Child two", parent["id"])
    grandchild = create(client, kind, "Grandchild", child1["id"])
    assert client.delete(f"/api/{kind}/{parent['id']}").status_code == 204
    rows = client.get("/api/export").json()[kind]
    roots = sorted((row for row in rows if row["parent_id"] is None), key=lambda row: row["position"])
    assert [row["id"] for row in roots] == [before["id"], child1["id"], child2["id"], after["id"]]
    assert next(row for row in rows if row["id"] == grandchild["id"])["parent_id"] == child1["id"]


def test_completing_leaf_finishes_ready_ancestors_once(client):
    parent = create(client, "tasks", "Project")
    child = create(client, "tasks", "Part", parent["id"])
    grandchild = create(client, "tasks", "Detail", child["id"])
    leaf = create(client, "tasks", "Leaf", grandchild["id"])
    untouched = create(client, "tasks", "Keep open")
    for _ in range(2):
        assert client.post(f"/api/tasks/{leaf['id']}/complete").status_code == 200
    data = client.get("/api/journal").json()
    assert [row["id"] for row in data["tasks"]] == [untouched["id"]]
    tasks = {row["id"]: row for row in data["days"][0]["tasks"]}
    assert len(tasks) == 4
    assert tasks[parent["id"]]["parent_id"] is None
    for current, previous in [(child, parent), (grandchild, child), (leaf, grandchild)]:
        assert tasks[current["id"]]["parent_id"] == previous["id"]
        assert tasks[current["id"]]["content"] == current['content']
    assert client.get("/api/stats").json()["daily"][-1]["completed_task_count"] == 4


def test_completing_child_keeps_parent_open_and_retries_do_not_duplicate(client):
    parent = create(client, "tasks", "Parent")
    child = create(client, "tasks", "Child", parent["id"])
    sibling = create(client, "tasks", "Sibling", parent["id"])
    client.post(f"/api/tasks/{child['id']}/complete")
    assert client.get("/api/journal").json()["tasks"][0]["id"] == parent["id"]
    client.post(f"/api/tasks/{sibling['id']}/complete")
    client.post(f"/api/tasks/{sibling['id']}/complete")
    tasks = client.get("/api/journal").json()["days"][0]["tasks"]
    assert len(tasks) == 3
    assert {task["id"] for task in tasks} == {parent["id"], child["id"], sibling["id"]}


def test_cross_date_links_rejected_and_completed_parent_accepts_checked_child(client):
    parent = create(client, "notes", "Yesterday", day="2026-09-15")
    today = create(client, "notes", "Today")
    assert client.patch(f"/api/notes/{today['id']}/location", json={"parent_id": parent["id"]}).status_code == 409
    assert client.post("/api/notes", json={"date": "2026-09-16", "content": "Bad", "parent_id": parent["id"]}).status_code == 409
    task = create(client, "tasks", "Done")
    client.post(f"/api/tasks/{task['id']}/complete")
    added = client.post("/api/tasks", json={"content": "Added later", "parent_id": task["id"]})
    assert added.status_code == 201 and added.json()["completed_at"]


def test_subtree_depth_checked_before_move(client):
    root = create(client, "notes", "Root")
    parent = root["id"]
    for level in range(7):
        parent = create(client, "notes", str(level), parent)["id"]
    other = create(client, "notes", "Other")
    assert client.patch(f"/api/notes/{root['id']}/location", json={"parent_id": other["id"]}).status_code == 422
    assert next(row for row in client.get("/api/export").json()["notes"] if row["id"] == root["id"])["parent_id"] is None


def test_nested_task_retry_keeps_latest_text_and_parent(client):
    parent = create(client, "tasks", "Parent")
    payload = {"content": "First text", "parent_id": parent["id"], "client_id": "task-retry"}
    first = client.post("/api/tasks", json=payload).json()
    retry = client.post("/api/tasks", json={**payload, "content": "Updated text"}).json()
    assert first["id"] == retry["id"]
    assert retry["content"] == "Updated text" and retry["parent_id"] == parent["id"]
    assert len(client.get("/api/journal").json()["tasks"]) == 2


def test_database_constraints_guard_cycles_and_cross_day_links(client):
    parent = create(client, "notes", "Parent")
    child = create(client, "notes", "Child", parent["id"])
    other = create(client, "notes", "Other day", day="2026-09-15")
    with pytest.raises(sqlite3.IntegrityError), connection() as db:
        db.execute("UPDATE entries SET parent_id = ? WHERE id = ?", (child["id"], parent["id"]))
    with pytest.raises(sqlite3.IntegrityError), connection() as db:
        db.execute("UPDATE entries SET parent_id = ? WHERE id = ?", (other["id"], child["id"]))
    with pytest.raises(sqlite3.IntegrityError), connection() as db:
        db.execute("UPDATE entries SET parent_id = 999999 WHERE id = ?", (child["id"],))


def test_migration_preserves_existing_content_and_order(tmp_path, monkeypatch):
    path = tmp_path / "legacy.sqlite3"
    monkeypatch.setenv("STILL_DB_PATH", str(path))
    with sqlite3.connect(path) as db:
        db.executescript("""
        CREATE TABLE days(id INTEGER PRIMARY KEY, date TEXT UNIQUE, created_at TEXT);
        CREATE TABLE tasks(id INTEGER PRIMARY KEY, content TEXT, created_at TEXT, completed_at TEXT);
        CREATE TABLE notes(id INTEGER PRIMARY KEY, day_id INTEGER REFERENCES days(id), content TEXT, created_at TEXT, updated_at TEXT, source_task_id INTEGER REFERENCES tasks(id), client_id TEXT);
        INSERT INTO days VALUES(1, '2026-09-16', '2026-09-16T12:00:00Z');
        INSERT INTO tasks VALUES(7, 'Existing to-do', '2026-09-16T12:00:00Z', NULL);
        INSERT INTO notes VALUES(4, 1, 'First', '2026-09-16T12:00:00Z', '2026-09-16T12:00:00Z', NULL, 'old-retry-id');
        INSERT INTO notes VALUES(9, 1, 'Second', '2026-09-16T12:00:00Z', '2026-09-16T12:00:00Z', NULL, NULL);
        PRAGMA user_version = 2;
        """)
    initialize(); initialize()
    with connection() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 12
        notes = [dict(row) for row in db.execute("SELECT * FROM entries WHERE kind = 'note' ORDER BY position")]
        assert [row["content"] for row in notes] == ["First", "Second"]
        assert all(row["parent_id"] is None for row in notes)
        assert notes[0]["client_id"] == "old-retry-id"
        assert db.execute("SELECT content FROM entries WHERE kind = 'task'").fetchone()[0] == "Existing to-do"


def test_interrupted_legacy_migration_rolls_back_and_retries(tmp_path, monkeypatch):
    import backend.db as storage
    path = tmp_path / 'interrupted.sqlite3'
    monkeypatch.setenv('STILL_DB_PATH', str(path))
    with sqlite3.connect(path) as db:
        db.executescript('''
        CREATE TABLE days(id INTEGER PRIMARY KEY, date TEXT UNIQUE, created_at TEXT);
        CREATE TABLE tasks(id INTEGER PRIMARY KEY, content TEXT, created_at TEXT, completed_at TEXT);
        CREATE TABLE notes(id INTEGER PRIMARY KEY, day_id INTEGER REFERENCES days(id), content TEXT,
                           created_at TEXT, updated_at TEXT, source_task_id INTEGER, client_id TEXT);
        INSERT INTO days VALUES(1, '2026-09-16', 'created');
        INSERT INTO notes VALUES(1, 1, 'Survives interruption', 'created', 'updated', NULL, NULL);
        PRAGMA user_version = 2;
        ''')
    original = storage._migrate_entries
    def interrupted(db):
        storage._create_entry_schema(db)
        raise RuntimeError('simulated interruption')
    monkeypatch.setattr(storage, '_migrate_entries', interrupted)
    with pytest.raises(RuntimeError):
        storage.initialize()
    monkeypatch.setattr(storage, '_migrate_entries', original)
    storage.initialize()
    with storage.connection() as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 12
        assert db.execute('SELECT content FROM entries').fetchone()[0] == 'Survives interruption'
        assert not db.execute("SELECT 1 FROM sqlite_master WHERE name = 'notes'").fetchone()


def test_migration_preserves_manually_arranged_note_root_order(tmp_path, monkeypatch):
    path = tmp_path / 'ordered.sqlite3'
    monkeypatch.setenv('STILL_DB_PATH', str(path))
    with sqlite3.connect(path) as db:
        db.executescript('''
        CREATE TABLE days(id INTEGER PRIMARY KEY, date TEXT UNIQUE, created_at TEXT);
        CREATE TABLE tasks(id INTEGER PRIMARY KEY, content TEXT, created_at TEXT, completed_at TEXT,
                           parent_id INTEGER, position INTEGER DEFAULT 0, client_id TEXT, tags TEXT DEFAULT '[]');
        CREATE TABLE notes(id INTEGER PRIMARY KEY, day_id INTEGER, content TEXT, created_at TEXT,
                           updated_at TEXT, source_task_id INTEGER, client_id TEXT, parent_id INTEGER,
                           position INTEGER DEFAULT 0, tags TEXT DEFAULT '[]');
        INSERT INTO days VALUES(1, '2026-09-16', 'created');
        INSERT INTO notes VALUES(1, 1, 'Created first, moved last', 'a', 'a', NULL, NULL, NULL, 1, '[]');
        INSERT INTO notes VALUES(2, 1, 'Created later, moved first', 'b', 'b', NULL, NULL, NULL, 0, '[]');
        PRAGMA user_version = 6;
        ''')
    initialize()
    with connection() as db:
        rows = db.execute("SELECT content FROM entries WHERE kind = 'note' ORDER BY position, id").fetchall()
        assert [row[0] for row in rows] == ['Created later, moved first', 'Created first, moved last']


def test_startup_replaces_pre_unification_history_schema(tmp_path, monkeypatch):
    path = tmp_path / 'stale-history.sqlite3'
    monkeypatch.setenv('STILL_DB_PATH', str(path))
    initialize()
    with connection() as db:
        db.execute('DROP TABLE document_changes')
        db.execute('DROP TABLE document_operations')
        db.executescript('''
        CREATE TABLE document_operations(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE document_changes(
          operation_id TEXT NOT NULL, entity TEXT NOT NULL, row_id INTEGER NOT NULL,
          phase TEXT NOT NULL, present INTEGER NOT NULL, content TEXT, tags TEXT,
          day_id INTEGER, parent_id INTEGER, position INTEGER, created_at TEXT,
          updated_at TEXT, completed_at TEXT, source_task_id INTEGER, client_id TEXT,
          PRIMARY KEY(operation_id, entity, row_id, phase)
        );
        INSERT INTO document_operations VALUES ('old', 'created', 0);
        ''')
    initialize()
    with connection() as db:
        columns = {row['name'] for row in db.execute('PRAGMA table_info(document_changes)')}
        assert 'kind' in columns and 'source_task_id' not in columns
        assert db.execute('SELECT COUNT(*) FROM document_operations').fetchone()[0] == 0
