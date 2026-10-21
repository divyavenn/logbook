import { expect, test, type Page } from './fixtures';

const select = async (page: Page, fromId: number, toId: number) => {
  // Focus a row first: the editor pulls a selection made over its own document
  // back into itself.
  await page.locator(`[data-item-id="${toId}"] [role="group"]`).focus();
  await page.evaluate(({ fromId, toId }) => {
    const from = document.querySelector(`[data-item-id="${fromId}"] [role="group"]`)!;
    const to = document.querySelector(`[data-item-id="${toId}"] [role="group"]`)!;
    const range = document.createRange(); range.setStartBefore(from); range.setEndAfter(to);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  }, { fromId, toId });
};
const rows = async (page: Page) =>
  ((await (await page.request.get('/api/export')).json()).notes as Array<{ id: number; content: string; parent_id: number | null; position: number }>);

test('copying selected entries takes their children as a markdown list', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const make = async (content: string, parent_id: number | null = null) =>
    (await request.post('/api/notes', { data: { date: today, content, parent_id } })).json();
  const first = await make('Copy first');
  await make('Copy child', first.id);
  const second = await make('Copy second');
  await make('Copy untouched');
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Copy untouched', exact: true })).toBeVisible();

  await select(page, first.id, second.id);
  await expect(page.locator(`[data-item-id="${first.id}"]`)).toHaveAttribute('data-range-selected', 'true');
  await page.keyboard.press('Meta+c');
  // The branch comes along, indented, and nothing outside the selection does.
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('- Copy first\n  - Copy child\n- Copy second');
});

test('selecting whole entries selects them and acts on all at once', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const make = async (content: string) => (await request.post('/api/notes', { data: { date: today, content } })).json();
  const anchor = await make('Group anchor');
  const first = await make('Group first');
  const second = await make('Group second');
  await page.goto('/');

  await expect(page.getByRole('group', { name: 'Group second', exact: true })).toBeVisible();
  await select(page, first.id, second.id);
  const firstRow = page.locator(`[data-item-id="${first.id}"]`);
  const secondRow = page.locator(`[data-item-id="${second.id}"]`);
  await expect(firstRow).toHaveAttribute('data-range-selected', 'true');
  await expect(secondRow).toHaveAttribute('data-range-selected', 'true');
  await expect(page.locator(`[data-item-id="${anchor.id}"]`)).not.toHaveAttribute('data-range-selected', 'true');

  // Bold applies to every selected entry.
  await page.keyboard.press('Meta+b');
  await expect.poll(async () => (await rows(page)).filter(row => row.content.startsWith('**')).map(row => row.content).sort())
    .toEqual(['**Group first**', '**Group second**']);

  // Tab indents them together under the entry above, keeping their order.
  await select(page, first.id, second.id);
  await expect(firstRow).toHaveAttribute('data-range-selected', 'true');
  await page.keyboard.press('Tab');
  await expect.poll(async () => {
    const all = await rows(page);
    return all.filter(row => row.parent_id === anchor.id).sort((a, b) => a.position - b.position).map(row => row.content);
  }).toEqual(['**Group first**', '**Group second**']);

  // Backspace removes them all.
  await select(page, first.id, second.id);
  await expect(firstRow).toHaveAttribute('data-range-selected', 'true');
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await rows(page)).map(row => row.content)).toEqual(['Group anchor']);
});
