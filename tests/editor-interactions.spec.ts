import { expect, test } from './fixtures';

test('continuous typing keeps the new row and caret in the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 540 });
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await editor.click();
  for (let row = 1; row <= 30; row++) {
    await page.keyboard.type(`Line ${row}`);
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('group', { name: /^Line \d+$/ })).toHaveCount(30);
  await expect(editor).toBeFocused();
  await expect(editor).toBeInViewport();
});

for (const kind of ['notes', 'tasks'] as const) {
  test(`rapid Enter and Tab keep ${kind} siblings in place while a save is delayed`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const parent = await (await request.post(`/api/${kind}`, { data: { date: today, content: 'Anchor' } })).json();
    await request.post(`/api/${kind}`, { data: { date: today, content: 'Later', after_id: parent.id } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await page.route('**/api/document/edit*', async route => {
      if (!held && route.request().postDataJSON().changes.some((change: { content?: string }) => change.content === 'First')) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await page.goto('/');
    await page.getByRole('group', { name: 'Anchor', exact: true }).click();
    await page.keyboard.press('Meta+ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('First');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('After');
    await page.keyboard.press('Enter');
    try {
      await expect(page.getByRole('group', { name: 'First', exact: true }).locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '1');
      await expect(page.getByRole('group', { name: 'Second', exact: true }).locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '1');
      await expect(page.getByRole('group', { name: 'After', exact: true }).locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '0');
      await expect(page.getByRole('textbox', { name: kind === 'notes' ? 'New journal bullet' : 'New to-do', exact: true })).toBeFocused();
    } finally { release(); }
    await expect.poll(async () => {
      const rows = (await (await request.get('/api/export')).json())[kind] as Array<{ content: string; parent_id: number | null; position: number }>;
      return rows.sort((a, b) => (a.parent_id ?? 0) - (b.parent_id ?? 0) || a.position - b.position).map(row => [row.content, row.parent_id]);
    }).toEqual([['Anchor', null], ['After', null], ['Later', null], ['First', parent.id], ['Second', parent.id]]);
  });

  test(`Backspace outdents ${kind} one level at a time before joining the previous visible entry`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const root = await (await request.post(`/api/${kind}`, { data: { date: today, content: 'Root' } })).json();
    const parent = await (await request.post(`/api/${kind}`, { data: { date: today, content: 'Parent', parent_id: root.id } })).json();
    const child = await (await request.post(`/api/${kind}`, { data: { date: today, content: 'Child', parent_id: parent.id } })).json();
    await page.goto('/');
    await page.getByRole('button', { name: 'Expand Root', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Parent', exact: true }).click();
    await page.getByRole('group', { name: 'Child', exact: true }).click();
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit to-do', exact: true });
    await page.keyboard.press('Meta+ArrowUp');
    await page.keyboard.press('Backspace');
    await expect(editor.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '1');
    await expect(editor).toHaveText('Child');
    await page.keyboard.press('Backspace');
    await expect(editor.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '0');
    await page.keyboard.press('Backspace');
    await expect(editor).toHaveText('ParentChild');
    await page.keyboard.type('!');
    await expect(editor).toHaveText('Parent!Child');
    await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
    await expect.poll(async () => {
      const rows = (await (await request.get('/api/export')).json())[kind] as Array<{ id: number; content: string; parent_id: number | null }>;
      return { parent: rows.find(row => row.id === parent.id)?.content, childExists: rows.some(row => row.id === child.id) };
    }).toEqual({ parent: 'Parent!Child', childExists: false });
  });
}

test('double-click at the end selects an entry for deletion and preserves its children', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Previous' } });
  const parent = await (await request.post('/api/notes', { data: { date: today, content: 'Select this whole entry' } })).json();
  await request.post('/api/notes', { data: { date: today, content: 'Keep this child', parent_id: parent.id } });
  await page.goto('/');
  await page.getByRole('group', { name: 'Select this whole entry', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await editor.press('Meta+ArrowDown');
  const box = (await editor.boundingBox())!;
  await editor.dblclick({ position: { x: box.width - 5, y: 12 } });
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('Select this whole entry');
  await page.keyboard.press('Backspace');
  await expect(editor).toHaveText('Previous');
  await page.keyboard.type('!');
  await expect(editor).toHaveText('Previous!');
  await expect(page.getByRole('group', { name: 'Keep this child', exact: true }).locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '0');
  await expect.poll(async () => (await (await request.get('/api/export')).json()).notes.some((row: { id: number }) => row.id === parent.id)).toBe(false);
});

test('Enter at the beginning of a parent preserves its children and sibling position', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const parent = await (await request.post('/api/notes', { data: { date: today, content: 'Keep the parent' } })).json();
  const child = await (await request.post('/api/notes', { data: { date: today, content: 'Still nested', parent_id: parent.id } })).json();
  await request.post('/api/notes', { data: { date: today, content: 'Following sibling' } });
  await page.goto('/');
  await page.getByRole('group', { name: 'Keep the parent', exact: true }).click();
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Edited ');
  await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
  await expect.poll(async () => {
    const rows = (await (await request.get('/api/export')).json()).notes as Array<{ id: number; content: string; parent_id: number | null }>;
    return { content: rows.find(row => row.id === parent.id)?.content, parent: rows.find(row => row.id === child.id)?.parent_id };
  }).toEqual({ content: 'Edited Keep the parent', parent: parent.id });
});

test('a selected entry can be dragged before a sibling without losing focus or text', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'First sibling' } });
  await request.post('/api/notes', { data: { date: today, content: 'Second sibling' } });
  await page.goto('/');
  await page.getByRole('group', { name: 'Second sibling', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  const box = (await editor.boundingBox())!;
  await editor.dblclick({ position: { x: box.width - 5, y: 12 } });
  const selected = editor.locator('xpath=ancestor::li[1]');
  await expect(selected).toHaveAttribute('draggable', 'true');
  const target = page.getByRole('group', { name: 'First sibling', exact: true });
  await selected.dragTo(target, { sourcePosition: { x: 8, y: 12 }, targetPosition: { x: 8, y: 2 } });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('Second sibling');
  await expect.poll(async () => {
    const rows = (await (await request.get('/api/export')).json()).notes as Array<{ content: string; position: number }>;
    return rows.sort((a, b) => a.position - b.position).map(row => row.content);
  }).toEqual(['Second sibling', 'First sibling']);
});

test('a failed save shakes its entry, logs the error, and recovers the queued text after reload', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/api/document/edit*', route => route.fulfill({ status: 503, json: { detail: 'Save temporarily unavailable' } }));
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await editor.fill('Keep my unsaved entry');
  await editor.press('Enter');
  const entry = page.getByRole('group', { name: 'Keep my unsaved entry', exact: true }).locator('xpath=ancestor::li[1]');
  await expect(entry).toHaveAttribute('data-entry-error', 'true');
  expect(errors.some(error => error.includes('Entry edit failed'))).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Save temporarily unavailable' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry saving' })).toHaveCount(0);
  await page.unroute('**/api/document/edit*');
  await page.reload();
  await expect.poll(async () => (await (await request.get('/api/export')).json()).notes.map((row: { content: string }) => row.content)).toEqual(['Keep my unsaved entry']);
});
