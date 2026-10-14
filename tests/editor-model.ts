import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownText, replaceBulletRange } from '../src/markdown';
import { completionPreview, waitForMotion } from '../src/taskCompletion';
import type { OutlineItem } from '../src/types';

test('partial deletion across entries preserves formatting, spaces, and the join caret', () => {
  const result = replaceBulletRange(
    { content: 'Keep **bold** gone', tags: [], from: 10, to: 14 },
    { content: 'gone *tail*', tags: [], from: 0, to: 5 },
  );
  assert.equal(result.content, 'Keep **bold** *tail*');
  assert.equal(result.offset, 10);
});

test('replacing a selection retains only tags outside the selected text', () => {
  const result = replaceBulletRange(
    { content: '#keep alpha gone', tags: ['keep'], from: 12, to: 16 },
    { content: 'gone #remove tail', tags: ['remove'], from: 0, to: 13 },
    'new ',
  );
  assert.equal(markdownText(result.content), '#keep alpha new tail');
  assert.deepEqual(result.tags, ['keep']);
  assert.equal(result.offset, 16);
});

test('hard breaks before a partial selection retain their offsets', () => {
  const result = replaceBulletRange(
    { content: 'one\\\ntwo cut', tags: [], from: 8, to: 11 },
    { content: 'cut last', tags: [], from: 0, to: 4 },
  );
  assert.equal(markdownText(result.content), 'one\ntwo last');
  assert.equal(result.offset, 8);
});

test('a selection boundary within one outline keeps its unselected suffix and filter tag', () => {
  const row = { content: 'remove keep', tags: ['work'], from: 0, to: 7 };
  const result = replaceBulletRange(row, row, '', '', ['work']);
  assert.equal(result.content, 'keep');
  assert.deepEqual(result.tags, ['work']);
  assert.equal(result.offset, 0);
});

test('fully selected entries produce an empty replacement', () => {
  const result = replaceBulletRange(
    { content: 'first', tags: [], from: 0, to: 5 },
    { content: 'last', tags: [], from: 0, to: 4 },
  );
  assert.equal(result.content, '');
  assert.deepEqual(result.tags, []);
});

test('multiline replacement preserves boundary spaces before joining text', () => {
  const result = replaceBulletRange(
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
