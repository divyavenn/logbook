"""Persistence boundary for connected calendar feeds."""
from dataclasses import dataclass
from datetime import date
from zoneinfo import ZoneInfo

from .calendars import CalendarEventsByDay, calendar_content, events_by_day, seed_calendar
from .db import connection


@dataclass(frozen=True, slots=True)
class CalendarSource:
    id: int
    url: str
    feed_cache: bytes | None


def _connected_sources() -> list[CalendarSource]:
    with connection() as db:
        return [CalendarSource(row['id'], row['url'], row['feed_cache']) for row in db.execute(
            "SELECT id, url, feed_cache FROM calendar_subscriptions WHERE status = 'connected' ORDER BY id"
        )]


def events_from_subscriptions(start_day: date, end_day: date, zone: ZoneInfo) -> CalendarEventsByDay:
    sources = _connected_sources()
    for source in sources:
        seed_calendar(source.url, source.feed_cache)

    result = events_by_day([source.url for source in sources], start_day, end_day, zone)
    refreshed = [
        (content, source.id)
        for source in sources
        if (content := calendar_content(source.url)) is not None and content != source.feed_cache
    ]
    if refreshed:
        with connection() as db:
            db.executemany('UPDATE calendar_subscriptions SET feed_cache = ? WHERE id = ?', refreshed)
    return result
