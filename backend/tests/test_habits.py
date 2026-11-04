import importlib
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend.db import SCHEMA_VERSION

module = importlib.import_module("backend.app")
# 11am in Los Angeles, the same day there as in UTC.
START = datetime(2026, 9, 16, 18, tzinfo=timezone.utc)
ZONE = "America/Los_Angeles"


@pytest.fixture
def clock():
    return {"now": START}


@pytest.fixture
def client(tmp_path, monkeypatch, clock):
    monkeypatch.setenv("STILL_DB_PATH", str(tmp_path / "habits.sqlite3"))
    monkeypatch.setattr(module, "utcnow", lambda: clock["now"])
    with TestClient(module.app) as client:
        yield client


def journal(client, **params):
    response = client.get("/api/journal", params={"timezone": ZONE, **params})
    assert response.status_code == 200, response.text
    return response.json()


def add_habit(client, name):
    response = client.post("/api/habits", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def done(client, habit, day="2026-09-16"):
    return client.put(f"/api/habits/{habit['id']}/days/{day}", params={"timezone": ZONE})


def logged(data, day):
    return [habit["name"] for habit in next(row for row in data["days"] if row["date"] == day)["habits"]]


def test_a_habit_shows_on_todays_list_without_being_a_task(client):
    client.post("/api/tasks", json={"content": "Ordinary task"})
    first = add_habit(client, "  Stretch   daily ")
    second = add_habit(client, "Read")
    assert first["name"] == "Stretch daily" and first["key"] != second["key"]
    data = journal(client)
    assert [habit["name"] for habit in data["habits"]] == ["Stretch daily", "Read"]
    assert [task["content"] for task in data["tasks"]] == ["Ordinary task"]
    assert client.get("/api/export").json()["entries"][0]["content"] == "Ordinary task"
    assert len(client.get("/api/export").json()["entries"]) == 1
    assert client.post("/api/habits", json={"name": "   "}).status_code == 422


def test_doing_a_habit_moves_it_from_the_list_to_the_days_logbook(client):
    habit = add_habit(client, "Stretch")
    assert done(client, habit).status_code == 204
    assert done(client, habit).status_code == 204  # A second press changes nothing.
    data = journal(client)
    assert data["habits"] == []
    assert logged(data, "2026-09-16") == ["Stretch"]
    assert client.get("/api/habits", params={"timezone": ZONE}).json()[0]["done"] == ["2026-09-16"]
    assert client.delete(f"/api/habits/{habit['id']}/days/2026-09-16", params={"timezone": ZONE}).status_code == 204
    data = journal(client)
    assert [row["name"] for row in data["habits"]] == ["Stretch"] and logged(data, "2026-09-16") == []


def test_a_missed_day_is_just_a_day_without_a_record(client, clock):
    habit = add_habit(client, "Stretch")
    clock["now"] = START + timedelta(days=1)
    data = journal(client)
    assert [row["name"] for row in data["habits"]] == ["Stretch"]
    assert logged(data, "2026-09-16") == [] if any(day["date"] == "2026-09-16" for day in data["days"]) else True
    # A past day can still be filled in from the logbook; a day to come cannot.
    assert done(client, habit, "2026-09-16").status_code == 204
    assert done(client, habit, "2026-09-18").status_code == 422
    assert client.get("/api/habits", params={"timezone": ZONE}).json()[0]["done"] == ["2026-09-16"]


def test_the_timezone_decides_which_day_it_is(client, clock):
    # 1am UTC on the 17th is still the 16th in Los Angeles.
    clock["now"] = datetime(2026, 9, 17, 1, tzinfo=timezone.utc)
    habit = add_habit(client, "Stretch")
    assert journal(client)["today"] == "2026-09-16"
    assert done(client, habit, "2026-09-17").status_code == 422
    assert done(client, habit, "2026-09-16").status_code == 204


def test_a_filtered_view_leaves_habits_out(client):
    habit = add_habit(client, "Stretch")
    client.post("/api/tasks", json={"content": "Tagged", "tags": ["work"]})
    done(client, habit)
    add_habit(client, "Read")
    data = journal(client, tag="work")
    assert data["habits"] == [] and all(day["habits"] == [] for day in data["days"])


def test_habits_keep_the_order_they_are_dragged_into(client):
    stretch, read, walk = (add_habit(client, name) for name in ("Stretch", "Read", "Walk"))
    assert client.put("/api/habits/order", json={"ids": [walk["id"], stretch["id"], read["id"]]}).status_code == 204
    assert [habit["name"] for habit in journal(client)["habits"]] == ["Walk", "Stretch", "Read"]
    assert [habit["name"] for habit in client.get("/api/habits").json()] == ["Walk", "Stretch", "Read"]
    # An order that leaves a habit out, or names one twice, is refused.
    assert client.put("/api/habits/order", json={"ids": [walk["id"], stretch["id"]]}).status_code == 409
    assert client.put("/api/habits/order", json={"ids": [walk["id"], walk["id"], read["id"]]}).status_code == 409


def test_renaming_changes_the_label_everywhere(client):
    habit = add_habit(client, "Stretch")
    done(client, habit)
    renamed = client.patch(f"/api/habits/{habit['id']}", json={"name": "Stretch and breathe"}).json()
    assert renamed["key"] == habit["key"] and renamed["done"] == ["2026-09-16"]
    assert logged(journal(client), "2026-09-16") == ["Stretch and breathe"]


def test_giving_up_a_habit_hides_it_and_keeps_its_days(client, clock):
    habit = add_habit(client, "Stretch")
    done(client, habit)
    clock["now"] = START + timedelta(days=1)
    assert client.delete(f"/api/habits/{habit['id']}").status_code == 204
    data = journal(client)
    assert data["habits"] == []
    assert client.get("/api/habits").json() == []
    [kept] = next(day for day in data["days"] if day["date"] == "2026-09-16")["habits"]
    assert kept["name"] == "Stretch" and kept["archived"] is True
    # Its days stand as they were.
    assert client.delete(f"/api/habits/{habit['id']}/days/2026-09-16", params={"timezone": ZONE}).status_code == 404
    assert done(client, habit, "2026-09-17").status_code == 404
    exported = client.get("/api/export").json()
    assert [row["date"] for row in exported["habit_days"]] == ["2026-09-16"]
    assert exported["habits"][0]["archived_at"] is not None
    assert client.delete(f"/api/habits/{habit['id']}").status_code == 404


def test_the_schema_holds_habits_apart_from_entries(tmp_path, monkeypatch):
    path = tmp_path / "fresh.sqlite3"
    monkeypatch.setenv("STILL_DB_PATH", str(path))
    module.initialize()
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert {row[1] for row in db.execute("PRAGMA table_info(habits)")} >= {"id", "key", "name", "archived_at"}
        assert {row[1] for row in db.execute("PRAGMA table_info(habit_days)")} == {"habit_id", "date", "completed_at"}
        assert not {"habit_id", "habit_date"} & {row[1] for row in db.execute("PRAGMA table_info(entries)")}
