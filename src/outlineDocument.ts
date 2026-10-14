import { ApiError } from './api';
import { editDocument } from './documentHistory';
import type { EntryKind, OutlineItem } from './types';

export type OutlineChange = {
  id: number; kind: EntryKind; create?: boolean; delete?: boolean; move?: boolean;
  content?: string; tags?: string[]; date?: string; client_id?: string;
  parent_id?: number | null; after_id?: number | null; before_id?: number | null;
  target_kind?: EntryKind;
  allow_empty?: boolean;
};
type Edit = { changes: OutlineChange[]; key: string; requestId: string };
const ordered = (rows: OutlineItem[]) => [...rows].sort((a, b) => a.position - b.position || a.id - b.id);

// Structural editing is local and synchronous. The durable queue sends each
// operation in order, resolving new row IDs and sibling revisions as it goes.
export class OutlineDocument {
  private base: OutlineItem[] = [];
  private edits: Edit[] = [];
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
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) ?? 'null');
      if (saved && Array.isArray(saved.edits) && Array.isArray(saved.aliases) && Number.isInteger(saved.nextId)) {
        this.edits = saved.edits;
        this.aliases = new Map(saved.aliases);
        this.nextId = saved.nextId;
      }
    } catch { /* An invalid recovery record must not prevent opening the list. */ }
  }

  resolve = (id: number | null): number | null => id === null ? null : this.aliases.get(id) ?? id;
  hasPending(id: number | null) {
    return id !== null && this.edits.some(edit => edit.changes.some(change => this.resolve(change.id) === this.resolve(id)));
  }
  allocate() { return this.nextId--; }
  rebase(items: OutlineItem[]) {
    this.base = items;
    // A reload may happen after the server committed a create but before its
    // response arrived. Match its idempotency key before painting a second row.
    for (const edit of this.edits) for (const change of edit.changes) {
      if (!change.create || change.id >= 0 || !change.client_id || this.aliases.has(change.id)) continue;
      const existing = items.find(row => row.client_id === change.client_id);
      if (existing) this.aliases.set(change.id, existing.id);
    }
    return this.items();
  }
  private persist() {
    if (this.edits.length) localStorage.setItem(this.storageKey, JSON.stringify({ edits: this.edits, aliases: [...this.aliases], nextId: this.nextId }));
    else localStorage.removeItem(this.storageKey);
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
      const index = before >= 0 ? before : after >= 0 ? after + 1 : siblings.length;
      row.parent_id = parentId;
      siblings.splice(index, 0, row);
      siblings.forEach((item, position) => { item.position = position; });
      if (previousParent !== parentId) group(previousParent).forEach((item, position) => { item.position = position; });
    };
    for (const edit of this.edits) for (const change of edit.changes) {
      const id = this.resolve(change.id)!;
      let row = rows.find(item => item.id === id);
      if (change.delete) {
        if (!row) continue;
        const children = group(id);
        const siblings = group(row.parent_id).flatMap(item => item.id === id ? children : [item]);
        siblings.forEach((item, position) => { item.parent_id = row!.parent_id; item.position = position; });
        rows = rows.filter(item => item.id !== id);
        continue;
      }
      if (!row && change.create) {
        row = { id, kind: change.kind, content: change.content ?? '', tags: change.tags ?? [],
          parent_id: this.resolve(change.parent_id ?? null), position: rows.length, revision: 1, client_id: change.client_id };
        const parent = rows.find(item => item.id === row!.parent_id);
        if (change.kind === 'tasks' && parent?.completed_at) row.completed_at = parent.completed_at;
        rows.push(row);
      }
      if (!row) continue;
      if (change.content !== undefined) row.content = change.content;
      if (change.tags) row.tags = change.tags;
      if (change.create || change.move) {
        place(row, this.resolve(change.parent_id ?? null), this.resolve(change.after_id ?? null), this.resolve(change.before_id ?? null));
        if (change.move && change.target_kind) {
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

  enqueue(changes: OutlineChange[], key = crypto.randomUUID()) {
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
          const send = () => editDocument(edit.changes.map(change => {
            const id = this.resolve(change.id)!;
            const creating = change.create && id < 0;
            if (id < 0 && !creating) throw new Error('The preceding entry has not saved yet.');
            const parentId = this.resolve(change.parent_id ?? null), afterId = this.resolve(change.after_id ?? null), beforeId = this.resolve(change.before_id ?? null);
            if ([parentId, afterId, beforeId].some(value => value !== null && value < 0)) throw new Error('The preceding entry has not saved yet.');
            const latest = this.base.find(row => row.id === id);
            const { create: _create, target_kind: _targetKind, ...payload } = change;
            return { ...payload, id: creating ? null : id, parent_id: parentId, after_id: afterId, before_id: beforeId,
              expected_revision: creating ? undefined : latest?.revision };
          }), edit.key, edit.requestId);
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
            if (row && change.create && change.id < 0) this.aliases.set(change.id, row.id);
          });
          this.persist();
          this.remapped();
          // Keep the optimistic operation until the server snapshot is in
          // React; otherwise an acknowledged row can blink out for one frame.
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
}
