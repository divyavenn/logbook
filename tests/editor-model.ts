import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownText, replaceEntryRange } from '../src/markdown';
import { completionPreview, waitForMotion } from '../src/taskCompletion';
import type { OutlineItem } from '../src/types';
import { normalizeJournal, stats } from '../src/apiDecoders';
import { freshDraft, readDraft } from '../src/entryDrafts';
import { readOutlineRecovery } from '../src/outlineRecovery';
import { storage } from '../src/storage';
import { checkEntryDepth } from '../src/entryTree';

function withStorage(run: (values: Map<string, string>) => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  try { run(values); }
  finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('an empty canonical entry list wins over old response fields', () => {
  const note = { id: 1, kind: 'note', content: 'Legacy entry' };
  const result = normalizeJournal({ today: '2026-10-14', server_time: '2026-10-14T12:00:00Z',
    tasks: [{ id: 2, kind: 'task', content: 'Task' }],
    days: [{ date: '2026-10-14', entries: [], notes: [note] }, { date: '2026-10-13', notes: [note] }] });
  assert.deepEqual(result.days[0].entries, []);
  assert.equal(result.days[1].entries[0].kind, 'notes');
  assert.equal(result.tasks[0].kind, 'tasks');
  assert.deepEqual(result.tasks[0].tags, []);
  assert.equal(result.tasks[0].revision, 1);
});

test('invalid response field types cannot enter the editor', () => {
  assert.throws(() => normalizeJournal({ today: '2026-10-14', server_time: '2026-10-14T12:00:00Z',
    tasks: [{ id: 1, kind: 'task', content: 'Text', tags: 'wrong' }] }));
});

test('older statistics responses derive missing totals and averages from daily values', () => {
  const value = stats({ start: '2026-10-13', end: '2026-10-14', daily: [
    { date: '2026-10-13', focused_seconds: 30, longest_session_seconds: 20, session_count: 2 },
    { date: '2026-10-14' },
  ] });
  assert.equal(value.day_count, 2);
  assert.equal(value.active_days, 1);
  assert.equal(value.total_focused_seconds, 30);
  assert.equal(value.average_daily_focused_seconds, 15);
  assert.equal(value.average_daily_longest_session_seconds, 10);
  assert.equal(value.session_count, 2);
});

test('draft recovery keeps text and backs up damaged metadata', t => withStorage(values => {
  const errors = t.mock.method(console, 'error', () => {});
  const key = 'draft-metadata-test';
  const raw = JSON.stringify({ content: 'Keep this text', saved: '', tags: 42, kind: 'task', id: 'bad' });
  values.set(key, raw);
  const draft = readDraft(key, freshDraft([], true, 'notes'));
  assert.equal(draft.content, 'Keep this text');
  assert.equal(draft.kind, 'tasks');
  assert.equal(draft.id, null);
  assert.deepEqual(draft.tags, []);
  assert.ok([...values].some(([name, value]) => name.startsWith(`still-recovery:${key}:`) && value === raw));
  assert.equal(errors.mock.callCount(), 1);
}));

test('queue recovery preserves valid edits and migrates old action flags', t => withStorage(values => {
  const errors = t.mock.method(console, 'error', () => {});
  const key = 'queue-records-test';
  values.set(key, JSON.stringify({ nextId: 0, aliases: [['invalid', 3], [-2, 8]], edits: [null,
    { key: 'good', requestId: 'good', changes: [{ kind: 'tasks', id: -3, create: true, content: 'Saved text', client_id: 'new-entry' }] },
    { key: 'missing', requestId: 'missing', changes: [{ kind: 'tasks', id: -99, delete: true }] },
  ] }));
  const recovered = readOutlineRecovery(key);
  assert.equal(recovered.edits.length, 1);
  assert.equal(recovered.edits[0].changes[0].type, 'create');
  assert.deepEqual(recovered.aliases, [[-2, 8]]);
  assert.equal(recovered.nextId, -4);
  assert.ok([...values.keys()].some(name => name.startsWith(`still-recovery:${key}:`)));
  assert.equal(errors.mock.callCount(), 1);
}));

test('storage failures keep the latest data usable in this tab', t => withStorage(() => {
  const errors = t.mock.method(console, 'error', () => {});
  const key = 'blocked-storage-test';
  const native = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Blocked', 'SecurityError'); } });
  storage.setItem(key, 'first');
  storage.setItem(key, 'latest');
  assert.equal(storage.getItem(key), 'latest');
  assert.ok(storage.keys().includes(key));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: native });
  assert.equal(storage.getItem(key), 'latest');
  storage.setItem(key, 'saved again');
  assert.equal(native.getItem(key), 'saved again');
  storage.removeItem(key);
  assert.equal(storage.getItem(key), null);
  assert.ok(errors.mock.callCount() > 0);
}));

test('partial deletion across entries preserves formatting, spaces, and the join caret', () => {
  const result = replaceEntryRange(
    { content: 'Keep **bold** gone', tags: [], from: 10, to: 14 },
    { content: 'gone *tail*', tags: [], from: 0, to: 5 },
  );
  assert.equal(result.content, 'Keep **bold** *tail*');
  assert.equal(result.offset, 10);
});

test('replacing a selection retains only tags outside the selected text', () => {
  const result = replaceEntryRange(
    { content: '#keep alpha gone', tags: ['keep'], from: 12, to: 16 },
    { content: 'gone #remove tail', tags: ['remove'], from: 0, to: 13 },
    'new ',
  );
  assert.equal(markdownText(result.content), '#keep alpha new tail');
  assert.deepEqual(result.tags, ['keep']);
  assert.equal(result.offset, 16);
});

test('hard breaks before a partial selection retain their offsets', () => {
  const result = replaceEntryRange(
    { content: 'one\\\ntwo cut', tags: [], from: 8, to: 11 },
    { content: 'cut last', tags: [], from: 0, to: 4 },
  );
  assert.equal(markdownText(result.content), 'one\ntwo last');
  assert.equal(result.offset, 8);
});

test('a selection boundary within one outline keeps its unselected suffix and filter tag', () => {
  const row = { content: 'remove keep', tags: ['work'], from: 0, to: 7 };
  const result = replaceEntryRange(row, row, '', '', ['work']);
  assert.equal(result.content, 'keep');
  assert.deepEqual(result.tags, ['work']);
  assert.equal(result.offset, 0);
});

test('fully selected entries produce an empty replacement', () => {
  const result = replaceEntryRange(
    { content: 'first', tags: [], from: 0, to: 5 },
    { content: 'last', tags: [], from: 0, to: 4 },
  );
  assert.equal(result.content, '');
  assert.deepEqual(result.tags, []);
});

test('multiline replacement preserves boundary spaces before joining text', () => {
  const result = replaceEntryRange(
    { content: 'Keep remove', tags: [], from: 5, to: 11 },
    { content: 'gone tail', tags: [], from: 0, to: 5 },
    'new\nnext ',
  );
  assert.equal(markdownText(result.content), 'Keep new\nnext tail');
  assert.equal(result.offset, 14);
});

const row = (id: number, parent_id: number | null, extra: Partial<OutlineItem> = {}): OutlineItem => ({
  id, parent_id, content: String(id), kind: 'tasks', tags: [], position: id, revision: 1, ...extra,
});

test('tree checks reject cycles without getting stuck', () => {
  assert.throws(() => checkEntryDepth([row(1, null), row(2, 1)], 1, 2), /itself/);
  assert.throws(() => checkEntryDepth([row(1, 2), row(2, 1)], 1, null), /invalid parent/);
});

test('reversing a leaf retargets every finishing ancestor', () => {
  const rows = [row(1, null, { child_count: 1, completed_child_count: 0 }),
    row(2, 1, { child_count: 2, completed_child_count: 1 }), row(3, 2), row(4, 2, { completed_at: 'done' })];
  const complete = completionPreview(rows, new Map([[3, true]]));
  assert.equal(complete.get(2), true);
  assert.equal(complete.get(1), true);
  const reverse = completionPreview(rows, new Map([[3, false]]));
  assert.equal(reverse.get(2), false);
  assert.equal(reverse.get(1), false);
});

test('concurrent sibling intents preserve counts for children outside the view', () => {
  const rows = [row(1, null, { child_count: 3, completed_child_count: 1 }), row(2, 1), row(3, 1)];
  assert.equal(completionPreview(rows, new Map([[2, true]])).get(1), false);
  assert.equal(completionPreview(rows, new Map([[2, true], [3, true]])).get(1), true);
});

test('animation waits cancel immediately and reduced motion never waits', async () => {
  const preference = Object.assign(new EventTarget(), { matches: false });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => preference } });
  const controller = new AbortController();
  const waiting = waitForMotion(60_000, controller.signal);
  controller.abort();
  assert.equal(await waiting, false);
  const changing = waitForMotion(60_000, new AbortController().signal);
  preference.matches = true;
  preference.dispatchEvent(new Event('change'));
  assert.equal(await changing, true);
  assert.equal(await waitForMotion(60_000, new AbortController().signal), true);
  Reflect.deleteProperty(globalThis, 'window');
});
