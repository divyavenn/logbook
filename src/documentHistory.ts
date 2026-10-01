import { api } from './api';
import { flushDrafts } from './JournalContext';
import type { OutlineItem } from './types';

type Entry = { key: string; operations: string[]; completion?: { id: number; at: string } };
type HistoryShortcutEvent = {
  key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean;
};
let undo: Entry[] = [], redo: Entry[] = [], busy = false;
try { const stored = JSON.parse(localStorage.getItem('still-document-history') ?? '{}'); undo = stored.undo ?? []; redo = stored.redo ?? []; } catch { /* A damaged history does not prevent editing. */ }
function changed() {
  localStorage.setItem('still-document-history', JSON.stringify({ undo: undo.slice(-200), redo: redo.slice(-200) }));
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
  if (undo.at(-1)?.key === key && !undo.at(-1)?.completion) undo.at(-1)!.operations.push(operation);
  else undo.push({ key, operations: [operation] });
  redo = []; changed();
}
export function recordCompletion(id: number, at: string) {
  undo.push({ key: crypto.randomUUID(), operations: [], completion: { id, at } }); redo = []; changed();
}
export async function editDocument(changes: Record<string, unknown>[], key = crypto.randomUUID(), requestId = crypto.randomUUID()) {
  const result = await api<{ items: (OutlineItem | null)[]; operation_id: string | null }>('/document/edit', 'POST', { changes, request_id: requestId });
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
        const result = await api<{ completed_at: string }>(`/tasks/${entry.completion.id}/complete`, 'POST'); entry.completion.at = result.completed_at;
      } else await api(`/tasks/${entry.completion.id}/reopen`, 'POST', { completed_at: entry.completion.at });
    } else await api('/document/history', 'POST', { operations: forward ? entry.operations : [...entry.operations].reverse(), redo: forward });
    from.pop(); to.push(entry); changed();
    window.dispatchEvent(new Event('still-history-applied'));
  } finally { busy = false; }
}
