import { useEffect, useRef, useState } from 'react';
import { completeTask, reopenTask } from './api';
import { recordEdit } from './documentHistory';
import { completionPreview, TASK_PROGRESS_MS, waitForMotion } from './taskCompletion';
import type { OutlineDocument } from './outlineDocument';
import type { OutlineItem } from './types';

type CompletionContext = {
  document: OutlineDocument;
  rows: () => OutlineItem[];
  locked: () => boolean;
  save: () => Promise<unknown>;
  refresh: () => Promise<void>;
  activeId: () => number | null;
  clearActive: () => void;
  onComplete: (ids: number[], taskId: number, completedAt: string) => void;
  onReopen: (ids: number[]) => void;
  onError: (error: unknown, id: number) => void;
};

export function useTaskCompletion(context: CompletionContext) {
  const current = useRef(context);
  current.current = context;
  const mounted = useRef(true);
  const targets = useRef(new Map<number, boolean>());
  const running = useRef(false);
  const motion = useRef<AbortController | null>(null);
  const changedAt = useRef(0);
  const [completing, setCompleting] = useState(new Set<number>());
  const [pendingCompletion, setPendingCompletion] = useState(new Map<number, boolean>());

  useEffect(() => {
    mounted.current = true;
    const reset = () => {
      targets.current.clear(); motion.current?.abort();
      setCompleting(new Set()); setPendingCompletion(new Map());
    };
    window.addEventListener('still-history-applied', reset);
    return () => { mounted.current = false; motion.current?.abort(); window.removeEventListener('still-history-applied', reset); };
  }, []);

  const complete = (entryId: number) => {
    const ctx = current.current;
    if (ctx.locked()) return;
    const id = ctx.document.resolve(entryId)!;
    const task = ctx.rows().find(row => row.id === id);
    if (!task) return;
    const intents = targets.current;
    intents.set(id, !(intents.get(id) ?? !!task.completed_at));
    changedAt.current = performance.now();
    motion.current?.abort();
    setCompleting(new Set());
    setPendingCompletion(completionPreview(ctx.rows(), intents));
    if (running.current) return;
    running.current = true;

    void (async () => {
      const states = new Map<number, OutlineItem>();
      try {
        while (intents.size) {
          await current.current.save();
          for (const row of current.current.rows()) {
            if (!states.has(row.id) || states.get(row.id)!.revision < row.revision) states.set(row.id, row);
          }
          for (const [temporaryId, desired] of [...intents]) {
            const resolved = current.current.document.resolve(temporaryId)!;
            if (resolved !== temporaryId) { intents.delete(temporaryId); intents.set(resolved, desired); }
          }
          if (mounted.current) setPendingCompletion(completionPreview(current.current.rows(), intents));
          const pending = [...intents].find(([taskId, desired]) => desired !== !!states.get(taskId)?.completed_at);
          if (pending) {
            const [taskId, desired] = pending;
            const latest = states.get(taskId);
            if (!latest) { intents.delete(taskId); continue; }
            try {
              if (desired) {
                const result = await completeTask(taskId, latest.revision);
                for (const row of result.items) states.set(row.id, row);
                current.current.onComplete(result.task_ids, taskId, result.completed_at);
              } else {
                const result = await reopenTask(taskId, { completed_at: latest.completed_at, expected_revision: latest.revision, record_history: true });
                for (const row of result.items) states.set(row.id, row);
                recordEdit(result.operation_id, crypto.randomUUID());
                current.current.onReopen(result.reopened);
              }
            } catch (error) {
              intents.set(taskId, !!latest.completed_at);
              current.current.onError(error, taskId);
            }
            continue;
          }

          // A new click cancels the wait and changes the running transition.
          const wait = new AbortController();
          motion.current = wait;
          if (!await waitForMotion(TASK_PROGRESS_MS - (performance.now() - changedAt.current), wait.signal)) continue;
          const rows = current.current.rows();
          const exits = new Set(rows.filter(row => row.parent_id === null && !row.completed_at && states.get(row.id)?.completed_at).map(row => row.id));
          if (mounted.current) setCompleting(exits);
          if (exits.size && !await waitForMotion(180, wait.signal)) continue;
          const activeId = current.current.activeId();
          if (activeId !== null && states.get(activeId)?.completed_at && completionPreview(rows, intents).get(activeId) === true) current.current.clearActive();
          await current.current.refresh();
          if (wait.signal.aborted) continue;
          intents.clear();
        }
      } catch (error) {
        intents.clear();
        current.current.onError(error, id);
      } finally {
        running.current = false; motion.current = null;
        if (mounted.current) { setCompleting(new Set()); setPendingCompletion(new Map()); }
        void current.current.document.flush().catch(() => {});
      }
    })();
  };
  return { complete, completing, pendingCompletion };
}
