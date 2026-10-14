from .test_app import client  # noqa: F401
from .test_hierarchy import create


def batch(client, changes):
    response = client.post('/api/document/edit', json={'changes': changes})
    assert response.status_code == 200, response.text
    return response.json()


def history(client, operation, redo=False):
    response = client.post('/api/document/history', json={'operations': [operation], 'redo': redo})
    assert response.status_code == 200, response.text


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


def test_deleting_parent_archives_promoted_checked_child(client):
    parent = create(client, 'tasks', 'Parent')
    checked = create(client, 'tasks', 'Checked', parent['id'])
    open_child = create(client, 'tasks', 'Open', parent['id'])
    client.post(f"/api/tasks/{checked['id']}/complete")
    result = batch(client, [{'kind': 'tasks', 'id': parent['id'], 'delete': True}])
    assert result['items'] == [None]
    journal = client.get('/api/journal').json()
    assert [row['id'] for row in journal['tasks']] == [open_child['id']]
    assert any(row['id'] == checked['id'] for day in journal['days'] for row in day['tasks'])


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
