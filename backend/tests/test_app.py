import importlib
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

module = importlib.import_module("backend.app")
calendar_module = importlib.import_module("backend.calendars")
NOW = datetime(2026, 9, 16, 18, tzinfo=timezone.utc)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("STILL_DB_PATH", str(tmp_path / "test.sqlite3"))
    monkeypatch.setattr(module, "utcnow", lambda: NOW)
    with TestClient(module.app) as client:
        yield client


def add_session(client, start, seconds):
    response = client.post("/api/sessions", json={"started_at": start, "duration_seconds": seconds})
    assert response.status_code == 201, response.text
    return response.json()


def test_first_run_installs_seed_once_without_replacing_runtime_data(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime.sqlite3"
    monkeypatch.setenv("STILL_DB_PATH", str(runtime))
    monkeypatch.setenv("STILL_SEED_ON_FIRST_RUN", "true")
    module.initialize()
    with sqlite3.connect(runtime) as db:
        sample_count = db.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        assert sample_count > 0
        assert db.execute("SELECT COUNT(*) FROM entries WHERE kind = 'task' AND tags != '[]'").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM entries WHERE kind = 'note' AND content LIKE '%](https://%'").fetchone()[0] >= 3
        db.execute("UPDATE entries SET content = 'my private edit' WHERE id = (SELECT MIN(id) FROM entries)")
        db.commit()

    module.initialize()
    with sqlite3.connect(runtime) as db:
        assert db.execute("SELECT content FROM entries WHERE id = (SELECT MIN(id) FROM entries)").fetchone()[0] == "my private edit"
        assert db.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == sample_count


def test_journal_starts_on_local_day_and_persists_notes(client):
    journal = client.get("/api/journal?timezone=Asia/Tokyo").json()
    assert journal["today"] == "2026-09-17"
    assert journal["days"][0]["notes"] == []
    note = client.post("/api/notes", json={"content": "  A thought  ", "date": journal["today"]}).json()
    assert note["content"] == "  A thought  "
    assert client.get("/api/journal?timezone=Asia/Tokyo").json()["days"][0]["notes"][0]["id"] == note["id"]
    assert client.patch(f"/api/notes/{note['id']}", json={"content": "A revised thought"}).status_code == 200
    assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    assert client.get("/api/journal?timezone=Asia/Tokyo").json()["days"][0]["notes"] == []


def test_multiple_calendar_feeds_expand_events_and_live_deletions(client, monkeypatch):
    first_url = 'https://calendar.example/one.ics'
    second_url = 'https://calendar.example/two.ics'
    first_feed = {'value': b'''BEGIN:VCALENDAR\r
VERSION:2.0\r
X-WR-CALNAME:Work calendar\r
BEGIN:VEVENT\r
UID:offsite\r
DTSTART;VALUE=DATE:20260916\r
DTEND;VALUE=DATE:20260917\r
SUMMARY:Company offsite\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:cancelled\r
DTSTART:20260916T150000Z\r
DTEND:20260916T153000Z\r
SUMMARY:Cancelled standup\r
STATUS:CANCELLED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:planning\r
DTSTART:20260916T160000Z\r
DTEND:20260916T170000Z\r
SUMMARY:Planning\r
URL:https://zoom.us/j/12345\r
LOCATION:Studio 4\\, North Wing\r
DESCRIPTION:Bring the launch brief\\nNotes at https://docs.example.com/launch\r
ATTACH:https://files.example.com/agenda.pdf\r
END:VEVENT\r
END:VCALENDAR\r
'''}
    second_feed = b'''BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:daily-sync\r
DTSTART:20260915T190000Z\r
DTEND:20260915T193000Z\r
RRULE:FREQ=DAILY;COUNT=3\r
SUMMARY:Daily sync\r
DESCRIPTION:Join https://meet.google.com/abc-defg-hij\r
END:VEVENT\r
END:VCALENDAR\r
'''

    class FeedResponse:
        status_code = 200
        headers = {}

        def __init__(self, content):
            self.content = content

        def raise_for_status(self):
            return None

    monkeypatch.setenv('STILL_CALENDAR_REFRESH_SECONDS', '0')
    monkeypatch.setattr(calendar_module, '_assert_public_destination', lambda _url: None)
    def feed_get(url, **_kwargs):
        return FeedResponse(first_feed['value'] if url == first_url else second_feed)
    monkeypatch.setattr(calendar_module.httpx, 'get', feed_get)
    calendar_module.drop_calendar()

    first = client.post('/api/calendars', json={'url': first_url})
    second = client.post('/api/calendars', json={'url': second_url})
    assert first.status_code == second.status_code == 201
    assert first.json()['status'] == second.json()['status'] == 'connecting'
    accounts = client.get('/api/calendars').json()
    assert [(item['name'], item['status']) for item in accounts] == [('Work calendar', 'connected'), ('calendar.example', 'connected')]

    without_history = client.get('/api/journal?timezone=America/Los_Angeles').json()
    assert not any(day['date'] == '2026-09-15' and day['events'] for day in without_history['days'])
    assert client.post('/api/notes', json={'date': '2026-09-15', 'content': 'First journal entry'}).status_code == 201
    journal = client.get('/api/journal?timezone=America/Los_Angeles').json()
    today = next(day for day in journal['days'] if day['date'] == '2026-09-16')
    assert [event['title'] for event in today['events']] == ['Company offsite', 'Cancelled standup', 'Planning', 'Daily sync']
    assert today['events'][0]['all_day'] is True
    assert today['events'][1]['cancelled'] is True
    assert today['events'][2]['url'] == 'https://zoom.us/j/12345'
    assert today['events'][2]['location'] == 'Studio 4, North Wing'
    assert today['events'][2]['description'] == 'Bring the launch brief\nNotes at https://docs.example.com/launch'
    assert today['events'][2]['links'] == [
        'https://zoom.us/j/12345', 'https://files.example.com/agenda.pdf', 'https://docs.example.com/launch'
    ]
    assert today['events'][3]['url'] == 'https://meet.google.com/abc-defg-hij'
    assert any(day['date'] == '2026-09-15' and day['events'][0]['title'] == 'Daily sync' for day in journal['days'])

    with module.connection() as db:
        assert all(row['feed_cache'] for row in db.execute('SELECT feed_cache FROM calendar_subscriptions'))

    class RateLimitedResponse:
        status_code = 429
        headers = {}
        content = b''

    monkeypatch.setenv('STILL_CALENDAR_REFRESH_SECONDS', '600')
    monkeypatch.setattr(calendar_module.httpx, 'get', lambda *_args, **_kwargs: RateLimitedResponse())
    calendar_module.drop_calendar()  # Simulate a fresh process with no in-memory feed.
    for _ in range(2):
        stale = client.get('/api/journal?timezone=America/Los_Angeles').json()
        stale_today = next(day for day in stale['days'] if day['date'] == '2026-09-16')
        assert [event['title'] for event in stale_today['events']] == ['Company offsite', 'Cancelled standup', 'Planning', 'Daily sync']

    monkeypatch.setenv('STILL_CALENDAR_REFRESH_SECONDS', '0')
    monkeypatch.setattr(calendar_module.httpx, 'get', feed_get)
    first_feed['value'] = b'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'
    calendar_module.drop_calendar()
    refreshed = client.get('/api/journal?timezone=America/Los_Angeles').json()
    refreshed_today = next(day for day in refreshed['days'] if day['date'] == '2026-09-16')
    assert [event['title'] for event in refreshed_today['events']] == ['Daily sync']

    assert client.delete(f"/api/calendars/{second.json()['id']}").status_code == 204
    assert client.get('/api/calendars').json() == [accounts[0]]


def test_calendar_subscriptions_reject_private_network_urls(client):
    calendar_module.drop_calendar()
    response = client.post('/api/calendars', json={'url': 'https://127.0.0.1/private.ics'})
    assert response.status_code == 201
    assert response.json()['status'] == 'connecting'
    failed = client.get('/api/calendars').json()[0]
    assert failed['status'] == 'error'
    assert failed['error'] == 'Calendar URLs cannot point to a private network.'


def test_calendar_subscriptions_report_google_rate_limits(client, monkeypatch):
    requests = {'count': 0}

    class RateLimited:
        status_code = 429
        headers = {}
        content = b'rate limited'

    monkeypatch.setattr(calendar_module, '_assert_public_destination', lambda _url: None)
    def rate_limited(*_args, **_kwargs):
        requests['count'] += 1
        return RateLimited()

    monkeypatch.setattr(calendar_module.httpx, 'get', rate_limited)
    response = client.post('/api/calendars', json={'url': 'https://calendar.google.com/calendar/ical/public/basic.ics'})
    assert response.status_code == 201
    assert response.json()['status'] == 'connecting'
    failed = client.get('/api/calendars').json()[0]
    assert failed['status'] == 'error'
    assert failed['error'] == 'Google is temporarily rate-limiting this calendar feed. Try again in a few minutes.'
    assert requests['count'] == 1


def test_calendar_subscriptions_are_limited_to_five(client, monkeypatch):
    monkeypatch.setattr(module, 'load_calendar', lambda _url, force=False: None)
    monkeypatch.setattr(module, 'calendar_name', lambda _calendar, url: url.rsplit('/', 1)[-1])
    responses = [client.post('/api/calendars', json={'url': f'https://calendar.example/public-{index}.ics'}) for index in range(5)]
    assert all(response.status_code == 201 for response in responses)
    sixth = client.post('/api/calendars', json={'url': 'https://calendar.example/public-6.ics'})
    assert sixth.status_code == 409
    assert sixth.json()['detail'] == 'You can connect up to five calendars.'
    assert len(client.get('/api/calendars').json()) == 5
    assert client.delete(f"/api/calendars/{responses[0].json()['id']}").status_code == 204
    assert client.post('/api/calendars', json={'url': 'https://calendar.example/public-6.ics'}).status_code == 201


def test_authentication_flag_defaults_off_and_can_protect_the_api(client, monkeypatch):
    assert client.get('/api/export').status_code == 200
    assert client.delete('/api/test/reset').status_code == 404
    assert client.get('/api/auth/status').json() == {'enabled': False, 'authenticated': True}
    monkeypatch.setenv('STILL_AUTH_ENABLED', 'true')
    monkeypatch.setenv('STILL_AUTH_PASSWORD', 'private-test-password')
    assert client.get('/api/health').status_code == 200
    assert client.get('/api/auth/status').json() == {'enabled': True, 'authenticated': False}
    assert client.get('/api/export').status_code == 401
    assert 'www-authenticate' not in client.get('/api/export').headers
    assert client.post('/api/auth/login', json={'password': 'wrong'}).status_code == 401
    response = client.post('/api/auth/login', json={'password': 'private-test-password'})
    assert response.status_code == 204
    assert response.headers['set-cookie'].startswith('still_session=')
    assert 'HttpOnly' in response.headers['set-cookie']
    assert 'SameSite=strict' in response.headers['set-cookie']
    assert client.get('/api/auth/status').json() == {'enabled': True, 'authenticated': True}
    assert client.get('/api/export').status_code == 200
    assert client.post('/api/auth/logout').status_code == 204
    assert client.get('/api/export').status_code == 401
    assert client.get('/api/export', headers={'Authorization': 'Bearer private-test-password'}).status_code == 200


def test_backup_download_is_a_complete_consistent_sqlite_file(client, tmp_path, monkeypatch):
    note = client.post('/api/notes', json={'date': '2026-09-16', 'content': 'Back me up'}).json()
    client.post('/api/sessions', json={'started_at': '2026-09-16T08:00:00Z', 'duration_seconds': 90})
    response = client.get('/api/backup')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/vnd.sqlite3'
    assert response.headers['cache-control'] == 'no-store'
    assert 'still-logbook-2026-09-16.sqlite3' in response.headers['content-disposition']
    assert response.content.startswith(b'SQLite format 3\0')

    downloaded = tmp_path / 'downloaded.sqlite3'
    downloaded.write_bytes(response.content)
    with sqlite3.connect(downloaded) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert db.execute('PRAGMA user_version').fetchone()[0] == 12
        assert db.execute('SELECT content FROM entries WHERE id = ?', (note['id'],)).fetchone()[0] == 'Back me up'
        assert db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 1

    monkeypatch.setenv('STILL_AUTH_ENABLED', 'true')
    monkeypatch.setenv('STILL_AUTH_PASSWORD', 'private-test-password')
    assert client.get('/api/backup').status_code == 401


def test_task_completion_is_atomic_and_idempotent(client):
    task = client.post("/api/tasks", json={"content": "overdue trainings"}).json()
    for _ in range(2):
        assert client.post(f"/api/tasks/{task['id']}/complete?timezone=Asia/Tokyo").status_code == 200
    data = client.get("/api/journal?timezone=Asia/Tokyo").json()
    assert data["tasks"] == []
    assert [task["content"] for task in data["days"][0]["tasks"]] == ["overdue trainings"]
    assert data["days"][0]["tasks"][0]["completed_at"]
    assert data["days"][0]["date"] == "2026-09-17"
    edited = client.patch(f"/api/tasks/{task['id']}", json={"content": "changed"})
    assert edited.status_code == 200 and edited.json()["content"] == "changed"


def test_concurrent_task_completion_places_one_task_in_the_logbook(client):
    task = client.post("/api/tasks", json={"content": "One thing"}).json()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: client.post(f"/api/tasks/{task['id']}/complete"), range(4)))
    assert all(r.status_code == 200 for r in results)
    day = client.get("/api/journal").json()["days"][0]
    assert len(day["tasks"]) == 1 and day["tasks"][0]["completed_at"]


def test_timer_start_stop_reset_and_stale_retry(client, monkeypatch):
    first = client.post("/api/timer/start").json()
    assert client.post("/api/timer/start").json()["id"] == first["id"]
    monkeypatch.setattr(module, "utcnow", lambda: NOW + timedelta(minutes=25))
    running = client.get("/api/journal").json()
    assert running["days"][0]["focused_seconds"] == 1500
    stopped = client.post("/api/timer/stop", json={"session_id": first["id"]}).json()
    assert stopped["duration_seconds"] == 1500
    second = client.post("/api/timer/start").json()
    assert second["id"] != first["id"] and second["duration_seconds"] == 0
    client.post("/api/timer/stop", json={"session_id": first["id"]})
    assert client.get("/api/timer").json()["active_session"]["id"] == second["id"]
    assert client.get("/api/stats").json()["total_focused_seconds"] == 1500


def test_concurrent_timer_starts_have_one_session(client):
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: client.post("/api/timer/start").json()["id"], range(4)))
    assert len(set(results)) == 1


def test_midnight_allocates_focus_to_both_days(client):
    session = add_session(client, "2026-09-15T23:30:00-07:00", 5400)
    stats = client.get("/api/stats?start=2026-09-15&end=2026-09-16&timezone=America/Los_Angeles").json()
    assert [d["focused_seconds"] for d in stats["daily"]] == [1800, 3600]
    assert [d["longest_session_seconds"] for d in stats["daily"]] == [1800, 3600]
    assert stats["session_count"] == 1
    assert stats["average_daily_focused_seconds"] == 2700
    detail = client.get("/api/sessions?date=2026-09-16&timezone=America/Los_Angeles").json()[0]
    assert detail["id"] == session["id"]
    assert detail["duration_seconds"] == 5400 and detail["seconds_on_day"] == 3600


@pytest.mark.parametrize("start,seconds,day", [
    ("2026-03-08T00:00:00-08:00", 23 * 3600, "2026-03-08"),
    ("2025-11-02T00:00:00-07:00", 25 * 3600, "2025-11-02"),
])
def test_daylight_saving_days_use_real_elapsed_seconds(client, start, seconds, day):
    add_session(client, start, seconds)
    stats = client.get(f"/api/stats?start={day}&end={day}&timezone=America/Los_Angeles").json()
    assert stats["daily"][0]["focused_seconds"] == seconds


def test_stats_include_zero_days_and_daily_longest(client):
    add_session(client, "2026-09-14T08:00:00Z", 3600)
    add_session(client, "2026-09-14T10:00:00Z", 1800)
    add_session(client, "2026-09-15T10:00:00Z", 1800)
    stats = client.get("/api/stats?start=2026-09-14&end=2026-09-16").json()
    assert stats["average_daily_focused_seconds"] == 2400
    assert stats["average_daily_longest_session_seconds"] == 1800
    assert stats["average_active_day_focused_seconds"] == 3600
    assert stats["active_days"] == 2
    assert stats["session_count"] == 3
    assert stats["daily"][-1]["focused_seconds"] == 0
    assert client.get("/api/stats/daily?start=2026-09-14&end=2026-09-16").json()["daily"] == stats["daily"]


def test_session_edit_delete_updates_stats(client):
    session = add_session(client, "2026-09-14T08:00:00Z", 3600)
    edit = client.patch(f"/api/sessions/{session['id']}", json={"started_at": "2026-09-15T08:00:00Z", "duration_seconds": 1800})
    assert edit.status_code == 200
    stats = client.get("/api/stats?start=2026-09-14&end=2026-09-15").json()
    assert [d["focused_seconds"] for d in stats["daily"]] == [0, 1800]
    assert client.delete(f"/api/sessions/{session['id']}").status_code == 204
    assert client.get("/api/stats").json()["total_focused_seconds"] == 0


def test_overlaps_and_future_sessions_are_rejected(client):
    add_session(client, "2026-09-14T08:00:00Z", 3600)
    for start, seconds, status in [
        ("2026-09-14T08:30:00Z", 3600, 409),
        ("2026-09-17T08:00:00Z", 3600, 422),
        ("2026-09-14T08:00:00", 3600, 422),
        ("2026-09-14T08:00:00Z", -1, 422),
    ]:
        assert client.post("/api/sessions", json={"started_at": start, "duration_seconds": seconds}).status_code == status


def test_running_session_cannot_be_edited_or_deleted(client):
    session = client.post("/api/timer/start").json()
    assert client.delete(f"/api/sessions/{session['id']}").status_code == 409
    assert client.patch(f"/api/sessions/{session['id']}", json={"started_at": "2026-09-14T08:00:00Z", "duration_seconds": 10}).status_code == 409


def test_validation_and_pagination(client):
    assert client.get("/api/journal?timezone=bogus").status_code == 422
    assert client.post("/api/tasks", json={"content": "   "}).status_code == 422
    assert client.get("/api/stats?start=2026-09-16&end=2026-09-15").status_code == 422
    assert client.get("/api/stats?start=1900-01-01").status_code == 422
    for day in ("2026-09-10", "2026-09-11", "2026-09-12"):
        client.post("/api/notes", json={"content": day, "date": day})
    first = client.get("/api/journal?limit=2").json()
    assert [d["date"] for d in first["days"]] == ["2026-09-16", "2026-09-12"]
    second = client.get(f"/api/journal?limit=2&before={first['next_cursor']}").json()
    assert [d["date"] for d in second["days"]] == ["2026-09-11", "2026-09-10"]
    assert second["next_cursor"] is None


def test_export_contains_normalized_rows_and_schema_version(client):
    task = client.post("/api/tasks", json={"content": "Read"}).json()
    client.post(f"/api/tasks/{task['id']}/complete")
    data = client.get("/api/export").json()
    assert data["schema_version"] == 8
    assert data["entries"] == data["tasks"]
    assert data["notes"] == []
    assert data["tasks"][0]["completed_at"]


def test_note_creation_retry_does_not_duplicate(client):
    payload = {"date": "2026-09-16", "content": "Keep this thought", "client_id": "test-retry-id"}
    first = client.post("/api/notes", json=payload).json()
    second = client.post("/api/notes", json={**payload, "content": "Keep this updated thought"}).json()
    assert first["id"] == second["id"]
    notes = client.get("/api/journal").json()["days"][0]["notes"]
    assert len(notes) == 1 and notes[0]["content"] == "Keep this updated thought"


@pytest.mark.parametrize("content", [
    "**bold** and *italic*, [docs](https://example.com), `code`, ~~strike~~, ++underline++",
    "Use `` `literal backticks` `` and <JIRA link>",
    "A line  \nwith a hard break  ",
    "```\nconst value = 1;\n```",
    "    indented code\n    stays indented",
    "## Heading",
    "> Quote",
])
def test_markdown_roundtrips_through_sqlite_and_task_completion(client, content):
    from backend.db import connection
    note = client.post("/api/notes", json={"date": "2026-09-16", "content": content}).json()
    task = client.post("/api/tasks", json={"content": content}).json()
    assert note["content"] == task["content"] == content
    for kind, row in [("notes", note), ("tasks", task)]:
        assert client.patch(f"/api/{kind}/{row['id']}", json={"content": content}).json()["content"] == content
        with connection() as db:
            entry_kind = 'note' if kind == 'notes' else 'task'
            assert db.execute("SELECT content FROM entries WHERE kind = ? AND id = ?", (entry_kind, row["id"])).fetchone()["content"] == content
    assert client.post(f"/api/tasks/{task['id']}/complete").status_code == 200
    exported = client.get("/api/export").json()
    assert exported["content_format"] == "markdown"
    completed = next(row for row in exported["tasks"] if row["id"] == task["id"])
    assert completed["content"] == content
    assert completed["completed_at"]
