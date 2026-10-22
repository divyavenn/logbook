import type { OutlineItem } from './types';
import entryPolicy from '../shared/entry-policy.json';

export const MAX_ENTRY_DEPTH = entryPolicy.max_depth;
export const orderedEntries = (rows: readonly OutlineItem[]): OutlineItem[] => [...rows].sort((a, b) => a.position - b.position || a.id - b.id);
export const siblingEntries = (rows: readonly OutlineItem[], parentId: number | null): OutlineItem[] => orderedEntries(rows.filter(row => row.parent_id === parentId));

// An entry and everything beneath it: what a move carries and a delete takes.
export function branchIds(rows: readonly OutlineItem[], id: number): Set<number> {
  const branch = new Set([id]);
  for (let added = true; added;) {
    added = false;
    for (const row of rows) {
      if (row.parent_id !== null && branch.has(row.parent_id) && !branch.has(row.id)) { branch.add(row.id); added = true; }
    }
  }
  return branch;
}

export function ancestorIds(rows: readonly OutlineItem[], parentId: number | null): number[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  const seen = new Set<number>();
  let parent = parentId;
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    parent = byId.get(parent)?.parent_id ?? null;
  }
  return [...seen];
}

export function checkEntryDepth(rows: readonly OutlineItem[], id: number | null, parentId: number | null): void {
  const parents = ancestorIds(rows, parentId);
  if (id !== null && parents.includes(id)) throw new Error('An entry cannot be nested inside itself.');
  const children = new Map<number, number[]>();
  for (const row of rows) if (row.parent_id !== null) children.set(row.parent_id, [...children.get(row.parent_id) ?? [], row.id]);
  const stack: [number, number][] = id === null ? [] : [[id, 0]];
  const visited = new Set<number>();
  let height = 0;
  while (stack.length) {
    const [entryId, depth] = stack.pop()!;
    if (visited.has(entryId)) throw new Error('This entry has an invalid parent link.');
    visited.add(entryId);
    height = Math.max(height, depth);
    for (const child of children.get(entryId) ?? []) stack.push([child, depth + 1]);
  }
  if (parents.length + height + 1 > MAX_ENTRY_DEPTH) throw new Error(`Entries support up to ${MAX_ENTRY_DEPTH} levels.`);
}
