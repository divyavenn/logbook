import { expect, test } from './fixtures';

for (const filtered of [false, true]) {
  test(`typing from an idle ${filtered ? 'tag view' : 'logbook'} starts a note without a prefilled bullet`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    await request.post('/api/notes', { data: { date: today, content: 'Existing note', tags: ['idle'] } });
    await request.post('/api/tasks', { data: { content: 'Existing task', tags: ['idle'] } });
    await page.goto('/');
    await expect(page.getByRole('group', { name: 'Existing note', exact: true })).toBeVisible();
    if (filtered) {
      const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
      await rail.hover();
      await rail.getByRole('button', { name: '#idle', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Existing task', exact: true })).toBeVisible();
    }
    await expect(page.locator('[contenteditable="true"]:focus')).toHaveCount(0);
    await expect(page.locator('[data-item-id="draft"] [data-tag]')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('[contenteditable="true"]:focus')).toHaveCount(0);
    await page.keyboard.type('A fresh thought');
    const composer = page.getByRole('textbox', { name: 'New note', exact: true });
    await expect(composer).toBeFocused();
    await expect(composer).toContainText('A fresh thought');
    await composer.press('Enter');
    await expect.poll(async () => {
      const notes = (await (await request.get('/api/export')).json()).notes;
      return notes.find((note: { content: string }) => note.content.startsWith('A fresh thought'))?.tags;
    }).toEqual(filtered ? ['idle'] : []);
  });
}

for (const kind of ['note', 'task'] as const) {
  test(`children of a tagged ${kind} keep their own tags when edited and when adding siblings`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const create = async (content: string, tags: string[], parent_id: number | null = null) =>
      (await request.post(`/api/${kind}s`, { data: { content, tags, parent_id, ...(kind === 'note' ? { date: today } : {}) } })).json();
    const parent = await create('Tagged parent', ['family']);
    const child = await create('Untagged child', [], parent.id);
    const taggedChild = await create('Child with another tag', ['other'], parent.id);
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
    await rail.hover();
    await rail.getByRole('button', { name: '#family', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Tagged parent', exact: true }).click();
    for (const item of [child, taggedChild]) {
      await page.getByRole('group', { name: item.content, exact: true }).click();
      const editor = page.getByRole('textbox', { name: `Edit ${kind}`, exact: true });
      await expect(editor.locator('[data-tag="family"]')).toHaveCount(0);
      await editor.press('Meta+ArrowDown');
      await editor.pressSequentially(' edited');
      await editor.evaluate(element => (element as HTMLElement).blur());
      await expect.poll(async () => {
        const rows = (await (await request.get('/api/export')).json())[`${kind}s`];
        const row = rows.find((row: { id: number }) => row.id === item.id);
        return { tags: row.tags, edited: row.content.includes('edited') };
      }).toEqual({ tags: item.tags, edited: true });
    }
    await page.getByRole('group', { name: 'Untagged child edited', exact: true }).click();
    await page.getByRole('textbox', { name: `Edit ${kind}`, exact: true }).press('Meta+ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.type('New sibling');
    await page.keyboard.press('Enter');
    await expect.poll(async () => {
      const rows = (await (await request.get('/api/export')).json())[`${kind}s`];
      const row = rows.find((row: { content: string }) => row.content.startsWith('New sibling'));
      return row && { tags: row.tags, parent_id: row.parent_id };
    }).toEqual({ tags: [], parent_id: parent.id });
    await expect(page.getByRole('group', { name: 'New sibling', exact: true })).toBeVisible();
    await page.reload();
    await rail.hover();
    await rail.getByRole('button', { name: '#family', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Tagged parent', exact: true }).click();
    await expect(page.getByRole('group', { name: 'New sibling', exact: true })).toBeVisible();
  });
}

test('typing after leaving an entry starts a separate entry in the same writing area', async ({ page, request }) => {
  await request.post('/api/tasks', { data: { content: 'Original task' } });
  await page.goto('/');
  await page.getByRole('group', { name: 'Original task', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit task', exact: true });
  await editor.press('Meta+ArrowDown');
  await editor.pressSequentially(' edited');
  await editor.evaluate(element => (element as HTMLElement).blur());
  await page.keyboard.type('Next task');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await (await request.get('/api/export')).json()).tasks.map((row: { content: string }) => row.content))
    .toEqual(['Original task edited', 'Next task']);
});

test('typing in an empty tasks pane creates a task and switching to the log creates a note', async ({ page, request }) => {
  await page.setViewportSize({ width: 440, height: 400 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'tasks', exact: true }).click();
  await expect(page.locator('[contenteditable="true"]:focus')).toHaveCount(0);
  await page.keyboard.type('Task in its pane');
  await expect(page.getByRole('textbox', { name: 'New task', exact: true })).toHaveText('Task in its pane');
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'log', exact: true }).click();
  await page.keyboard.type('Note in its pane');
  await expect(page.getByRole('textbox', { name: 'New note', exact: true })).toHaveText('Note in its pane');
  await page.keyboard.press('Enter');
  await expect.poll(async () => {
    const data = await (await request.get('/api/export')).json();
    return [data.tasks[0]?.content, data.notes[0]?.content];
  }).toEqual(['Task in its pane', 'Note in its pane']);
});

for (const kind of ['note', 'task'] as const) {
  test(`removing a child's own tag keeps the ${kind} visible through its tagged parent`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const data = { tags: ['family'], ...(kind === 'note' ? { date: today } : {}) };
    const parent = await (await request.post(`/api/${kind}s`, { data: { ...data, content: 'Tagged parent' } })).json();
    const child = await (await request.post(`/api/${kind}s`, { data: { ...data, content: 'Tagged child #family', parent_id: parent.id } })).json();
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
    await rail.hover();
    await rail.getByRole('button', { name: '#family', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Tagged parent', exact: true }).click();
    await page.getByRole('group', { name: 'Tagged child', exact: true }).click();
    const editor = page.getByRole('textbox', { name: `Edit ${kind}`, exact: true });
    await editor.locator('[data-tag="family"]').click();
    await page.keyboard.press('Backspace');
    await editor.evaluate(element => (element as HTMLElement).blur());
    await expect.poll(async () => {
      const rows = (await (await request.get('/api/export')).json())[`${kind}s`];
      return rows.find((row: { id: number }) => row.id === child.id)?.tags;
    }).toEqual([]);
    await expect(page.getByRole('group', { name: 'Tagged child', exact: true })).toBeVisible();
    await expect(page.locator(`[data-item-id="${child.id}"]`)).toHaveCSS('opacity', '1');
    // Deleting this inherited entry must actually remove it, rather than
    // merely hiding it until the next refresh.
    await page.getByRole('group', { name: 'Tagged child', exact: true }).click();
    const box = (await editor.boundingBox())!;
    await editor.dblclick({ position: { x: box.width - 5, y: 12 } });
    await page.keyboard.press('Backspace');
    await expect.poll(async () => {
      const rows = (await (await request.get('/api/export')).json())[`${kind}s`];
      return rows.some((row: { id: number }) => row.id === child.id);
    }).toBe(false);
  });
}
