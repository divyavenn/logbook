import json
from datetime import timedelta

import pytest

from .test_app import NOW, add_session, client, module  # noqa: F401


def note(client, content, **extra):
    result = client.post('/api/notes', json={'date': '2026-09-16', 'content': content, **extra})
    assert result.status_code == 201, result.text
    return result.json()


def read(client, **query):
    result = client.get('/api/agent/journal', params={'start': '2026-09-16', 'end': '2026-09-16', **query})
    assert result.status_code == 200, result.text
    return result.json()


def test_empty_calendar_is_synthetic_and_does_not_write_days(client):
    before = client.get('/api/export').json()
    response = client.get('/api/agent/journal?timezone=Asia/Tokyo&limit=1')
    data = response.json()
    assert data['days'][0]['date'] == '2026-09-17'
    assert data['days'][0]['bullets'] == []
    assert data['days'][0]['focus']['total_seconds'] == 0
    assert '\n  "schema_version": 1,' in response.text
    assert client.get('/api/export').json() == before


def test_tree_links_original_markdown_and_read_only_snapshot(client):
    content = 'Read [the **design**](https://example.com/a_(b)) and https://example.com/b.\n\n`https://example.com/code`'
    parent = note(client, content, tags=['Work'])
    previous = parent
    for i in range(7):
        previous = note(client, f'Nested {i}', parent_id=previous['id'])
    note(client, '[Reference][r]\n\n[r]: https://example.com/ref')
    before = client.get('/api/export').json()
    response = client.get('/api/agent/journal')
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert '/journal.md' in response.headers['link']
    data = response.json()
    assert data['schema_version'] == 1
    assert data['generated_at'] == '2026-09-16T18:00:00.000Z'
    assert len(data['days']) == 30
    root = data['days'][0]['bullets'][0]
    assert root['id'] == parent['id'] and root['kind'] == 'note'
    assert root['content_markdown'] == content
    assert root['tags'] == ['work']
    assert root['links'] == [
        {'text': 'the design', 'url': 'https://example.com/a_(b)'},
        {'text': 'https://example.com/b', 'url': 'https://example.com/b'},
    ]
    for i in range(7):
        child = root['children'][0]
        assert child['parent_id'] == root['id']
        assert child['content_markdown'] == f'Nested {i}'
        root = child
    assert data['days'][0]['bullets'][1]['links'] == [{'text': 'Reference', 'url': 'https://example.com/ref'}]
    client.get('/journal.md')
    assert client.get('/api/export').json() == before


def test_filters_keep_ancestors_and_descendants_without_unrelated_siblings(client):
    parent = note(client, 'Project')
    hit = note(client, 'Design **review**', parent_id=parent['id'], tags=['Work'])
    descendant = note(client, 'A detail', parent_id=hit['id'])
    note(client, 'Unrelated sibling', parent_id=parent['id'])
    note(client, 'Design review without the tag')
    add_session(client, '2026-09-16T08:00:00Z', 90)
    data = read(client, q='DESIGN REVIEW', tag='#WORK')
    roots = data['days'][0]['bullets']
    assert len(roots) == 1 and roots[0]['id'] == parent['id'] and not roots[0]['matched']
    assert len(roots[0]['children']) == 1
    child = roots[0]['children'][0]
    assert child['id'] == hit['id'] and child['matched']
    assert child['children'][0]['id'] == descendant['id'] and not child['children'][0]['matched']
    assert data['days'][0]['focus']['completed_seconds'] == 90
    assert read(client, q="%' OR 1=1 --")['days'][0]['bullets'] == []


def test_pagination_includes_zero_days_preserves_query_and_omits_repeated_tasks(client):
    task = client.post('/api/tasks', json={'content': 'Work item', 'tags': ['work']}).json()
    result = read(client, start='2026-09-11', limit=2, timezone='America/Los_Angeles', tag='work', q='work')
    assert result['tasks'][0]['id'] == task['id']
    dates = []
    while True:
        dates.extend(day['date'] for day in result['days'])
        assert all(day['focus']['total_seconds'] == 0 for day in result['days'])
        if result['next_url'] is None:
            break
        result = client.get(result['next_url']).json()
        assert result['query']['start'] == '2026-09-11'
        assert result['query']['end'] == '2026-09-16'
        assert result['timezone'] == 'America/Los_Angeles'
        assert result['query']['tag'] == result['query']['q'] == 'work'
        assert result['query']['tasks'] == 'none' and result['tasks'] == []
    assert dates == [f'2026-09-{i}' for i in range(16, 10, -1)]
    assert read(client, before='2026-09-16')['days'] == []


def test_completed_and_running_time_midnight_and_stats_agree(client, monkeypatch):
    saved = add_session(client, '2026-09-15T23:30:00-07:00', 5400)
    monkeypatch.setattr(module, 'utcnow', lambda: NOW - timedelta(seconds=30))
    active = client.post('/api/timer/start').json()
    monkeypatch.setattr(module, 'utcnow', lambda: NOW)
    query = {'start': '2026-09-15', 'end': '2026-09-16', 'timezone': 'America/Los_Angeles'}
    data = read(client, **query)
    current, previous = (day['focus'] for day in data['days'])
    assert current['completed_seconds'] == 3600 and current['running_seconds'] == 30
    assert current['total_seconds'] == 3630 and previous['total_seconds'] == 1800
    assert current['longest_completed_session_seconds'] == 3600
    assert current['completed_session_count'] == 1
    assert [session['id'] for session in current['sessions']] == [saved['id'], active['id']]
    assert current['sessions'][0]['duration_seconds'] == 5400
    assert current['sessions'][0]['seconds_on_day'] == 3600
    assert current['sessions'][0]['local_started_at'] == '2026-09-15T23:30:00-07:00'
    assert current['sessions'][1]['status'] == 'running' and current['sessions'][1]['ended_at'] is None
    assert current['sessions'][1]['segment_ended_at'] == data['generated_at']
    stats = client.get('/api/stats/daily', params=query).json()['daily']
    assert [previous['completed_seconds'], current['completed_seconds']] == [day['focused_seconds'] for day in stats]


@pytest.mark.parametrize('start,seconds,day', [
    ('2026-03-08T00:00:00-08:00', 23 * 3600, '2026-03-08'),
    ('2025-11-02T00:00:00-07:00', 25 * 3600, '2025-11-02'),
])
def test_agent_allocation_respects_dst(client, start, seconds, day):
    add_session(client, start, seconds)
    data = read(client, start=day, end=day, timezone='America/Los_Angeles')['days'][0]
    assert data['focus']['completed_seconds'] == seconds
    assert data['focus']['sessions'][0]['seconds_on_day'] == seconds


def test_visible_and_archived_tasks_are_grouped_in_the_logbook_when_finished(client):
    parent = client.post('/api/tasks', json={'content': 'Parent'}).json()
    first = client.post('/api/tasks', json={'content': 'First', 'parent_id': parent['id']}).json()
    second = client.post('/api/tasks', json={'content': 'Second', 'parent_id': parent['id']}).json()
    client.post(f"/api/tasks/{first['id']}/complete")
    tasks = read(client, start='2026-09-01', end='2026-09-01')['tasks']
    assert tasks[0]['children'][0]['completed_at'] is not None
    assert tasks[0]['children'][1]['completed_at'] is None
    client.post(f"/api/tasks/{second['id']}/complete")
    assert read(client)['tasks'] == []
    archived = read(client, tasks='all')
    assert archived['tasks'][0]['completed_at'] is not None
    assert len(archived['tasks'][0]['children']) == 2
    logbook_task = archived['days'][0]['bullets'][0]
    assert logbook_task['kind'] == 'task' and logbook_task['id'] == parent['id']
    assert {row['id'] for row in logbook_task['children']} == {first['id'], second['id']}


@pytest.mark.parametrize('query', [
    {'limit': 0}, {'limit': 101}, {'timezone': 'bogus'}, {'tag': 'not valid'}, {'q': 'x' * 201},
    {'tasks': 'invalid'}, {'start': '2026-09-17', 'end': '2026-09-16'}, {'start': '1900-01-01'},
    {'before': '0001-01-01'}, {'end': '0001-01-01'},
])
def test_agent_rejects_invalid_queries(client, query):
    assert client.get('/api/agent/journal', params=query).status_code == 422


def test_markdown_discovery_schema_and_content_negotiation(client):
    parent = note(client, '[Résumé](https://example.com/a\\(b\\))', tags=['work'])
    note(client, 'Second\n\n```\nx = 1\n```', parent_id=parent['id'])
    query = {'start': '2026-09-15', 'end': '2026-09-16', 'limit': 1}
    markdown = client.get('/journal.md', params=query)
    assert markdown.status_code == 200
    assert markdown.headers['content-type'].startswith('text/markdown')
    assert markdown.headers['cache-control'] == 'no-store'
    assert '\n## 2026-09-16\n' in markdown.text
    assert '- [Résumé](https://example.com/a\\(b\\))' in markdown.text
    assert '\n    - Second' in markdown.text
    assert '"tags": ["work"]' in markdown.text and '#work' not in markdown.text
    metadata = json.loads(markdown.text.split('```json\n', 1)[1].split('\n```', 1)[0])
    assert metadata['next_url'].startswith('/journal.md?')
    assert client.get(metadata['next_url']).status_code == 200
    guide = client.get('/llms.txt')
    assert all(path in guide.text for path in ['/api/agent/journal', '/journal.md', '/api/stats/daily', '/openapi.json'])
    schema = client.get('/openapi.json').json()
    assert set(schema['paths']['/journal.md']['get']['responses']['200']['content']) == {'text/markdown'}
    assert schema['paths']['/api/agent/journal']['get']['responses']['200']['content']['application/json']['schema']['$ref'].endswith('/AgentJournal')
    assert 'children' in schema['components']['schemas']['AgentEntry']['properties']
    as_json = client.get('/', params=query, headers={'Accept': 'application/json'})
    assert as_json.json() == client.get('/api/agent/journal', params=query).json()
    as_markdown = client.get('/', params=query, headers={'Accept': 'text/markdown'})
    assert as_markdown.text == markdown.text and as_markdown.headers['vary'] == 'Accept'
    assert client.get('/', headers={'Accept': 'text/markdown;q=0, text/html'}).headers['content-type'].startswith('text/html')
    assert client.get('/', headers={'Accept': 'application/json;q=0.5, text/html;q=0.9'}).headers['content-type'].startswith('text/html')
