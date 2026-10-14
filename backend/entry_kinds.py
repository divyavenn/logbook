"""Entry kinds used by API routes and stored rows."""
from typing import Literal

EntryKind = Literal['notes', 'tasks']
StoredEntryKind = Literal['note', 'task']
STORED_KINDS: dict[EntryKind, StoredEntryKind] = {'notes': 'note', 'tasks': 'task'}
API_KINDS: dict[StoredEntryKind, EntryKind] = {value: key for key, value in STORED_KINDS.items()}


def stored_kind(kind: EntryKind) -> StoredEntryKind:
    return STORED_KINDS[kind]


def api_kind(kind: StoredEntryKind) -> EntryKind:
    return API_KINDS[kind]
