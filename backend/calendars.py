"""Read-only ICS subscriptions and occurrence expansion."""
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from hashlib import sha256
from html import unescape
from ipaddress import ip_address
import os
import re
import socket
from threading import Lock
from time import monotonic
from typing import TypedDict
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import httpx
from icalendar import Calendar, Event
import recurring_ical_events


MAX_FEED_BYTES = 5_000_000
REDIRECTS = {301, 302, 303, 307, 308}
URL_PATTERN = re.compile(r'https?://[^\s<>"\']+', re.IGNORECASE)


class CalendarLoadError(ValueError):
    pass


class CalendarEvent(TypedDict):
    id: str
    title: str
    start: str
    end: str
    all_day: bool
    cancelled: bool
    location: str | None
    description: str | None
    links: list[str]


CalendarEventsByDay = dict[str, list[CalendarEvent]]


@dataclass(frozen=True, slots=True)
class CachedCalendar:
    calendar: Calendar
    loaded_at: float
    content: bytes


@dataclass(frozen=True, slots=True)
class CachedFailure:
    message: str
    failed_at: float


_cache: dict[str, CachedCalendar] = {}
_failures: dict[str, CachedFailure] = {}
_cache_lock = Lock()


def normalize_calendar_url(value: str) -> str:
    value = value.strip()
    if value.lower().startswith('webcal://'):
        value = 'https://' + value[9:]
    parsed = urlparse(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Use a public or private HTTPS/webcal calendar subscription URL.')
    if len(value) > 2048:
        raise ValueError('Calendar URLs must be 2,048 characters or fewer.')
    return value


def calendar_host(value: str) -> str:
    return urlparse(value).hostname or 'calendar'


def calendar_name(calendar: Calendar, value: str) -> str:
    """Return a feed's published name, falling back to its host."""
    name = str(calendar.get('X-WR-CALNAME') or calendar.get('NAME') or '').strip()
    return name[:200] or calendar_host(value)


def _assert_public_destination(value: str) -> None:
    parsed = urlparse(value)
    host = parsed.hostname or ''
    if host.casefold() == 'localhost' or host.endswith('.local'):
        raise CalendarLoadError('Calendar URLs cannot point to a private network.')
    try:
        addresses = [ip_address(host)]
    except ValueError:
        try:
            addresses = {ip_address(item[4][0]) for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        except (OSError, ValueError) as error:
            raise CalendarLoadError('Could not resolve that calendar URL.') from error
    if not addresses or any(not address.is_global for address in addresses):
        raise CalendarLoadError('Calendar URLs cannot point to a private network.')


def _download(value: str) -> bytes:
    current = normalize_calendar_url(value)
    for _ in range(6):
        _assert_public_destination(current)
        try:
            response = httpx.get(current, timeout=8, follow_redirects=False, headers={'Accept': 'text/calendar, text/plain;q=0.9'})
        except httpx.HTTPError as error:
            raise CalendarLoadError('Could not connect to that calendar URL.') from error
        if response.status_code == 429:
            provider = 'Google' if (urlparse(current).hostname or '').endswith('google.com') else 'The calendar provider'
            raise CalendarLoadError(f'{provider} is temporarily rate-limiting this calendar feed. Try again in a few minutes.')
        if response.status_code == 404 and (urlparse(current).hostname or '').endswith('google.com'):
            raise CalendarLoadError('Google could not find a public calendar at that address. Confirm that the calendar is available to the public.')
        if response.status_code in REDIRECTS:
            location = response.headers.get('location')
            if not location:
                raise CalendarLoadError('The calendar URL returned an invalid redirect.')
            current = normalize_calendar_url(urljoin(current, location))
            continue
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            raise CalendarLoadError('The calendar URL could not be loaded.') from error
        if len(response.content) > MAX_FEED_BYTES:
            raise CalendarLoadError('That calendar feed is too large.')
        return response.content
    raise CalendarLoadError('The calendar URL redirected too many times.')


def _ttl() -> int:
    try:
        return max(0, min(3600, int(os.environ.get('STILL_CALENDAR_REFRESH_SECONDS', '600'))))
    except ValueError:
        return 600


def load_calendar(value: str, *, force: bool = False) -> Calendar:
    value = normalize_calendar_url(value)
    with _cache_lock:
        cached = _cache.get(value)
        if cached and not force and monotonic() - cached.loaded_at < _ttl():
            return cached.calendar
        failed = _failures.get(value)
        if not force and failed and monotonic() - failed.failed_at < _ttl():
            if cached:
                return cached.calendar
            raise CalendarLoadError(failed.message)
    try:
        content = _download(value)
        calendar = Calendar.from_ical(content)
    except CalendarLoadError as error:
        with _cache_lock:
            _failures[value] = CachedFailure(str(error), monotonic())
        if cached:
            return cached.calendar
        raise
    except (ValueError, TypeError) as error:
        if cached:
            return cached.calendar
        raise CalendarLoadError('That URL did not return a valid ICS calendar.') from error
    with _cache_lock:
        _cache[value] = CachedCalendar(calendar, monotonic(), content)
        _failures.pop(value, None)
    return calendar


def seed_calendar(value: str, content: bytes | None) -> bool:
    """Restore a persisted last-good feed without treating it as freshly downloaded."""
    if not content:
        return False
    value = normalize_calendar_url(value)
    with _cache_lock:
        if value in _cache:
            return True
    try:
        calendar = Calendar.from_ical(content)
    except (ValueError, TypeError):
        return False
    with _cache_lock:
        _cache.setdefault(value, CachedCalendar(calendar, monotonic() - _ttl(), content))
    return True


def calendar_content(value: str) -> bytes | None:
    value = normalize_calendar_url(value)
    with _cache_lock:
        cached = _cache.get(value)
        return cached.content if cached else None


def drop_calendar(value: str | None = None) -> None:
    with _cache_lock:
        if value is None:
            _cache.clear()
            _failures.clear()
        else:
            _cache.pop(value, None)
            _failures.pop(value, None)


def _property_text(component: Event, name: str) -> list[str]:
    value = component.get(name)
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    return [item.decode(errors='replace') if isinstance(item, bytes) else str(item) for item in values]


def _event_links(component: Event) -> list[str]:
    values: list[str] = []
    for name in ('URL', 'CONFERENCE', 'X-GOOGLE-CONFERENCE', 'X-GOOGLE-HANGOUT',
                 'X-MICROSOFT-SKYPETEAMSMEETINGURL', 'ATTACH', 'LOCATION', 'DESCRIPTION'):
        values.extend(_property_text(component, name))
    links: list[str] = []
    for raw in values:
        for match in URL_PATTERN.findall(unescape(raw)):
            candidate = match.rstrip('.,;:!?)]}')
            try:
                candidate = normalize_calendar_url(candidate)
            except ValueError:
                continue
            if candidate not in links:
                links.append(candidate)
    return links


def _event_text(component: Event, name: str, limit: int) -> str | None:
    values = _property_text(component, name)
    text = unescape(values[0]).strip() if values else ''
    return text[:limit] or None


def _local_datetime(value: date | datetime, zone: ZoneInfo) -> tuple[datetime, bool]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=zone)
        return value.astimezone(zone), False
    return datetime.combine(value, time.min, tzinfo=zone), True


def _calendar_event(component: Event, feed_index: int, calendar_cancelled: bool, zone: ZoneInfo) -> tuple[str, CalendarEvent]:
    start_value = component.decoded('DTSTART')
    local_start, all_day = _local_datetime(start_value, zone)
    if component.get('DTEND') is not None:
        local_end, _ = _local_datetime(component.decoded('DTEND'), zone)
    else:
        fallback = timedelta(days=1) if all_day else timedelta(0)
        duration = component.decoded('DURATION') if component.get('DURATION') is not None else fallback
        local_end = local_start + duration
    day = local_start.date().isoformat()
    uid = str(component.get('UID', 'event'))
    links = _event_links(component)
    return day, {
        'id': sha256(f'{feed_index}|{uid}|{local_start.isoformat()}'.encode()).hexdigest()[:20],
        'title': str(component.get('SUMMARY') or 'Untitled event'),
        'start': local_start.date().isoformat() if all_day else local_start.isoformat(),
        'end': local_end.date().isoformat() if all_day else local_end.isoformat(),
        'all_day': all_day,
        'cancelled': calendar_cancelled or str(component.get('STATUS', '')).upper() == 'CANCELLED',
        'location': _event_text(component, 'LOCATION', 1000),
        'description': _event_text(component, 'DESCRIPTION', 10000),
        'links': links,
    }


def events_by_day(urls: list[str], start_day: date, end_day: date, zone: ZoneInfo) -> CalendarEventsByDay:
    """Expand configured feeds for the half-open local date range."""
    if not urls or start_day >= end_day:
        return {}
    start = datetime.combine(start_day, time.min, tzinfo=zone)
    end = datetime.combine(end_day, time.min, tzinfo=zone)
    result: CalendarEventsByDay = {}
    for feed_index, url in enumerate(urls):
        try:
            calendar = load_calendar(url)
            occurrences = recurring_ical_events.of(calendar, skip_bad_series=True).between(start, end)
        except (CalendarLoadError, ValueError, TypeError):
            continue
        calendar_cancelled = str(calendar.get('METHOD', '')).upper() == 'CANCEL'
        for component in occurrences:
            try:
                day, event = _calendar_event(component, feed_index, calendar_cancelled, zone)
                result.setdefault(day, []).append(event)
            except (KeyError, TypeError, ValueError, AttributeError):
                continue
    for events in result.values():
        events.sort(key=lambda event: (event['start'], event['title'].casefold(), event['id']))
    return result
