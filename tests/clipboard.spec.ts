import { expect, test } from './fixtures';

const today = '2026-09-24';
const yesterday = '2026-09-23';

test('a selection across dates copies as markdown, with headings and events', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null, tasks: [],
    days: [
      { date: today, focused_seconds: 0, notes: [
        { id: 11, content: 'Today entry', tags: [], parent_id: null, position: 0 },
        { id: 12, content: 'Today child', tags: [], parent_id: 11, position: 0 },
      ], events: [
        { id: 'standup', title: 'Standup', start: `${today}T09:00:00-07:00`, end: `${today}T09:30:00-07:00`, all_day: false, cancelled: false, links: [] },
      ] },
      { date: yesterday, focused_seconds: 0, notes: [
        { id: 21, content: 'Yesterday entry', tags: [], parent_id: null, position: 0 },
      ], events: [] },
    ],
  } }));
  await page.goto('/');
  const from = page.locator('[data-item-id="11"] > div > [role="group"]');
  await expect(page.getByRole('group', { name: 'Yesterday entry', exact: true })).toBeVisible();
  await from.focus();
  await expect(from).toBeFocused();
  await page.evaluate(() => {
    const text = (id: number) => {
      const paragraph = document.querySelector(`[data-item-id="${id}"] > div > [role="group"] p`)!;
      return document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode()!;
    };
    // From the first entry of one date through to an entry of the one before.
    getSelection()!.setBaseAndExtent(text(11), 0, text(21), 15);
  });
  await page.keyboard.press('Meta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
    '## Sep 24, 2026',
    '- Today entry',
    '  - Today child',
    '## Sep 23, 2026',
    '- Yesterday entry',
  ].join('\n'));
});

test('a selection across dates takes in the events it covers', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null, tasks: [],
    days: [
      { date: today, focused_seconds: 0, notes: [{ id: 11, content: 'Today entry', tags: [], parent_id: null, position: 0 }], events: [
        { id: 'standup', title: 'Standup', start: `${today}T09:00:00-07:00`, end: `${today}T09:30:00-07:00`, all_day: false, cancelled: false, links: [] },
      ] },
      { date: yesterday, focused_seconds: 0, notes: [{ id: 21, content: 'Yesterday entry', tags: [], parent_id: null, position: 0 }], events: [] },
    ],
  } }));
  await page.goto('/');
  const event = page.getByText('Standup (9 AM – 9:30 AM)', { exact: true });
  await expect(event).toBeVisible();
  const last = page.locator('[data-item-id="21"] > div > [role="group"]');
  await last.focus();
  await expect(last).toBeFocused();
  await page.evaluate(() => {
    const start = document.querySelector('[data-calendar-event-title]')!;
    const paragraph = document.querySelector('[data-item-id="21"] > div > [role="group"] p')!;
    const end = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStartBefore(start); range.setEnd(end, 15);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press('Meta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
    '## Sep 24, 2026',
    '- Standup (9 AM – 9:30 AM)',
    '- Today entry',
    '## Sep 23, 2026',
    '- Yesterday entry',
  ].join('\n'));
});
