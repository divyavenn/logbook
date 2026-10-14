import { expect, test } from './fixtures';

test('continuous typing keeps the new row and caret in the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 540 });
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'New note', exact: true });
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
      await expect(page.getByRole('textbox', { name: kind === 'notes' ? 'New note' : 'New task', exact: true })).toBeFocused();
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
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit task', exact: true });
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
  await expect(page.getByRole('group', { name: 'Empty note', exact: true })).toBeVisible();
  await page.keyboard.type('Edited ');
  await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
  await expect.poll(async () => {
    const rows = (await (await request.get('/api/export')).json()).notes as Array<{ id: number; content: string; parent_id: number | null }>;
    return { content: rows.find(row => row.id === parent.id)?.content, parent: rows.find(row => row.id === child.id)?.parent_id };
  }).toEqual({ content: 'Edited Keep the parent', parent: parent.id });
  await page.reload();
  const empty = page.getByRole('group', { name: 'Empty note', exact: true });
  // Reload may restore this row's active editor from its durable draft.
  const edited = page.locator(`[data-kind="notes"][data-item-id="${parent.id}"]`);
  await expect(empty).toBeVisible();
  await expect(edited).toContainText('Edited Keep the parent');
  expect((await empty.boundingBox())!.y).toBeLessThan((await edited.boundingBox())!.y);
});

test('partial selection joins unselected text and preserves children of deleted entries', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const first = await (await request.post('/api/notes', { data: { date: today, content: 'Keep delete' } })).json();
  const middle = await (await request.post('/api/notes', { data: { date: today, content: 'Remove middle' } })).json();
  const child = await (await request.post('/api/notes', { data: { date: today, content: 'Keep nested child', parent_id: middle.id } })).json();
  const last = await (await request.post('/api/notes', { data: { date: today, content: 'gone tail' } })).json();
  await page.goto('/');
  await page.getByRole('group', { name: 'gone tail', exact: true }).focus();
  await page.evaluate(({ first, last }) => {
    const text = (id: number) => document.querySelector(`[data-item-id="${id}"] > div > [role="group"] p`)!.firstChild!;
    const selection = getSelection()!;
    selection.setBaseAndExtent(text(last), 5, text(first), 5);
  }, { first: first.id, last: last.id });
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('textbox', { name: 'Edit note', exact: true })).toHaveText('Keep tail');
  await expect.poll(async () => {
    const rows = (await (await request.get('/api/export')).json()).notes as Array<{ id: number; content: string; parent_id: number | null }>;
    return rows.map(row => [row.id, row.content, row.parent_id]);
  }).toEqual([[first.id, 'Keep tail', null], [child.id, 'Keep nested child', null]]);
  await page.keyboard.press('Meta+z');
  await expect(page.getByRole('group', { name: 'Keep delete', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Remove middle', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'gone tail', exact: true })).toBeVisible();
});

test('a completion can reverse while its first request and pie animation are in flight', async ({ page, request }) => {
  const parent = await (await request.post('/api/tasks', { data: { content: 'Interruptible parent' } })).json();
  const child = await (await request.post('/api/tasks', { data: { content: 'Toggle again', parent_id: parent.id } })).json();
  await request.post('/api/tasks', { data: { content: 'Later child', parent_id: parent.id } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/tasks/${child.id}/complete*`, async route => { await gate; await route.continue(); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand Interruptible parent', exact: true }).click();
  const progress = page.getByRole('button', { name: 'Collapse Interruptible parent', exact: true });
  try {
    const completing = page.waitForRequest(request => request.url().includes(`/tasks/${child.id}/complete`));
    await page.getByRole('button', { name: 'Complete Toggle again', exact: true }).click();
    await completing;
    await expect(progress).toHaveAttribute('aria-description', '1 of 2 children completed');
    const reverse = page.getByRole('button', { name: 'Reopen Toggle again', exact: true });
    await expect(reverse).toBeEnabled();
    await reverse.click();
    await expect(progress).toHaveAttribute('aria-description', '0 of 2 children completed');
    const reopened = page.waitForResponse(response => response.url().includes(`/tasks/${child.id}/reopen`));
    release();
    expect((await reopened).ok()).toBe(true);
    await expect(page.getByRole('button', { name: 'Complete Toggle again', exact: true })).toBeEnabled();
    await expect(progress).toHaveAttribute('aria-description', '0 of 2 children completed');
  } finally { release(); }
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
  const editor = page.getByRole('textbox', { name: 'New note', exact: true });
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

for (const action of ['typing', 'cut', 'paste'] as const) {
  test(`partial cross-entry ${action} preserves the unselected ends and formatting`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const first = await (await request.post('/api/notes', { data: { date: today, content: '**Keep** remove' } })).json();
    const last = await (await request.post('/api/notes', { data: { date: today, content: 'gone *tail*' } })).json();
    await page.goto('/');
    await page.getByRole('group', { name: 'Keep remove', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
    await expect(editor).toBeFocused();
    await editor.press('Meta+ArrowDown');
    await page.evaluate(({ first, last }) => {
      const start = document.querySelector(`[data-item-id="${first}"] [contenteditable] p`)!.lastChild!;
      const end = document.querySelector(`[data-item-id="${last}"] > div > [role="group"] p`)!.firstChild!;
      getSelection()!.setBaseAndExtent(start, 1, end, 5);
    }, { first: first.id, last: last.id });
    await expect.poll(() => page.evaluate(() => {
      const selection = getSelection()!;
      return [selection.anchorNode?.textContent, selection.anchorOffset, selection.focusNode?.textContent, selection.focusOffset];
    })).toEqual([' remove', 1, 'gone ', 5]);
    if (action === 'typing') await page.keyboard.type('new ');
    else {
      const copied = await editor.evaluate((element, action) => {
        const clipboardData = new DataTransfer();
        if (action === 'paste') {
          clipboardData.setData('text/plain', 'new ');
          clipboardData.setData('text/html', '<strong>new </strong>');
        }
        element.dispatchEvent(new ClipboardEvent(action, { bubbles: true, cancelable: true, clipboardData }));
        return clipboardData.getData('text/plain');
      }, action);
      if (action === 'cut') expect(copied).toBe('remove\ngone ');
    }
    await expect(editor).toHaveText(action === 'cut' ? 'Keep tail' : 'Keep new tail');
    await expect(editor.locator('strong').first()).toHaveText(/Keep/);
    await expect(editor.locator('em')).toHaveText('tail');
    await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
    await expect.poll(async () => {
      const rows = (await (await request.get('/api/export')).json()).notes as Array<{ id: number }>;
      return rows.map(row => row.id);
    }).toEqual([first.id]);
  });
}

test('parent tasks switch from a circle-caret SVG to an uninterrupted pie and reverse smoothly', async ({ page, request }) => {
  const parent = await (await request.post('/api/tasks', { data: { content: 'Parent with three subtasks' } })).json();
  for (const content of ['First subtask', 'Second subtask', 'Third subtask']) {
    await request.post('/api/tasks', { data: { content, parent_id: parent.id } });
  }
  await request.post('/api/tasks', { data: { content: 'Task without children' } });
  await page.goto('/');
  const ring = page.getByRole('button', { name: 'Expand Parent with three subtasks', exact: true });
  await expect(ring.locator('svg')).toHaveCSS('opacity', '1');
  await expect(ring.locator('svg')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  const bubble = await page.getByRole('button', { name: 'Complete Task without children', exact: true }).evaluate(element => {
    const style = getComputedStyle(element, '::before');
    const border = parseFloat(style.borderTopWidth);
    return { width: parseFloat(style.width) + border * 2, height: parseFloat(style.height) + border * 2, stroke: style.borderTopWidth };
  });
  await expect(ring.locator('svg')).toHaveCSS('width', `${bubble.width}px`);
  await expect(ring.locator('svg')).toHaveCSS('height', `${bubble.height}px`);
  await expect(ring.locator('svg')).toHaveCSS('overflow', 'hidden');
  await expect(ring.locator('svg path')).toHaveCSS('stroke-width', bubble.stroke);
  await expect(ring.locator('svg path')).toHaveAttribute('d', 'M9.009 .818A6.5 6.5 0 1 0 9.009 13.182C10.435 12.718 12.549 9.049 13.299 7.75A1.5 1.5 0 0 0 13.299 6.25C12.549 4.951 10.435 1.282 9.009 .818Z');
  const outline = await ring.locator('svg path').evaluate(element => {
    const bounds = (element as SVGPathElement).getBBox();
    const stroke = parseFloat(getComputedStyle(element).strokeWidth);
    return {
      width: bounds.width + stroke, height: bounds.height + stroke,
      left: bounds.x - stroke / 2, right: bounds.x + bounds.width + stroke / 2,
    };
  });
  expect(outline.width).toBeLessThanOrEqual(bubble.width + .001);
  expect(outline.height).toBeLessThanOrEqual(bubble.height + .001);
  expect(outline.left).toBeGreaterThanOrEqual(-.001);
  expect(outline.right).toBeLessThanOrEqual(bubble.width + .001);
  expect(await ring.evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return { radius: style.borderRadius, opacity: style.opacity, angle: style.getPropertyValue('--task-progress') };
  })).toEqual({ radius: '50%', opacity: '0', angle: '0deg' });
  await page.mouse.move(1000, 600);
  await expect(page.getByTestId('auth-surface')).toHaveCSS('filter', 'blur(0px)');
  await expect(page.getByTestId('tag-backdrop')).toHaveCSS('opacity', '0');
  await page.locator('[data-outline-kind="tasks"]').screenshot({ path: 'test-results/parent-task-collapsed.png' });
  await ring.click();
  const progress = page.getByRole('button', { name: 'Collapse Parent with three subtasks', exact: true });
  const angle = () => progress.evaluate(element => parseFloat(getComputedStyle(element, '::before').getPropertyValue('--task-progress')));
  const checkbox = page.getByRole('button', { name: 'Complete First subtask', exact: true });
  await checkbox.focus();
  await page.keyboard.press('Space');
  // Inspect the actual CSS transition at 10% playback speed.
  await progress.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.updatePlaybackRate(.1)));
  await expect.poll(angle).toBeGreaterThan(1);
  const partial = await angle();
  expect(partial).toBeLessThan(120);
  await page.keyboard.press('Space');
  await expect(progress).toHaveAttribute('aria-description', '0 of 3 children completed');
  const reversing = await angle();
  expect(reversing).toBeLessThan(120);
  await expect.poll(angle).toBe(0);
  await expect(progress.locator('svg')).toHaveCSS('opacity', '1');
  await expect(progress.locator('svg')).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
  await expect(progress.locator('svg')).toHaveCSS('filter', 'blur(0px)');
  await expect(progress.locator('svg')).toHaveCSS('scale', '1');
  await expect(page.getByRole('button', { name: 'Complete First subtask', exact: true })).toBeFocused();
  await page.screenshot({ path: 'test-results/parent-task-marker.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Space');
  await expect.poll(angle).toBe(120);
  await expect(progress).toHaveAttribute('aria-description', '1 of 3 children completed');
  await expect(progress.locator('svg')).toHaveCSS('opacity', '0');
  expect(await progress.evaluate(element => getComputedStyle(element, '::before').opacity)).toBe('1');
  await page.screenshot({ path: 'test-results/parent-task-progress.png' });
});

for (const kind of ['notes', 'tasks'] as const) {
  test(`whole ${kind} entry highlight supports formatting and clipboard edits without text highlighting`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const item = await (await request.post(`/api/${kind}`, { data: { date: today, content: 'First line\\\nSecond line' } })).json();
    await page.goto('/');
    const row = page.locator(`[data-kind="${kind}"][data-item-id="${item.id}"]`);
    await row.getByRole('group').click();
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit task', exact: true });
    const selectEntry = async () => {
      await editor.press('Meta+ArrowDown');
      const box = (await editor.boundingBox())!;
      await editor.dblclick({ position: { x: box.width - 5, y: box.height - 8 } });
      await expect(row).toHaveAttribute('data-gesture-selected', 'true');
    };
    const copyOrCut = (type: 'copy' | 'cut') => editor.evaluate((element, type) => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData }));
      return { text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') };
    }, type);
    await selectEntry();
    await expect.poll(() => editor.locator('p').evaluate(element => getComputedStyle(element, '::selection').backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await editor.press('Meta+b');
    await expect(row).toHaveAttribute('data-gesture-selected', 'true');
    expect((await editor.locator('strong').allTextContents()).join('')).toBe('First lineSecond line');
    await editor.press('Meta+i');
    await expect(row).toHaveAttribute('data-gesture-selected', 'true');
    expect((await editor.locator('em').allTextContents()).join('')).toBe('First lineSecond line');
    const copied = await copyOrCut('copy');
    expect(copied.text).toBe('First line\nSecond line');
    expect(copied.html).toContain('<strong>');
    expect(copied.html).toContain('<em>');
    await page.screenshot({ path: `test-results/selected-${kind}-entry.png` });
    await editor.evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'Pasted replacement');
      clipboardData.setData('text/html', '<u>Pasted replacement</u>');
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
    await expect(editor).toHaveText('Pasted replacement');
    await expect(editor.locator('u')).toHaveText('Pasted replacement');
    await expect(row).not.toHaveAttribute('data-gesture-selected', 'true');
    await selectEntry();
    await page.keyboard.type('Typed replacement');
    await expect(editor).toHaveText('Typed replacement');
    await expect(row).not.toHaveAttribute('data-gesture-selected', 'true');
    await selectEntry();
    expect((await copyOrCut('cut')).text).toBe('Typed replacement');
    await expect(row).toHaveCount(0);
    await expect.poll(async () => (await (await request.get('/api/export')).json())[kind].some((row: { id: number }) => row.id === item.id)).toBe(false);
  });
}

test('inline tag pills sit slightly lower in both saved text and the editor', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Text with #focus tag', tags: ['focus'] } });
  await page.goto('/');
  const saved = page.getByRole('group', { name: 'Text with #focus tag', exact: true });
  await expect(saved.locator('[data-tag="focus"]')).toHaveCSS('translate', '0px 1px');
  await saved.click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await expect(editor.locator('[data-tag="focus"]')).toHaveCSS('translate', '0px 1px');
  await expect(page.getByTestId('tag-backdrop')).toHaveCSS('opacity', '0');
  await editor.screenshot({ path: 'test-results/inline-tag-alignment.png' });
});

test('search can reopen during its exit transition without losing keyboard focus', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'New note', exact: true })).toBeFocused();
  await page.keyboard.press('Meta+f');
  const dialog = page.getByRole('dialog', { name: 'Search journal', exact: true });
  const search = dialog.getByRole('textbox');
  await expect(search).toBeFocused();
  const original = await dialog.elementHandle();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+f');
  await expect(search).toBeFocused();
  expect(await dialog.evaluate((element, original) => element === original, original)).toBe(true);
  await search.pressSequentially('Immediately usable');
  await expect(search).toHaveValue('Immediately usable');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'New note', exact: true })).toBeFocused();
});
