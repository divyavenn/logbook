from .test_app import client  # noqa: F401
from .test_hierarchy import create


def test_invalid_timezone_is_rejected_before_opening_a_write_transaction(client, monkeypatch):
    import backend.documents as documents

    def unexpected_connection():
        raise AssertionError('Invalid input must be rejected before opening storage')

    monkeypatch.setattr(documents, 'connection', unexpected_connection)
    response = client.post('/api/document/edit?timezone=not-a-zone', json={
        'changes': [{'kind': 'tasks', 'content': 'Task'}],
    })
    assert response.status_code == 422


def test_batch_and_individual_entry_inputs_share_limits(client):
    for fields in [{'client_id': 'x' * 81}, {'parent_id': -1}, {'tags': ['tag'] * 51}]:
        direct = client.post('/api/tasks', json={'content': 'Task', **fields})
        grouped = client.post('/api/document/edit', json={'changes': [{'kind': 'tasks', 'content': 'Task', **fields}]})
        assert direct.status_code == grouped.status_code == 422
    assert client.post('/api/document/edit', json={'changes': [{'kind': 'tasks', 'id': 1, 'move': True, 'delete': True}]}).status_code == 422


def test_entry_response_schemas_are_published(client):
    paths = client.get('/openapi.json').json()['paths']
    for path in ['/api/journal', '/api/search', '/api/tasks/{task_id}/complete', '/api/document/edit']:
        method = 'get' if path in ['/api/journal', '/api/search'] else 'post'
        schema = paths[path][method]['responses']['200']['content']['application/json']['schema']
        assert '$ref' in schema


def batch(client, changes):
    response = client.post('/api/document/edit', json={'changes': changes})
    assert response.status_code == 200, response.text
    return response.json()


def history(client, operation, redo=False):
    response = client.post('/api/document/history', json={'operations': [operation], 'redo': redo})
    assert response.status_code == 200, response.text


def test_explicit_empty_row_preserves_parent_identity_and_can_be_undone(client):
    parent = create(client, 'notes', 'Parent')
    child = create(client, 'notes', 'Child', parent['id'])
    result = batch(client, [{'kind': 'notes', 'content': '', 'tags': [], 'allow_empty': True,
                             'date': '2026-09-16', 'before_id': parent['id'], 'client_id': 'empty-before-parent'}])
    rows = sorted(client.get('/api/export').json()['notes'], key=lambda row: row['position'])
    roots = [row for row in rows if row['parent_id'] is None]
    assert [row['content'] for row in roots] == ['', 'Parent']
    assert next(row for row in rows if row['id'] == child['id'])['parent_id'] == parent['id']
    history(client, result['operation_id'])
    assert len(client.get('/api/export').json()['notes']) == 2
    history(client, result['operation_id'], redo=True)
    assert len(client.get('/api/export').json()['notes']) == 3


def test_completion_responses_support_immediate_reversal_with_current_revisions(client):
    parent = create(client, 'tasks', 'Parent')
    child = create(client, 'tasks', 'Child', parent['id'])
    finished = client.post(f"/api/tasks/{child['id']}/complete?expected_revision={child['revision']}").json()
    current = next(row for row in finished['items'] if row['id'] == child['id'])
    reopened = client.post(f"/api/tasks/{child['id']}/reopen", json={
        'completed_at': current['completed_at'], 'expected_revision': current['revision'], 'record_history': True,
    })
    assert reopened.status_code == 200
    assert {row['id'] for row in reopened.json()['items']} == {parent['id'], child['id']}
    assert all(row['completed_at'] is None for row in reopened.json()['items'])


def test_finishing_a_tree_returns_the_updated_revision_of_earlier_completed_siblings(client):
    parent = create(client, 'tasks', 'Parent')
    first = create(client, 'tasks', 'First', parent['id'])
    last = create(client, 'tasks', 'Last', parent['id'])
    client.post(f"/api/tasks/{first['id']}/complete")
    finished = client.post(f"/api/tasks/{last['id']}/complete").json()
    current = next(row for row in finished['items'] if row['id'] == first['id'])
    reopened = client.post(f"/api/tasks/{first['id']}/reopen", json={
        'completed_at': current['completed_at'], 'expected_revision': current['revision'],
    })
    assert reopened.status_code == 200
    current_last = next(row for row in reopened.json()['items'] if row['id'] == last['id'])
    assert client.post(f"/api/tasks/{last['id']}/reopen", json={
        'completed_at': current_last['completed_at'], 'expected_revision': current_last['revision'],
    }).status_code == 200


def test_an_empty_note_can_precede_a_completed_task_in_the_logbook(client):
    task = create(client, 'tasks', 'Done')
    client.post(f"/api/tasks/{task['id']}/complete")
    today = client.get('/api/journal').json()['today']
    result = batch(client, [{'kind': 'notes', 'content': '', 'allow_empty': True, 'date': today, 'before_id': task['id']}])
    assert result['items'][0]['position'] == 0
    assert client.get('/api/export').json()['tasks'][0]['content'] == 'Done'


def test_document_can_insert_and_move_before_the_first_sibling(client):
    first = create(client, 'notes', 'First')
    last = create(client, 'notes', 'Last')
    inserted = batch(client, [{'kind': 'notes', 'content': 'Inserted', 'date': '2026-09-16', 'before_id': first['id']}])['items'][0]
    moved = batch(client, [{'kind': 'notes', 'id': last['id'], 'move': True, 'before_id': inserted['id']}])
    rows = sorted(client.get('/api/export').json()['notes'], key=lambda row: row['position'])
    assert [row['content'] for row in rows] == ['Last', 'Inserted', 'First']
    history(client, moved['operation_id'])
    rows = sorted(client.get('/api/export').json()['notes'], key=lambda row: row['position'])
    assert [row['content'] for row in rows] == ['Inserted', 'First', 'Last']


def test_completed_children_stay_until_immediate_parent_finishes(client):
    root = create(client, 'tasks', 'Project')
    parent = create(client, 'tasks', 'Phase', root['id'])
    later = create(client, 'tasks', 'Later', root['id'])
    first = create(client, 'tasks', 'One', parent['id'])
    second = create(client, 'tasks', 'Two', parent['id'])
    assert client.post(f"/api/tasks/{parent['id']}/complete").status_code == 409
    client.post(f"/api/tasks/{first['id']}/complete")
    rows = {row['id']: row for row in client.get('/api/journal').json()['tasks']}
    assert rows[first['id']]['completed_at']
    assert rows[parent['id']]['child_count'] == 2
    assert rows[parent['id']]['completed_child_count'] == 1
    final = client.post(f"/api/tasks/{second['id']}/complete").json()
    assert final['task_ids'] == [second['id'], parent['id']]
    rows = {row['id']: row for row in client.get('/api/journal').json()['tasks']}
    assert set(rows) == {root['id'], parent['id'], later['id']}
    assert rows[parent['id']]['completed_at']
    assert rows[root['id']]['completed_child_count'] == 1
    assert client.get('/api/export').json()['notes'] == []
    client.post(f"/api/tasks/{later['id']}/complete")
    assert client.get('/api/journal').json()['tasks'] == []
    day = client.get('/api/journal').json()['days'][0]
    assert {row['id'] for row in day['tasks']} == {root['id'], parent['id'], later['id'], first['id'], second['id']}


def test_undo_final_child_reopens_ancestors_and_retains_earlier_children(client):
    parent = create(client, 'tasks', 'Parent')
    first = create(client, 'tasks', 'First', parent['id'])
    last = create(client, 'tasks', 'Last', parent['id'])
    client.post(f"/api/tasks/{first['id']}/complete")
    result = client.post(f"/api/tasks/{last['id']}/complete").json()
    assert client.post(f"/api/tasks/{last['id']}/reopen", json={'completed_at': result['completed_at']}).status_code == 200
    rows = {row['id']: row for row in client.get('/api/journal').json()['tasks']}
    assert len(rows) == 3 and rows[first['id']]['completed_at']
    assert rows[last['id']]['completed_at'] is None and rows[parent['id']]['completed_at'] is None
    assert client.get('/api/export').json()['notes'] == []
    client.post(f"/api/tasks/{last['id']}/complete")
    assert client.get('/api/export').json()['notes'] == []


def test_reopen_keeps_the_task_as_the_same_logbook_entry(client):
    task = create(client, 'tasks', 'Read')
    client.post(f"/api/tasks/{task['id']}/complete")
    client.post(f"/api/tasks/{task['id']}/reopen", json={})
    row = client.get('/api/export').json()['tasks'][0]
    assert row['id'] == task['id'] and row['content'] == 'Read' and row['completed_at'] is None


def test_document_create_edit_undo_redo_keeps_ids_and_markdown(client):
    added = batch(client, [{'kind': 'notes', 'date': '2026-09-16', 'content': '**first**', 'tags': ['work'], 'client_id': 'retry'}])
    note = added['items'][0]
    retry = batch(client, [{'kind': 'notes', 'date': '2026-09-16', 'content': '**first**', 'tags': ['work'], 'client_id': 'retry'}])
    assert retry['operation_id'] is None and retry['items'][0]['id'] == note['id']
    edited = batch(client, [{'kind': 'notes', 'id': note['id'], 'content': '*second*'}])
    history(client, edited['operation_id'])
    assert client.get('/api/export').json()['notes'][0]['content'] == '**first**'
    history(client, added['operation_id'])
    assert client.get('/api/export').json()['notes'] == []
    history(client, added['operation_id'], True)
    history(client, edited['operation_id'], True)
    restored = client.get('/api/export').json()['notes'][0]
    assert restored['id'] == note['id'] and restored['content'] == '*second*' and restored['tags'] == ['work']


def test_batch_delete_undo_restores_parent_child_order(client):
    parent = create(client, 'notes', 'Parent')
    child = create(client, 'notes', 'Child', parent['id'])
    result = batch(client, [{'kind': 'notes', 'id': parent['id'], 'delete': True}, {'kind': 'notes', 'id': child['id'], 'delete': True}])
    assert client.get('/api/export').json()['notes'] == []
    history(client, result['operation_id'])
    notes = client.get('/api/export').json()['notes']
    assert next(row for row in notes if row['id'] == child['id'])['parent_id'] == parent['id']
    history(client, result['operation_id'], True)
    assert client.get('/api/export').json()['notes'] == []


def test_batch_revisions_are_checked_before_structural_changes(client):
    first = create(client, 'notes', 'First')
    second = create(client, 'notes', 'Second')
    create(client, 'notes', 'Keep')
    result = batch(client, [
        {'kind': 'notes', 'id': first['id'], 'delete': True, 'expected_revision': first['revision']},
        {'kind': 'notes', 'id': second['id'], 'delete': True, 'expected_revision': second['revision']},
    ])
    assert result['items'] == [None, None]
    assert [row['content'] for row in client.get('/api/export').json()['notes']] == ['Keep']


def test_history_conflict_and_batch_failure_are_atomic(client):
    first = create(client, 'notes', 'First')
    result = batch(client, [{'kind': 'notes', 'id': first['id'], 'content': 'Edited'}])
    client.patch(f"/api/notes/{first['id']}", json={'content': 'Changed in another window'})
    assert client.post('/api/document/history', json={'operations': [result['operation_id']]}).status_code == 409
    assert client.get('/api/export').json()['notes'][0]['content'] == 'Changed in another window'
    response = client.post('/api/document/edit', json={'changes': [{'kind': 'notes', 'id': first['id'], 'content': 'Must roll back'}, {'kind': 'notes', 'content': ''}]})
    assert response.status_code == 422
    assert client.get('/api/export').json()['notes'][0]['content'] == 'Changed in another window'


def test_archive_search_includes_unloaded_nested_notes_and_paginates(client):
    parent = create(client, 'notes', 'Old parent', day='2020-01-01')
    for i in range(5):
        create(client, 'notes', f'Needle {i}', parent['id'], day='2020-01-01')
    result = client.get('/api/search?q=NEEDLE&limit=2').json()
    assert len(result['results']) == 2 and result['next_offset'] == 2
    assert result['results'][0]['date'] == '2020-01-01'
    assert result['results'][0]['parent_id'] == parent['id']
    assert len(client.get('/api/search?q=needle&offset=4&limit=2').json()['results']) == 1
    day = client.get('/api/journal?on=2020-01-01').json()['days']
    assert len(day) == 1 and len(day[0]['notes']) == 6


def test_archive_search_finds_completed_tasks_in_their_logbook_day(client):
    task = create(client, 'tasks', 'A finished searchable task')
    client.post(f"/api/tasks/{task['id']}/complete")
    result = client.get('/api/search?q=searchable').json()['results']
    assert len(result) == 1
    assert (result[0]['id'], result[0]['kind'], result[0]['date']) == (task['id'], 'tasks', '2026-09-16')


def test_new_subtask_under_completed_task_starts_completed_and_reopens_tree(client):
    parent = create(client, 'tasks', 'Already done')
    client.post(f"/api/tasks/{parent['id']}/complete")
    child = create(client, 'tasks', 'Added afterward', parent['id'])
    assert child['completed_at'] and child['parent_id'] == parent['id']
    logbook = client.get('/api/journal').json()['days'][0]['tasks']
    assert {row['id'] for row in logbook} == {parent['id'], child['id']}
    client.post(f"/api/tasks/{child['id']}/reopen", json={})
    todos = {row['id']: row for row in client.get('/api/journal').json()['tasks']}
    assert todos[parent['id']]['completed_at'] is None
    assert todos[child['id']]['completed_at'] is None


def test_completed_tasks_can_be_edited_and_deleted_without_creating_notes(client):
    parent = create(client, 'tasks', 'Completed parent')
    child = create(client, 'tasks', 'Completed child', parent['id'])
    client.post(f"/api/tasks/{child['id']}/complete")
    edited = batch(client, [{'kind': 'tasks', 'id': child['id'], 'content': 'Edited child'}])
    assert edited['items'][0]['content'] == 'Edited child'
    batch(client, [{'kind': 'tasks', 'id': child['id'], 'delete': True}])
    exported = client.get('/api/export').json()
    assert [row['id'] for row in exported['tasks']] == [parent['id']]
    assert exported['notes'] == []


def test_logbook_nesting_converts_entries_to_the_parent_kind(client):
    task = create(client, 'tasks', 'Completed parent')
    client.post(f"/api/tasks/{task['id']}/complete")
    note = create(client, 'notes', 'Starts as a note')
    nested = batch(client, [{'kind': 'notes', 'id': note['id'], 'move': True, 'parent_id': task['id']}])['items'][0]
    assert nested['kind'] == 'task' and nested['completed_at'] and nested['parent_id'] == task['id']
    root = batch(client, [{'kind': 'tasks', 'id': note['id'], 'move': True, 'parent_id': None}])['items'][0]
    assert root['kind'] == 'note' and root['completed_at'] is None and root['parent_id'] is None


def test_repeated_delete_is_idempotent_for_stale_client_retries(client):
    note = create(client, 'notes', 'Delete once')
    task = create(client, 'tasks', 'Delete task once')
    for kind, item in [('notes', note), ('tasks', task)]:
        assert client.delete(f"/api/{kind}/{item['id']}").status_code == 204
        assert client.delete(f"/api/{kind}/{item['id']}").status_code == 204


def test_removing_last_open_child_finishes_parent_and_undo_restores_it(client):
    parent = create(client, 'tasks', 'Group')
    done = create(client, 'tasks', 'Done', parent['id'])
    remaining = create(client, 'tasks', 'Remove', parent['id'])
    client.post(f"/api/tasks/{done['id']}/complete")
    result = batch(client, [{'kind': 'tasks', 'id': remaining['id'], 'delete': True}])
    assert client.get('/api/journal').json()['tasks'] == []
    assert client.get('/api/export').json()['notes'] == []
    history(client, result['operation_id'])
    tasks = {row['id']: row for row in client.get('/api/journal').json()['tasks']}
    assert len(tasks) == 3 and tasks[parent['id']]['completed_at'] is None
    assert tasks[done['id']]['completed_at']
    assert client.get('/api/export').json()['notes'] == []


def test_document_delete_retry_uses_receipt_and_ids_are_never_reused(client):
    note = create(client, 'notes', 'Original')
    payload = {'request_id': 'delete-original', 'changes': [
        {'kind': 'notes', 'id': note['id'], 'delete': True, 'expected_revision': note['revision']}
    ]}
    first = client.post('/api/document/edit', json=payload)
    assert first.status_code == 200
    replacement = create(client, 'notes', 'Replacement')
    assert replacement['id'] > note['id']
    retry = client.post('/api/document/edit', json=payload)
    assert retry.status_code == 200 and retry.json() == first.json()
    assert [row['content'] for row in client.get('/api/export').json()['notes']] == ['Replacement']


def test_stale_revision_is_rejected_without_overwriting_newer_text(client):
    note = create(client, 'notes', 'Original')
    current = batch(client, [{'kind': 'notes', 'id': note['id'], 'content': 'Newer',
                              'expected_revision': note['revision']}])['items'][0]
    stale = client.post('/api/document/edit', json={'changes': [{
        'kind': 'notes', 'id': note['id'], 'content': 'Stale', 'expected_revision': note['revision'],
    }]})
    assert stale.status_code == 409
    saved = client.get('/api/export').json()['notes'][0]
    assert saved['content'] == 'Newer' and saved['revision'] == current['revision']


def test_completion_and_reopen_retries_are_idempotent_with_stale_revision(client):
    task = create(client, 'tasks', 'Retry lifecycle')
    path = f"/api/tasks/{task['id']}/complete?expected_revision={task['revision']}"
    assert client.post(path).status_code == 200
    assert client.post(path).status_code == 200
    completed = next(row for row in client.get('/api/export').json()['tasks'] if row['id'] == task['id'])
    body = {'completed_at': completed['completed_at'], 'expected_revision': completed['revision']}
    assert client.post(f"/api/tasks/{task['id']}/reopen", json=body).status_code == 200
    assert client.post(f"/api/tasks/{task['id']}/reopen", json=body).status_code == 200


def test_deleting_parent_takes_checked_and_open_children_with_it(client):
    parent = create(client, 'tasks', 'Parent')
    checked = create(client, 'tasks', 'Checked', parent['id'])
    open_child = create(client, 'tasks', 'Open', parent['id'])
    keep = create(client, 'tasks', 'Keep')
    client.post(f"/api/tasks/{checked['id']}/complete")
    result = batch(client, [{'kind': 'tasks', 'id': parent['id'], 'delete': True}])
    assert result['items'] == [None]
    journal = client.get('/api/journal').json()
    assert [row['id'] for row in journal['tasks']] == [keep['id']]
    # A checked child is not archived into a day on its way out; it is gone.
    assert not any(row['id'] in {checked['id'], open_child['id']}
                   for day in journal['days'] for row in day['tasks'])


def test_move_into_checked_group_completes_branch_and_can_archive(client):
    root = create(client, 'tasks', 'Root')
    checked_group = create(client, 'tasks', 'Checked group', root['id'])
    last = create(client, 'tasks', 'Last', root['id'])
    client.post(f"/api/tasks/{checked_group['id']}/complete")
    moved = create(client, 'tasks', 'Moved')
    moved_result = batch(client, [{'kind': 'tasks', 'id': moved['id'], 'move': True,
                                   'parent_id': checked_group['id']}])['items'][0]
    assert moved_result['completed_at']
    assert client.post(f"/api/tasks/{last['id']}/complete").status_code == 200
    assert client.get('/api/journal').json()['tasks'] == []


def test_outdenting_checked_task_to_root_moves_it_to_logbook(client):
    parent = create(client, 'tasks', 'Parent')
    checked = create(client, 'tasks', 'Checked', parent['id'])
    create(client, 'tasks', 'Keep parent open', parent['id'])
    client.post(f"/api/tasks/{checked['id']}/complete")
    moved = batch(client, [{'kind': 'tasks', 'id': checked['id'], 'move': True, 'parent_id': None}])['items'][0]
    assert moved['day_id'] is not None and moved['parent_id'] is None
    journal = client.get('/api/journal').json()
    assert checked['id'] not in {row['id'] for row in journal['tasks']}
    assert any(row['id'] == checked['id'] for day in journal['days'] for row in day['tasks'])


def test_search_includes_checked_descendants_inside_active_tree(client):
    root = create(client, 'tasks', 'Root')
    group = create(client, 'tasks', 'Group', root['id'])
    leaf = create(client, 'tasks', 'Hidden searchable leaf', group['id'])
    create(client, 'tasks', 'Keep root open', root['id'])
    client.post(f"/api/tasks/{leaf['id']}/complete")
    result = client.get('/api/search?q=searchable').json()['results']
    assert [row['id'] for row in result] == [leaf['id']]


def test_move_to_another_date_carries_the_branch_and_repacks_both_days(client):
    first = create(client, 'notes', 'Stays', day='2026-09-16')
    moving = create(client, 'notes', 'Moves', day='2026-09-16')
    child = create(client, 'notes', 'Child', moving['id'], day='2026-09-16')
    trailing = create(client, 'notes', 'Trailing', day='2026-09-16')
    target = create(client, 'notes', 'Other day', day='2026-09-17')

    def listing():
        days = {day['date']: {entry['content'] for entry in day['entries']}
                for day in client.get('/api/journal?limit=10').json()['days']}
        return days, {row['content']: row for row in client.get('/api/export').json()['notes']}

    moved = batch(client, [{'kind': 'notes', 'id': moving['id'], 'move': True,
                            'date': '2026-09-17', 'before_id': target['id']}])
    days, rows = listing()
    # The branch follows its root, and the day it left closes the gap.
    assert days['2026-09-17'] == {'Moves', 'Child', 'Other day'}
    assert days['2026-09-16'] == {'Stays', 'Trailing'}
    assert rows['Child']['parent_id'] == moving['id']
    assert [rows['Stays']['position'], rows['Trailing']['position']] == [0, 1]
    assert [rows['Moves']['position'], rows['Other day']['position']] == [0, 1]

    history(client, moved['operation_id'])
    days, rows = listing()
    assert days['2026-09-16'] == {'Stays', 'Moves', 'Child', 'Trailing'}
    assert days['2026-09-17'] == {'Other day'}
    assert rows['Child']['parent_id'] == moving['id']
    assert [rows['Stays']['position'], rows['Moves']['position'], rows['Trailing']['position']] == [0, 1, 2]


def test_move_to_a_date_rejects_a_parent_from_another_day(client):
    note = create(client, 'notes', 'Moves', day='2026-09-16')
    other = create(client, 'notes', 'Elsewhere', day='2026-09-17')
    response = client.post('/api/document/edit', json={'changes': [
        {'kind': 'notes', 'id': note['id'], 'move': True, 'date': '2026-09-18', 'parent_id': other['id']},
    ]})
    assert response.status_code == 409


def test_carrying_a_checked_task_to_another_date_leaves_it_a_task(client):
    task = create(client, 'tasks', 'Finished work')
    client.post(f"/api/tasks/{task['id']}/complete")
    archived = batch(client, [{'kind': 'tasks', 'id': task['id'], 'move': True, 'date': '2026-09-17'}])['items'][0]

    # It stays a checked task, on the date it was carried to, not a note there.
    assert archived['completed_at'] is not None
    assert client.get('/api/export').json()['notes'] == []
    days = {day['date']: day for day in client.get('/api/journal?limit=10').json()['days']}
    assert [row['id'] for row in days['2026-09-17']['tasks']] == [task['id']]
    assert task['id'] not in {row['id'] for row in client.get('/api/journal').json()['tasks']}


def test_a_tagged_task_is_listed_under_its_tag_alone(client):
    plain = create(client, 'tasks', 'Still listed')
    filed = create(client, 'tasks', 'Filed away')
    child = create(client, 'tasks', 'Beneath the filed one', filed['id'])
    batch(client, [{'kind': 'tasks', 'id': filed['id'], 'content': 'Filed away', 'tags': ['errands']}])

    listed = client.get('/api/journal').json()['tasks']
    assert [row['id'] for row in listed] == [plain['id']]
    filtered = client.get('/api/journal?tag=errands').json()['tasks']
    assert {row['id'] for row in filtered} == {filed['id'], child['id']}


def test_filing_a_subtask_leaves_its_parent_without_a_count(client):
    parent = create(client, 'tasks', 'Parent')
    child = create(client, 'tasks', 'Only child', parent['id'])
    batch(client, [{'kind': 'tasks', 'id': child['id'], 'content': 'Only child', 'tags': ['errands']}])

    listed = {row['id']: row for row in client.get('/api/journal').json()['tasks']}
    assert child['id'] not in listed
    assert listed[parent['id']]['child_count'] == 0
    assert listed[parent['id']]['completed_child_count'] == 0


def test_deleting_a_parent_takes_its_whole_branch_and_undo_brings_it_back(client):
    parent = create(client, 'tasks', 'Parent')
    done = create(client, 'tasks', 'Finished child', parent['id'])
    open_child = create(client, 'tasks', 'Open child', parent['id'])
    grandchild = create(client, 'tasks', 'Grandchild', open_child['id'])
    assert client.post(f"/api/tasks/{done['id']}/complete").status_code == 200
    result = batch(client, [{'kind': 'tasks', 'id': parent['id'], 'delete': True}])
    assert client.get('/api/export').json()['tasks'] == []
    history(client, result['operation_id'])
    restored = {row['id']: row['parent_id'] for row in client.get('/api/export').json()['tasks']}
    assert restored == {parent['id']: None, done['id']: parent['id'],
                        open_child['id']: parent['id'], grandchild['id']: open_child['id']}


def test_deleting_one_task_endpoint_also_removes_its_children(client):
    parent = create(client, 'tasks', 'Doomed parent')
    child = create(client, 'tasks', 'Doomed child', parent['id'])
    keep = create(client, 'tasks', 'Untouched')
    assert client.delete(f"/api/tasks/{parent['id']}").status_code == 204
    assert [row['id'] for row in client.get('/api/export').json()['tasks']] == [keep['id']]
    assert child['id'] not in [row['id'] for row in client.get('/api/export').json()['tasks']]


def test_deleting_a_note_parent_removes_nested_notes(client):
    parent = create(client, 'notes', 'Parent note')
    child = create(client, 'notes', 'Nested note', parent['id'])
    create(client, 'notes', 'Deeper note', child['id'])
    assert client.delete(f"/api/notes/{parent['id']}").status_code == 204
    assert client.get('/api/export').json()['notes'] == []
