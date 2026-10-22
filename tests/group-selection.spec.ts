import { expect, test, type Page } from './fixtures';

const span = async (page: Page, fromId: number, toId: number) => {
  // The selection has to belong to the page, not to an open entry.
  const row = page.locator(`[data-item-id="${fromId}"] > div > [role="group"]`);
  await row.focus();
  await expect(row).toBeFocused();
  await page.evaluate(({ fromId, toId }) => {
    const text = (id: number) => {
      const paragraph = document.querySelector(`[data-item-id="${id}"] > div > [role="group"] p`)!;
      return document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode()!;
    };
    const from = text(fromId), to = text(toId);
    // Part of the first entry through part of the last: an ordinary highlight.
    getSelection()!.setBaseAndExtent(from, 2, to, 3);
  }, { fromId, toId });
};
const notes = async (page: Page) =>
  ((await (await page.request.get('/api/export')).json()).notes as Array<{ id: number; content: string; parent_id: number | null; position: number }>);

test('a shortcut over a selection spanning entries applies to all of them', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const make = async (content: string) => (await request.post('/api/notes', { data: { date: today, content } })).json();
  const above = await make('Above the span');
  const first = await make('Spanned first');
  const second = await make('Spanned second');
  const outside = await make('Outside the span');
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Outside the span', exact: true })).toBeVisible();

  await span(page, first.id, second.id);
  await page.keyboard.press('Meta+b');
  await expect.poll(async () => (await notes(page)).filter(row => row.content.startsWith('**')).map(row => row.content).sort())
    .toEqual(['**Spanned first**', '**Spanned second**']);

  await span(page, first.id, second.id);
  await page.keyboard.press('Tab');
  // Both indent under the entry above, keeping their order, and nothing else moves.
  await expect.poll(async () => (await notes(page))
    .filter(row => row.parent_id === above.id).sort((a, b) => a.position - b.position).map(row => row.content))
    .toEqual(['**Spanned first**', '**Spanned second**']);
  expect((await notes(page)).find(row => row.id === outside.id)?.parent_id).toBe(null);

  await span(page, first.id, second.id);
  await page.keyboard.press('Shift+Tab');
  await expect.poll(async () => (await notes(page)).filter(row => row.parent_id === above.id).length).toBe(0);
});

test('a selected entry copies with its children as a markdown list', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const make = async (content: string, parent_id: number | null = null) =>
    (await request.post('/api/notes', { data: { date: today, content, parent_id } })).json();
  const parent = await make('Copy parent');
  await make('Copy child', parent.id);
  await make('Copy untouched');
  await page.goto('/');

  await page.getByRole('group', { name: 'Copy parent', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  const box = (await editor.boundingBox())!;
  await editor.dblclick({ position: { x: box.width - 5, y: 12 } });
  await expect(editor.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-gesture-selected', 'true');
  await page.keyboard.press('Meta+c');
  // The branch comes along, indented, and nothing outside the entry does.
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('- Copy parent\n  - Copy child');
});

test('deleting a selected entry takes its children, while joining lines keeps them', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const make = async (content: string, parent_id?: number) =>
    (await request.post('/api/notes', { data: { date: today, content, parent_id } })).json();
  const parent = await make('Doomed parent');
  const child = await make('Doomed child', parent.id);
  await make('Doomed grandchild', child.id);
  await make('Above the join');
  const join = await make('Joined parent');
  await make('Surviving child', join.id);
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Joined parent', exact: true })).toBeVisible();

  // Selecting the entry and deleting takes the whole branch with it.
  await page.getByRole('group', { name: 'Doomed parent', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  const box = (await editor.boundingBox())!;
  await editor.dblclick({ position: { x: box.width - 5, y: 12 } });
  await expect(editor.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-gesture-selected', 'true');
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await notes(page)).map(row => row.content))
    .toEqual(['Above the join', 'Joined parent', 'Surviving child']);

  // Joining two lines is not a delete: the absorbed entry's child stays, and
  // rises to the slot the entry it hung from occupied.
  const joining = page.locator(`[data-item-id="${join.id}"] [role="group"]`).first();
  await joining.focus(); await joining.press('Enter');
  const reopened = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await reopened.press('Meta+ArrowUp'); await reopened.press('Backspace');
  await expect.poll(async () => (await notes(page)).map(row => [row.content, row.parent_id]))
    .toEqual([['Above the joinJoined parent', null], ['Surviving child', null]]);
});
