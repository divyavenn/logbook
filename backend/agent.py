"""Read-only representations for agents, independent of the browser's loaded pages."""
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Literal
from urllib.parse import urlencode

from markdown_it import MarkdownIt
from pydantic import BaseModel, Field

from .stats import parse, slices, stamp
from .tags import entry_dict
from .tasks import visible_tasks


DISCOVERY_LINKS = ', '.join([
    '</llms.txt>; rel="describedby"; type="text/plain"',
    '</journal.md>; rel="alternate"; type="text/markdown"',
    '</api/agent/journal>; rel="alternate"; type="application/json"',
    '</openapi.json>; rel="service-desc"; type="application/json"',
])
READ_HEADERS = {"Cache-Control": "no-store", "Link": DISCOVERY_LINKS}
MARKDOWN = MarkdownIt('commonmark', {'html': False, 'linkify': True}).enable(['linkify', 'strikethrough'])


class AgentQuery(BaseModel):
    start: date | None = Field(None, description="Inclusive first calendar date; defaults to 29 days before end.")
    end: date | None = Field(None, description="Inclusive last calendar date; defaults to today in timezone.")
    timezone: str = Field('UTC', description="IANA timezone for sessions and day boundaries. Notes retain their recorded date.")
    before: date | None = Field(None, description="Exclusive date cursor. Follow next_url to retain the original query.")
    limit: int = Field(30, ge=1, le=100, description="Calendar days per page, newest first, including zero days.")
    tag: str | None = Field(None, max_length=65, description="Match a tag; includes matching entries, descendants, and ancestor context.")
    q: str | None = Field(None, max_length=200, description="Case-insensitive literal substring in Markdown, rendered text, or link URLs. Combined with tag using AND.")
    tasks: Literal['visible', 'all', 'none'] = Field('visible', description="Current task snapshot, all tasks including archived completions, or none. Tasks are not date-filtered and are omitted by next_url.")


class AgentLink(BaseModel):
    text: str
    url: str


class AgentEntry(BaseModel):
    id: int = Field(description="Stable entry ID, including when its kind changes.")
    kind: Literal['note', 'task']
    parent_id: int | None
    position: int
    content_markdown: str = Field(description="Original stored Markdown, without tag metadata.")
    tags: list[str]
    links: list[AgentLink]
    matched: bool = Field(description="True for a direct filter match; false for included ancestor or descendant context.")
    created_at: str
    updated_at: str | None
    completed_at: str | None
    source_task_id: int | None
    children: list['AgentEntry']


class AgentSession(BaseModel):
    id: int
    status: Literal['completed', 'running']
    started_at: str = Field(description="Original session start in UTC.")
    ended_at: str | None = Field(description="Original session end in UTC, null while running.")
    local_started_at: str = Field(description="Original start with the requested timezone's UTC offset.")
    duration_seconds: float = Field(description="Whole session elapsed duration as of generated_at; do not sum across days.")
    segment_started_at: str
    segment_ended_at: str = Field(description="End of this day's portion in UTC; running sessions are capped at generated_at.")
    seconds_on_day: float = Field(description="Seconds allocated to this date, suitable for daily sums.")


class AgentFocus(BaseModel):
    completed_seconds: float
    running_seconds: float
    total_seconds: float
    longest_completed_session_seconds: float
    completed_session_count: int
    sessions: list[AgentSession]


class AgentDay(BaseModel):
    date: date
    focus: AgentFocus = Field(description="Unfiltered totals for this calendar day, even when q/tag filters entries.")
    bullets: list[AgentEntry]


class AgentJournal(BaseModel):
    schema_version: Literal[1] = 1
    generated_at: str
    timezone: str
    query: AgentQuery
    days: list[AgentDay]
    tasks: list[AgentEntry]
    next_cursor: date | None
    next_url: str | None = Field(description="Next JSON page, or null when complete. Tasks are returned only on the initial request.")


def parsed_content(content):
    """Use a real Markdown parser for escaped, reference, nested, and bare links."""
    text, links = [], []
    for block in MARKDOWN.parse(content):
        if block.type in ('fence', 'code_block'):
            text.append(block.content)
        elif block.type == 'inline':
            label, url = [], None
            for token in block.children or []:
                if token.type == 'link_open':
                    label, url = [], token.attrGet('href')
                elif token.type == 'link_close':
                    links.append({'text': ''.join(label), 'url': url})
                    url = None
                elif token.type in ('text', 'code_inline', 'softbreak', 'hardbreak'):
                    value = '\n' if token.type.endswith('break') else token.content
                    text.append(value)
                    if url is not None:
                        label.append(value)
            text.append('\n')
    return ''.join(text), links


def entry_tree(rows, kind, tag, query):
    children = defaultdict(list)
    by_id = {row['id']: row for row in rows}
    parsed = {row['id']: parsed_content(row['content']) for row in rows}
    matched = set()
    for row in rows:
        children[row['parent_id']].append(row)
        text, links = parsed[row['id']]
        searchable = '\n'.join([row['content'], text, *(link['url'] for link in links)]).casefold()
        if (not tag or tag in row['tags']) and (not query or query.casefold() in searchable):
            matched.add(row['id'])
    included = set(matched)
    stack = list(matched)
    while stack:
        for child in children[stack.pop()]:
            if child['id'] not in included:
                included.add(child['id'])
                stack.append(child['id'])
    for item_id in matched:
        parent = by_id[item_id]['parent_id']
        while parent in by_id:
            included.add(parent)
            parent = by_id[parent]['parent_id']

    def node(row):
        return {
            'id': row['id'], 'kind': kind, 'parent_id': row['parent_id'], 'position': row['position'],
            'content_markdown': row['content'], 'tags': row['tags'], 'links': parsed[row['id']][1],
            'matched': row['id'] in matched, 'created_at': row['created_at'],
            'updated_at': row.get('updated_at'), 'completed_at': row.get('completed_at'),
            'source_task_id': row.get('source_task_id'),
            'children': [node(child) for child in children[row['id']] if child['id'] in included],
        }

    return [node(row) for row in rows if row['id'] in included and row['parent_id'] not in by_id]


def read_journal(db, query, zone, now):
    """Query one calendar page within a single SQLite read snapshot; never mutate it."""
    start, end = query.start, query.end
    upper = min(end, query.before - timedelta(days=1)) if query.before else end
    count = max(0, min(query.limit, (upper - start).days + 1))
    selected = [(upper - timedelta(days=i)).isoformat() for i in range(count)]
    notes_by_day, tasks_by_day, by_session_day = defaultdict(list), defaultdict(list), defaultdict(list)
    if selected:
        for row in db.execute('''SELECT entries.*, days.date FROM entries JOIN days ON entries.day_id = days.id
                                WHERE days.date BETWEEN ? AND ? ORDER BY entries.position, entries.id''', (selected[-1], selected[0])):
            (notes_by_day if row['kind'] == 'note' else tasks_by_day)[row['date']].append(entry_dict(row))
        lower_utc = stamp(datetime.combine(date.fromisoformat(selected[-1]), time.min, zone))
        upper_utc = stamp(datetime.combine(upper + timedelta(days=1), time.min, zone))
        sessions = db.execute('''SELECT * FROM sessions WHERE started_at < ?
                                 AND COALESCE(ended_at, ?) >= ? ORDER BY started_at, id''', (upper_utc, stamp(now), lower_utc))
        for session in sessions:
            begin = parse(session['started_at'])
            finish = parse(session['ended_at']) if session['ended_at'] else now
            for day, seconds, segment_start, segment_end in slices(session, zone, now):
                if selected[-1] <= day <= selected[0]:
                    by_session_day[day].append({
                        'id': session['id'], 'status': 'completed' if session['ended_at'] else 'running',
                        'started_at': session['started_at'], 'ended_at': session['ended_at'],
                        'local_started_at': begin.astimezone(zone).isoformat(),
                        'duration_seconds': max(0, (finish - begin).total_seconds()),
                        'segment_started_at': segment_start, 'segment_ended_at': segment_end, 'seconds_on_day': seconds,
                    })
    days = []
    for day in selected:
        sessions = by_session_day[day]
        completed = [row['seconds_on_day'] for row in sessions if row['status'] == 'completed']
        running = sum(row['seconds_on_day'] for row in sessions if row['status'] == 'running')
        entries = [
            *entry_tree(notes_by_day[day], 'note', query.tag, query.q),
            *entry_tree(tasks_by_day[day], 'task', query.tag, query.q),
        ]
        entries.sort(key=lambda row: (row['position'], row['id']))
        days.append({'date': day, 'bullets': entries, 'focus': {
            'completed_seconds': sum(completed), 'running_seconds': running, 'total_seconds': sum(completed) + running,
            'longest_completed_session_seconds': max(completed, default=0), 'completed_session_count': len(completed), 'sessions': sessions,
        }})
    tasks = []
    if query.tasks == 'all':
        tasks = [entry_dict(row) for row in db.execute("SELECT * FROM entries WHERE kind = 'task' ORDER BY day_id, position, id")]
    elif query.tasks == 'visible':
        tasks = visible_tasks(db)
    cursor = selected[-1] if selected and selected[-1] > start.isoformat() else None
    next_query = {**query.model_dump(mode='json', exclude_none=True), 'before': cursor, 'tasks': 'none'}
    return AgentJournal(
        generated_at=stamp(now), timezone=zone.key, query=query, days=days,
        tasks=entry_tree(tasks, 'task', query.tag, query.q), next_cursor=cursor,
        next_url='/api/agent/journal?' + urlencode(next_query) if cursor else None,
    )


def markdown_journal(journal: AgentJournal) -> str:
    import json

    lines = ['# Logbook', '', '```json', json.dumps({
        'schema_version': journal.schema_version, 'generated_at': journal.generated_at, 'timezone': journal.timezone,
        'query': journal.query.model_dump(mode='json'),
        'next_url': journal.next_url.replace('/api/agent/journal?', '/journal.md?') if journal.next_url else None,
    }, indent=2, ensure_ascii=False), '```', '']

    def append_entries(rows: list[AgentEntry], depth: int = 0) -> None:
        # The same bullet the clipboard writes: two spaces a level, a native
        # checkbox for a task, and the tags inline in the text they sit in.
        for row in rows:
            indent = '  ' * depth
            marker = ('- [x] ' if row.completed_at else '- [ ] ') if row.kind == 'task' else '- '
            content = row.content_markdown.splitlines() or ['']
            # A tag the text does not already carry is named at the end of the
            # bullet, so no tag is lost with the metadata line.
            lowered = row.content_markdown.lower()
            inline = [f'#{tag}' for tag in row.tags if f'#{tag}'.lower() not in lowered]
            lines.append(' '.join([f'{indent}{marker}{content[0]}', *inline]).rstrip())
            lines.extend(f'{indent}  {line}' for line in content[1:])
            append_entries(row.children, depth + 1)

    if journal.query.tasks != 'none' and journal.tasks:
        lines.extend(['## to do', ''])
        append_entries(journal.tasks)
        lines.append('')
    for day in journal.days:
        focus = day.focus
        # A day with nothing written and nothing focused is not worth a heading.
        if not day.bullets and not focus.sessions and not focus.total_seconds:
            continue
        lines.extend([f'## {day.date}', ''])
        if focus.total_seconds or focus.sessions:
            lines.extend([
                f'Focus: {focus.total_seconds:g} seconds total; {focus.completed_seconds:g} completed; {focus.running_seconds:g} running.',
                f'Longest completed session on this date: {focus.longest_completed_session_seconds:g} seconds.', '',
            ])
        if focus.sessions:
            lines.extend(['| Session ID | Status | Start (UTC) | Seconds on this date | Whole session seconds |',
                          '| --- | --- | --- | ---: | ---: |'])
            for session in focus.sessions:
                lines.append(f'| {session.id} | {session.status} | {session.started_at} | {session.seconds_on_day:g} | {session.duration_seconds:g} |')
            lines.append('')
        append_entries(day.bullets)
        lines.append('')
    return '\n'.join(lines)
