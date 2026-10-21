import { expect, test } from './fixtures';

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
