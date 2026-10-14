import { ApiError } from './api';
import { editDocument } from './documentHistory';
import type { OutlineItem } from './types';
import type { DocumentChange, OutlineChange } from './entryChanges';
import { orderedEntries as ordered } from './entryTree';
import { readOutlineRecovery, type PendingEdit } from './outlineRecovery';
import { storage } from './storage';
export type { OutlineChange } from './entryChanges';

// Show edits right away, then save them in order. Replace temporary entry IDs
// with server IDs before sending the next edit.
export class OutlineDocument {
  private base: OutlineItem[] = [];
  private edits: PendingEdit[] = [];
  private aliases = new Map<number, number>();
  private pending: Promise<void> | null = null;
  private nextId = -1;
  private storageKey: string;
  changed = () => {};
  remapped = () => {};
  failed = (_error: unknown, _ids: number[]) => {};
  refresh: () => Promise<void> = async () => {};

  constructor(key: string) {
    this.storageKey = `still-pending-edits:${key}`;
    const saved = readOutlineRecovery(this.storageKey);
    this.edits = saved.edits;
    this.aliases = new Map(saved.aliases);
    this.nextId = saved.nextId;
  }

  resolve = (id: number | null): number | null => id === null ? null : this.aliases.get(id) ?? id;
  hasPending(id: number | null) {
    return id !== null && this.edits.some(edit => edit.changes.some(change => this.resolve(change.id) === this.resolve(id)));
  }
  allocate() { return this.nextId--; }
  rebase(items: OutlineItem[]) {
    this.base = items;
    // The server may have saved a new entry before the page closed. Match its
    // client ID so restoring the pending edit does not show the entry twice.
    for (const edit of this.edits) for (const change of edit.changes) {
      if (change.type !== 'create' || change.id >= 0 || this.aliases.has(change.id)) continue;
      const existing = items.find(row => row.client_id === change.client_id);
      if (existing) this.aliases.set(change.id, existing.id);
    }
    return this.items();
  }
  private persist() {
    if (this.edits.length) storage.setItem(this.storageKey, JSON.stringify({ version: 2, edits: this.edits, aliases: [...this.aliases], nextId: this.nextId }));
    else storage.removeItem(this.storageKey);
  }

  items() {
    if (!this.edits.length) return this.base;
    let rows = this.base.map(row => ({ ...row }));
    const group = (parentId: number | null, except?: number) => ordered(rows.filter(row => row.parent_id === parentId && row.id !== except));
    const place = (row: OutlineItem, parentId: number | null, afterId?: number | null, beforeId?: number | null) => {
      const previousParent = row.parent_id;
      const siblings = group(parentId, row.id);
      const before = siblings.findIndex(item => item.id === beforeId);
      const after = siblings.findIndex(item => item.id === afterId);
      let index = siblings.length;
      if (before >= 0) index = before;
      else if (after >= 0) index = after + 1;
      row.parent_id = parentId;
      siblings.splice(index, 0, row);
      siblings.forEach((item, position) => { item.position = position; });
      if (previousParent !== parentId) group(previousParent).forEach((item, position) => { item.position = position; });
    };
    for (const edit of this.edits) for (const change of edit.changes) {
      const id = this.resolve(change.id)!;
      let row = rows.find(item => item.id === id);
      if (change.type === 'delete') {
        if (!row) continue;
        const children = group(id);
        const siblings = group(row.parent_id).flatMap(item => item.id === id ? children : [item]);
        siblings.forEach((item, position) => { item.parent_id = row!.parent_id; item.position = position; });
        rows = rows.filter(item => item.id !== id);
        continue;
      }
      if (!row && change.type === 'create') {
        row = { id, kind: change.kind, content: change.content ?? '', tags: change.tags ?? [],
          parent_id: this.resolve(change.parent_id ?? null), position: rows.length, revision: 1, client_id: change.client_id };
        const parent = rows.find(item => item.id === row!.parent_id);
        if (change.kind === 'tasks' && parent?.completed_at) row.completed_at = parent.completed_at;
        rows.push(row);
      }
      if (!row) continue;
      if ('content' in change) row.content = change.content;
      if ('tags' in change && change.tags) row.tags = change.tags;
      if (change.type === 'create' || change.type === 'move') {
        place(row, this.resolve(change.parent_id ?? null), this.resolve(change.after_id ?? null), this.resolve(change.before_id ?? null));
        if (change.type === 'move') {
          const parent = rows.find(item => item.id === row!.parent_id);
          const tree = new Set([row.id]);
          for (let added = true; added;) {
            added = false;
            for (const child of rows) if (child.parent_id !== null && tree.has(child.parent_id) && !tree.has(child.id)) { tree.add(child.id); added = true; }
          }
          for (const child of rows) if (tree.has(child.id)) {
            child.kind = change.target_kind;
            if (change.target_kind === 'notes') child.completed_at = null;
            else if (parent?.completed_at) child.completed_at = parent.completed_at;
          }
        }
      }
    }
    // Counts reflect local edits without scanning the whole list per row.
    const counts = (items: OutlineItem[]) => {
      const result = new Map<number | null, { total: number; done: number }>();
      for (const item of items) {
        const count = result.get(item.parent_id) ?? { total: 0, done: 0 };
        count.total++; if (item.completed_at) count.done++;
        result.set(item.parent_id, count);
      }
      return result;
    };
    const originalRows = new Map(this.base.map(row => [row.id, row]));
    const beforeCounts = counts(this.base), afterCounts = counts(rows);
    return rows.map(row => {
      const original = originalRows.get(row.id), before = beforeCounts.get(row.id), after = afterCounts.get(row.id);
      const hiddenCount = Math.max(0, (original?.child_count ?? before?.total ?? 0) - (before?.total ?? 0));
      const hiddenDone = Math.max(0, (original?.completed_child_count ?? 0) - (before?.done ?? 0));
      return { ...row, child_count: (after?.total ?? 0) + hiddenCount, completed_child_count: (after?.done ?? 0) + hiddenDone };
    });
  }

  enqueue(changes: OutlineChange[], key: string = crypto.randomUUID()) {
    if (!changes.length) return;
    this.edits.push({ changes, key, requestId: crypto.randomUUID() });
    this.persist();
    this.changed();
  }

  flush(): Promise<void> {
    if (this.pending) return this.pending;
    const work = async () => {
      while (this.edits.length) {
        const edit = this.edits[0];
        try {
          const send = () => editDocument(edit.changes.map(change => this.requestChange(change)), edit.key, edit.requestId);
          let results;
          try { results = await send(); }
          catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409) throw error;
            await this.refresh();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            results = await send();
          }
          results.forEach((row, index) => {
            const change = edit.changes[index];
            if (row && change.type === 'create' && change.id < 0) this.aliases.set(change.id, row.id);
          });
          this.persist();
          this.remapped();
          // Keep the local edit visible until React has the saved copy.
          // Removing it sooner can make an entry briefly disappear.
          await this.refresh();
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          this.edits.shift();
          this.persist();
          this.changed();
        } catch (error) {
          this.failed(error, edit.changes.map(change => this.resolve(change.id)!));
          throw error;
        }
      }
    };
    this.pending = work().finally(() => { this.pending = null; });
    return this.pending;
  }

  private requestChange(change: OutlineChange): DocumentChange {
    const id = this.resolve(change.id)!;
    const creating = change.type === 'create' && id < 0;
    if (id < 0 && !creating) throw new Error('The preceding entry has not saved yet.');
    const identity = { id, kind: change.kind, expected_revision: this.base.find(row => row.id === id)?.revision };
    if (change.type === 'delete') return { ...identity, delete: true };
    if (change.type === 'update') return { ...identity, content: change.content, tags: change.tags, allow_empty: change.allow_empty };
    const parent_id = this.resolve(change.parent_id ?? null);
    const after_id = this.resolve(change.after_id ?? null);
    const before_id = this.resolve(change.before_id ?? null);
    if ([parent_id, after_id, before_id].some(value => value !== null && value < 0)) throw new Error('The preceding entry has not saved yet.');
    if (change.type === 'move') return { ...identity, move: true, parent_id, after_id, before_id };
    const content = { content: change.content, tags: change.tags, allow_empty: change.allow_empty };
    if (!creating) return { ...identity, ...content };
    return { kind: change.kind, ...content, parent_id, after_id, before_id, date: change.date, client_id: change.client_id };
  }
}
