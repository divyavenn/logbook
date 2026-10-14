import { completeTask, editEntries, reopenTask, restoreDocumentHistory } from './api';
import { flushDrafts } from './JournalContext';
import { preserveRecovery, readStored, recoverRecords, storage } from './storage';
import { object, positiveId, strings, text } from './validation';
import type { DocumentChange } from './entryChanges';
import type { OutlineItem } from './types';

type Entry = { key: string; operations: string[]; completion?: { id: number; at: string } };
type HistoryShortcutEvent = {
  key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean;
};
const HISTORY_KEY = 'still-document-history';
function historyEntry(value: unknown): Entry {
  const row = object(value);
  const operations = strings(row.operations);
  const key = text(row.key);
  if (!key || operations.some(operation => !operation)) throw new Error('Invalid history entry.');
  if (row.completion === undefined) {
    if (!operations.length) throw new Error('A history entry needs a saved operation.');
    return { key, operations };
  }
  if (operations.length) throw new Error('A history entry cannot mix a completion with text edits.');
  const completion = object(row.completion);
  return { key, operations, completion: { id: positiveId(completion.id), at: text(completion.at) } };
}
const stored = readStored(HISTORY_KEY, value => {
  const row = object(value);
  const invalid = (error: unknown) => {
    const raw = storage.getItem(HISTORY_KEY);
    if (raw !== null) preserveRecovery(HISTORY_KEY, raw, error);
  };
  return { undo: recoverRecords(row.undo ?? [], historyEntry, invalid), redo: recoverRecords(row.redo ?? [], historyEntry, invalid) };
}, { undo: [], redo: [] });
let undo: Entry[] = stored.undo, redo: Entry[] = stored.redo, busy = false;
function changed() {
  storage.setItem(HISTORY_KEY, JSON.stringify({ undo: undo.slice(-200), redo: redo.slice(-200) }));
  window.dispatchEvent(new CustomEvent('still-history-available', { detail: undo.length > 0 }));
}
export function historyShortcutDirection(event: HistoryShortcutEvent): boolean | null {
  if (event.repeat || event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey;
  if (key === 'y' && !event.shiftKey) return true;
  return null;
}
export function recordEdit(operation: string | null, key: string) {
  if (!operation) return;
  if (undo.some(entry => entry.operations.includes(operation))) return;
  if (undo.at(-1)?.key === key && !undo.at(-1)?.completion) undo.at(-1)!.operations.push(operation);
  else undo.push({ key, operations: [operation] });
  redo = []; changed();
}
export function recordCompletion(id: number, at: string) {
  undo.push({ key: crypto.randomUUID(), operations: [], completion: { id, at } }); redo = []; changed();
}
export async function editDocument(changes: readonly DocumentChange[], key: string = crypto.randomUUID(), requestId: string = crypto.randomUUID()): Promise<(OutlineItem | null)[]> {
  const result = await editEntries(changes, requestId);
  recordEdit(result.operation_id, key); return result.items;
}
export async function documentUndo(forward = false) {
  if (busy) return;
  busy = true;
  try {
    await flushDrafts();
    const from = forward ? redo : undo, to = forward ? undo : redo;
    const entry = from.at(-1);
    if (!entry) return;
    if (entry.completion) {
      if (forward) {
        const result = await completeTask(entry.completion.id); entry.completion.at = result.completed_at;
      } else await reopenTask(entry.completion.id, { completed_at: entry.completion.at });
    } else await restoreDocumentHistory(forward ? entry.operations : [...entry.operations].reverse(), forward);
    from.pop(); to.push(entry); changed();
    window.dispatchEvent(new Event('still-history-applied'));
  } finally { busy = false; }
}
