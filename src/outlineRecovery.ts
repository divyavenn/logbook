import { entryKind } from './apiDecoders';
import { array, boolean, integer, nullable, object, optional, positiveId, strings, text } from './validation';
import { preserveRecovery, readStored, recoverRecords, storage } from './storage';
import type { OutlineChange } from './entryChanges';
import entryPolicy from '../shared/entry-policy.json';

export type PendingEdit = { changes: OutlineChange[]; key: string; requestId: string };
type Recovery = { edits: PendingEdit[]; aliases: [number, number][]; nextId: number };
function localId(value: unknown): number {
  const id = integer(value);
  if (id === 0) throw new Error('Invalid local entry ID.');
  return id;
}
function change(value: unknown): OutlineChange {
  const row = object(value);
  if (row.kind == null) throw new Error('A saved edit needs an entry kind.');
  const identity = { id: localId(row.id), kind: entryKind(row.kind, 'notes') };
  // Older saved queues used separate flags. Read them once at this boundary.
  const type = row.type ?? (row.delete === true ? 'delete' : row.move === true ? 'move' : row.create === true ? 'create' : 'update');
  if (type === 'delete') return { ...identity, type };
  const placement = { parent_id: nullable(row.parent_id, localId), after_id: nullable(row.after_id, localId), before_id: nullable(row.before_id, localId) };
  if (type === 'move') return { ...identity, ...placement, type, target_kind: entryKind(row.target_kind, identity.kind) };
  const content = text(row.content);
  const tags = row.tags === undefined ? undefined : strings(row.tags);
  const allow_empty = optional(row.allow_empty, boolean, false);
  if (type === 'update') return { ...identity, type, content, tags, allow_empty };
  if (type !== 'create') throw new Error('Unknown saved edit.');
  const client_id = text(row.client_id);
  if (!client_id || client_id.length > entryPolicy.max_client_id_length || identity.id >= 0) throw new Error('Invalid new entry.');
  return { ...identity, ...placement, type, content, tags, allow_empty, client_id, date: row.date === undefined ? undefined : text(row.date) };
}
function edit(value: unknown): PendingEdit {
  const row = object(value);
  const key = text(row.key), requestId = text(row.requestId);
  if (!key || !requestId || requestId.length > entryPolicy.max_client_id_length) throw new Error('Invalid saved edit ID.');
  const changes = array(row.changes, change);
  if (!changes.length) throw new Error('An edit needs at least one change.');
  return { key, requestId, changes };
}
export function readOutlineRecovery(key: string): Recovery {
  return readStored(key, value => {
    const row = object(value);
    if (row.version !== undefined && row.version !== 2) throw new Error('Unknown saved edit version.');
    const invalid = (error: unknown) => {
      const raw = storage.getItem(key);
      if (raw !== null) preserveRecovery(key, raw, error);
    };
    const aliases = recoverRecords(row.aliases ?? [], value => {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('Invalid saved entry link.');
      const from = integer(value[0]), to = positiveId(value[1]);
      if (from >= 0) throw new Error('Only new entry IDs may be replaced.');
      return [from, to] as [number, number];
    }, invalid);
    const known = new Set(aliases.map(([id]) => id));
    const edits = recoverRecords(row.edits ?? [], edit, invalid).filter(edit => {
      const available = new Set(known);
      for (const change of edit.changes) {
        if (change.type === 'create') available.add(change.id);
        const references = [change.id, ...('parent_id' in change ? [change.parent_id, change.after_id, change.before_id] : [])];
        if (references.some(id => id != null && id < 0 && !available.has(id))) {
          invalid(new Error('A saved edit refers to a missing new entry.'));
          return false;
        }
      }
      for (const id of available) known.add(id);
      return true;
    });
    // Never reuse a temporary ID that still belongs to a restored edit.
    let nextId = -1;
    for (const id of known) nextId = Math.min(nextId, id - 1);
    return { edits, aliases, nextId };
  }, { edits: [], aliases: [], nextId: -1 });
}
