import type { OutlineItem } from './types';
import { MAX_ENTRY_DEPTH } from './entryTree';

export const TASK_PROGRESS_MS = 240;

export function completionPreview(rows: OutlineItem[], targets: Map<number, boolean>) {
  const preview = new Map(targets);
  const children = new Map<number, OutlineItem[]>();
  for (const row of rows) if (row.parent_id !== null) {
    const group = children.get(row.parent_id) ?? [];
    group.push(row); children.set(row.parent_id, group);
  }
  // Propagate leaf intents up the tree. Counts include children hidden by the
  // current view, while deltas only touch children the user actually changed.
  for (let pass = 0; pass < MAX_ENTRY_DEPTH; pass++) {
    let changed = false;
    for (const row of rows) {
      const group = children.get(row.id);
      if (!group?.some(child => preview.has(child.id))) continue;
      const total = row.child_count ?? group.length;
      const done = (row.completed_child_count ?? group.filter(child => child.completed_at).length)
        + group.reduce((delta, child) => delta + (preview.has(child.id) ? Number(preview.get(child.id)) - Number(!!child.completed_at) : 0), 0);
      const complete = total > 0 && done === total;
      if (preview.get(row.id) !== complete) { preview.set(row.id, complete); changed = true; }
    }
    if (!changed) break;
  }
  return preview;
}

export function waitForMotion(duration: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (duration <= 0 || preference.matches) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (completed: boolean) => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); preference.removeEventListener('change', reduce); resolve(completed);
    };
    const cancel = () => finish(false);
    const reduce = () => { if (preference.matches) finish(true); };
    const timer = setTimeout(() => finish(true), duration);
    signal.addEventListener('abort', cancel, { once: true });
    preference.addEventListener('change', reduce);
  });
}
