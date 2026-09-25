import { expect, test } from './fixtures';

test('new entries appear without entrance motion or blinking', async ({ page }) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await composer.fill('A steady arrival'); await composer.press('Enter');
  const entry = page.getByRole('group', { name: 'A steady arrival', exact: true }).locator('xpath=ancestor::li[1]');
  await expect(entry).toBeVisible();
  await expect(entry).toHaveCSS('opacity', '1');
  await expect(entry).toHaveCSS('animation-name', 'none');
});

test('midnight retires the previous day composer and leaves only today active', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-20T23:59:59-07:00') });
  let today = '2026-09-20';
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date(`${today}T23:59:59-07:00`).toISOString(), active_session: null,
    next_cursor: null, tags: [], tag: null, tasks: [],
    days: today === '2026-09-20'
      ? [{ date: '2026-09-20', focused_seconds: 0, notes: [] }]
      : [{ date: '2026-09-21', focused_seconds: 0, notes: [] }, { date: '2026-09-20', focused_seconds: 0, notes: [] }],
  } }));
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'New journal bullet', exact: true })).toHaveCount(1);
  today = '2026-09-21';
  await page.clock.runFor(2000);
  await expect(page.getByRole('textbox', { name: 'New journal bullet', exact: true })).toHaveCount(1);
  await expect(page.getByRole('region', { name: /2026-09-20/ }).getByRole('textbox')).toHaveCount(0);
});

test('outdenting keeps the returned revision so the next edit saves normally', async ({ page, request }) => {
  const parent = await (await request.post('/api/tasks', { data: { content: 'Revision parent' } })).json();
  const child = await (await request.post('/api/tasks', { data: { content: 'Revision child', parent_id: parent.id } })).json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand Revision parent', exact: true }).click();
  await page.getByRole('group', { name: 'Revision child', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit to-do', exact: true });
  await editor.press('Shift+Tab');
  await expect(editor).toBeFocused();
  await editor.fill('Revision child moved');
  await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
  await expect.poll(async () => {
    const rows = (await (await request.get('/api/export')).json()).tasks as Array<{ id: number; parent_id: number | null; content: string }>;
    return rows.find(row => row.id === child.id);
  }).toMatchObject({ parent_id: null, content: 'Revision child moved' });
  await expect(page.getByText('This entry was saved elsewhere. Reloaded the latest version.', { exact: true })).toHaveCount(0);
});

test('retired entry-jump shortcuts leave the active editor in place', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const first = await (await request.post('/api/notes', { data: { date: today, content: 'Stay in this entry' } })).json();
  await request.post('/api/notes', { data: { date: today, content: 'Do not jump here', after_id: first.id } });
  await page.goto('/');
  await page.getByRole('group', { name: 'Stay in this entry', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await editor.press('Meta+ArrowDown');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('Stay in this entry');
  await editor.press('Meta+ArrowUp');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('Stay in this entry');
});

test('vertical arrows keep their visual column across entries and stop at document edges', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const first = await (await request.post('/api/notes', { data: { date: today, content: 'abcdefghij' } })).json();
  const second = await (await request.post('/api/notes', { data: { date: today, content: 'abcdefghij', after_id: first.id } })).json();
  const third = await (await request.post('/api/notes', { data: { date: today, content: 'abcdefghij', after_id: second.id } })).json();
  await page.goto('/');
  const saved = (id: number) => page.locator(`[data-kind="notes"][data-item-id="${id}"] [role="group"]`).first();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  const setCaret = async (offset: number) => {
    await editor.evaluate((element, value) => {
      const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange(); range.setStart(node, value); range.collapse(true);
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }, offset);
    await page.waitForTimeout(20);
  };
  const caretOffset = () => editor.evaluate(element => {
    const selection = getSelection()!;
    const range = document.createRange(); range.selectNodeContents(element);
    range.setEnd(selection.focusNode!, selection.focusOffset);
    return range.toString().length;
  });

  const activeId = (id: number) => expect(editor.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-item-id', String(id));
  await saved(second.id).click(); await activeId(second.id); await setCaret(6); await editor.press('ArrowUp');
  await activeId(first.id); await expect.poll(caretOffset).toBe(6);
  await editor.press('ArrowDown'); await activeId(second.id); await expect.poll(caretOffset).toBe(6);

  await saved(first.id).click(); await activeId(first.id); await setCaret(6); await editor.press('ArrowUp');
  await expect.poll(caretOffset).toBe(0);
  await saved(third.id).click(); await activeId(third.id); await setCaret(6); await editor.press('ArrowDown');
  await expect.poll(caretOffset).toBe(10);
});

test('vertical arrows traverse wrapped lines before moving to a neighboring entry', async ({ page, request }) => {
  await page.setViewportSize({ width: 620, height: 900 });
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const content = 'one two three four five six seven eight nine ten '.repeat(5).trim();
  const wrapped = await (await request.post('/api/notes', { data: { date: today, content } })).json();
  await request.post('/api/notes', { data: { date: today, content: 'Neighbor below', after_id: wrapped.id } });
  await page.goto('/');
  await page.locator(`[data-kind="notes"][data-item-id="${wrapped.id}"] [role="group"]`).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  const active = editor.locator('xpath=ancestor::li[1]');
  await expect(active).toHaveAttribute('data-item-id', String(wrapped.id));
  expect((await editor.boundingBox())!.height).toBeGreaterThan(30);
  await editor.press('Meta+ArrowUp'); await editor.press('ArrowDown');
  await expect(active).toHaveAttribute('data-item-id', String(wrapped.id));
  const offset = await editor.evaluate(element => {
    const selection = getSelection()!;
    const range = document.createRange(); range.selectNodeContents(element);
    range.setEnd(selection.focusNode!, selection.focusOffset);
    return range.toString().length;
  });
  expect(offset).toBeGreaterThan(0);
  expect(offset).toBeLessThan(content.length);
});

for (const kind of ['notes', 'tasks'] as const) {
  test(`Enter splits ${kind} at the caret and carries formatted trailing text into the new entry`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const row = await (await request.post(`/api/${kind}`, { data: { date: today, content: 'Alpha **Omega**' } })).json();
    await page.goto('/');
    await page.locator(`[data-kind="${kind}"][data-item-id="${row.id}"] [role="group"]`).click();
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit to-do', exact: true });
    await expect(editor).toBeFocused();
    await editor.evaluate(element => {
      const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange(); range.setStart(node, node.textContent!.length); range.collapse(true);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await editor.press('Enter');
    const next = page.getByRole('textbox', { name: kind === 'notes' ? 'New journal bullet' : 'New to-do', exact: true });
    await expect(next).toBeFocused();
    await expect(next).toHaveText('Omega');
    await expect(next.locator('strong')).toHaveText('Omega');
    await expect(page.locator(`[data-kind="${kind}"]`).getByRole('group', { name: 'Alpha', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
    await expect.poll(async () => {
      const rows = (await (await request.get('/api/export')).json())[kind] as Array<{ content: string }>;
      return rows.map(item => item.content);
    }).toEqual(expect.arrayContaining(['Alpha', '**Omega**']));
  });

  test(`Enter keeps new ${kind} siblings focused and in order at root and nested levels`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    for (const nested of [false, true]) {
      const parent = nested ? await (await request.post(`/api/${kind}`, { data: { date: today, content: `Enter parent ${kind}` } })).json() : null;
      const data = { date: today, parent_id: parent?.id ?? null };
      const first = await (await request.post(`/api/${kind}`, { data: { ...data, content: `Enter first ${kind}` } })).json();
      const last = await (await request.post(`/api/${kind}`, { data: { ...data, content: `Enter last ${kind}`, after_id: first.id } })).json();
      await page.goto('/');
      if (nested) await page.getByRole('button', { name: `Expand Enter parent ${kind}`, exact: true }).click();
      const row = (id: number) => page.locator(`[data-kind="${kind}"][data-item-id="${id}"] [role="group"]`).first();
      await row(first.id).focus(); await row(first.id).press('Enter');
      const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit to-do', exact: true });
      await expect(editor).toBeFocused(); await editor.press('Meta+ArrowDown'); await editor.press('Enter');
      const composer = page.getByRole('textbox', { name: kind === 'notes' ? 'New journal bullet' : 'New to-do', exact: true });
      await expect(composer).toBeFocused(); await expect(composer).toBeEditable();
      await expect(composer.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', nested ? '1' : '0');
      const text = `Inserted ${nested ? 'nested' : 'root'} ${kind}`;
      await composer.pressSequentially(text); await composer.press('Enter');
      await expect(composer).toHaveText(''); await expect(composer).toBeFocused();
      const rows = (await (await request.get('/api/export')).json())[kind] as { id: number; parent_id: number | null; position: number; content: string }[];
      const inserted = rows.find(item => item.content === text)!;
      expect(inserted.parent_id).toBe(parent?.id ?? null);
      expect(inserted.position).toBeGreaterThan(rows.find(item => item.id === first.id)!.position);
      expect(inserted.position).toBeLessThan(rows.find(item => item.id === last.id)!.position);
      await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
      await expect(composer).toBeHidden();
      await row(inserted.id).focus(); await row(inserted.id).press('Enter');
      await expect(editor).toBeFocused(); await editor.fill('');
      await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
      await expect(editor).toBeHidden(); await expect(composer).toBeHidden();
      await expect.poll(async () => (await (await request.get('/api/export')).json())[kind].some((item: { id: number }) => item.id === inserted.id)).toBe(false);
    }
  });

  test(`Backspace joins ${kind} and continues into the preceding bullet from an empty draft`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const first = await (await request.post(`/api/${kind}`, { data: { date: today, content: `First ${kind}` } })).json();
    const second = await (await request.post(`/api/${kind}`, { data: { date: today, content: 'Second', after_id: first.id } })).json();
    await page.goto('/');
    const saved = (id: number) => page.locator(`[data-kind="${kind}"][data-item-id="${id}"] [role="group"]`).first();
    await saved(second.id).focus(); await saved(second.id).press('Enter');
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit to-do', exact: true });
    await expect(editor).toBeFocused();
    await editor.press('Meta+ArrowUp'); await editor.press('Backspace');
    await expect(editor).toHaveText(`First ${kind}Second`);
    await expect(editor).toBeEditable(); await expect(editor).toBeFocused();
    await editor.press('Backspace');
    await expect(editor).toHaveText(`First ${kind.slice(0, -1)}Second`);
    await editor.press('Meta+ArrowDown');
    await editor.press('Enter');
    const composer = page.getByRole('textbox', { name: kind === 'notes' ? 'New journal bullet' : 'New to-do', exact: true });
    await expect(composer).toBeFocused(); await composer.press('Backspace');
    await expect(editor).toBeFocused();
    await expect.poll(() => editor.evaluate(element => {
      const selection = getSelection()!;
      if (!selection.focusNode || !element.contains(selection.focusNode)) return -1;
      const range = document.createRange(); range.selectNodeContents(element);
      range.setEnd(selection.focusNode, selection.focusOffset);
      return range.toString().length;
    })).toBe(`First ${kind.slice(0, -1)}Second`.length);
    await editor.press('Backspace');
    await expect(editor).toHaveText(`First ${kind.slice(0, -1)}Secon`);
    await editor.press('Enter');
    await expect(saved(first.id)).toBeVisible();
    const rows = (await (await request.get('/api/export')).json())[kind];
    expect(rows.some((row: { id: number }) => row.id === second.id)).toBe(false);
    expect(rows.find((row: { id: number }) => row.id === first.id).content).toBe(`First ${kind.slice(0, -1)}Secon`);
  });
}

test('mobile insertParagraph advances from a saved entry without losing its text', async ({ browser, baseURL, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const row = await (await request.post('/api/notes', { data: { date: today, content: 'Mobile saved entry' } })).json();
  const context = await browser.newContext({ baseURL: baseURL!, viewport: { width: 440, height: 700 }, hasTouch: true });
  const mobile = await context.newPage();
  try {
    await mobile.goto('/');
    await mobile.locator(`[data-kind="notes"][data-item-id="${row.id}"] [role="group"]`).click();
    const editor = mobile.getByRole('textbox', { name: 'Edit note', exact: true });
    await expect(editor).toBeFocused();
    await editor.pressSequentially(' with more text');
    const result = await editor.evaluate(element => {
      const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertParagraph' });
      return { dispatched: element.dispatchEvent(event), prevented: event.defaultPrevented };
    });
    expect(result).toEqual({ dispatched: false, prevented: true });
    const next = mobile.getByRole('textbox', { name: 'New journal bullet', exact: true });
    await expect(next).toBeFocused();
    await expect(next.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '0');
    await expect(mobile.getByRole('group', { name: 'Mobile saved entry with more text', exact: true })).toBeVisible();
    await expect(mobile.getByText('Retry saving', { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

for (const kind of ['notes', 'tasks'] as const) {
  test(`Tab indents an empty new ${kind} entry under the previous entry`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const parent = await (await request.post(`/api/${kind}`, { data: { date: today, content: `Empty Tab parent ${kind}` } })).json();
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: kind === 'notes' ? 'New journal bullet' : 'New to-do', exact: true });

    await composer.press('Tab');

    await expect(composer).toBeFocused();
    await expect(composer.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '1');
    await composer.pressSequentially(`Empty Tab child ${kind}`);
    await composer.press('Enter');
    await expect.poll(async () => {
      const rows = (await (await request.get('/api/export')).json())[kind] as Array<{ content: string; parent_id: number | null }>;
      return rows.find(row => row.content === `Empty Tab child ${kind}`)?.parent_id;
    }).toBe(parent.id);
  });
}

test('inline tags keep their caret position and move with the trailing half of an Enter split', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const row = await (await request.post('/api/notes', { data: { date: today, content: 'Before #move after', tags: ['move'] } })).json();
  await page.goto('/');
  const saved = page.locator(`[data-kind="notes"][data-item-id="${row.id}"] [role="group"]`);
  await saved.click();
  let editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await editor.press('Meta+ArrowDown');
  await editor.pressSequentially(' tail');
  await expect(editor).toHaveText('Before #move after tail');
  await editor.evaluate(element => {
    const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange(); range.setStart(node, node.textContent!.length); range.collapse(true);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await editor.press('Enter');
  const next = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await expect(next.locator('[data-tag="move"]')).toBeVisible();
  await expect(next).toHaveText('#move after tail');
  await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
  await expect.poll(async () => {
    const notes = (await (await request.get('/api/export')).json()).notes as Array<{ content: string; tags: string[] }>;
    return notes.filter(note => note.content === 'Before' || note.content === '#move after tail').map(note => ({ content: note.content, tags: note.tags }));
  }).toEqual(expect.arrayContaining([
    { content: 'Before', tags: [] },
    { content: '#move after tail', tags: ['move'] },
  ]));
});

test('clicking beneath a past date opens an end bullet and abandoned empty drafts disappear', async ({ page, request }) => {
  const date = '2026-09-01';
  await request.post('/api/notes', { data: { date, content: 'Historical starting point' } });
  await page.goto('/');
  const day = page.getByRole('region', { name: new RegExp(`, ${date}$`) });
  const add = day.getByRole('button', { name: 'Add journal bullet', exact: true });
  const editor = day.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await add.click(); await expect(editor).toBeFocused();
  await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
  await expect(editor).toBeHidden();
  await add.click(); await editor.fill('Temporary historical draft');
  await expect.poll(async () => (await (await request.get('/api/export')).json()).notes.some((row: { content: string }) => row.content === 'Temporary historical draft')).toBe(true);
  await editor.fill('');
  await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
  await expect(editor).toBeHidden();
  await expect.poll(async () => (await (await request.get('/api/export')).json()).notes.some((row: { content: string }) => row.content === 'Temporary historical draft')).toBe(false);
  await add.click(); await editor.fill('A new historical note'); await editor.press('Enter');
  await expect(day.getByRole('group', { name: 'A new historical note', exact: true })).toBeVisible();
  const { days } = await (await request.get(`/api/journal?on=${date}`)).json();
  const notes = days.find((day: { date: string }) => day.date === date).notes;
  expect(notes.at(-1).content).toBe('A new historical note');
});

test('typing while Enter waits for the server is acknowledged before the editor advances', async ({ page, request }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route('**/api/document/edit*', async route => {
    const body = route.request().postDataJSON();
    if (!held && body.changes?.some((change: { content?: string }) => change.content === 'Before response')) {
      held = true;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await editor.fill('Before response');
  await editor.press('Enter');
  await expect.poll(() => held).toBe(true);
  await editor.pressSequentially(' plus late typing');
  release();
  await expect(editor).toHaveText('');
  await expect.poll(async () => {
    const notes = (await (await request.get('/api/export')).json()).notes;
    return notes.some((row: { content: string }) => row.content === 'Before response plus late typing');
  }).toBe(true);
});

test('editing a saved entry after inserting before it uses its latest revision', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const first = await (await request.post('/api/notes', { data: { date: today, content: 'Before target' } })).json();
  const target = await (await request.post('/api/notes', { data: { date: today, content: 'Move all of this text', after_id: first.id } })).json();
  await page.goto('/');

  const saved = (id: number) => page.locator(`[data-kind="notes"][data-item-id="${id}"] [role="group"]`).first();
  await saved(first.id).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await editor.press('Meta+ArrowDown'); await editor.press('Enter');
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await composer.fill('Inserted before target');

  // Selecting the target saves the draft first. That insertion changes the
  // target's stored position and revision before its editor opens.
  await saved(target.id).click();
  await expect(editor).toBeFocused();
  await editor.press('Meta+ArrowUp'); await editor.press('Enter');

  await expect(page.getByRole('button', { name: 'Retry saving' })).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText('Move all of this text');
});

test('a stale saved-entry draft refreshes its revision and retries without getting stuck', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const note = await (await request.post('/api/notes', { data: { date: today, content: 'dv-notes before editing' } })).json();
  await page.goto('/');

  await page.locator(`[data-kind="notes"][data-item-id="${note.id}"] [role="group"]`).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await editor.fill('dv-notes local draft survives');
  await request.patch(`/api/notes/${note.id}`, { data: { content: 'dv-notes changed in another window' } });
  await editor.press('Enter');

  await expect(page.getByRole('button', { name: 'Retry saving' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'dv-notes local draft survives', exact: true })).toBeVisible();
  const exported = await (await request.get('/api/export')).json();
  expect(exported.notes.find((item: { id: number }) => item.id === note.id).content).toBe('dv-notes local draft survives');
});

test('Backspace merges a completed task into the preceding note', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Mixed note ' } });
  const task = await (await request.post('/api/tasks', { data: { content: 'mixed task' } })).json();
  await request.post(`/api/tasks/${task.id}/complete`);
  await page.goto('/');
  const row = page.locator(`[data-kind="tasks"][data-item-id="${task.id}"] [role="group"]`).first();
  await row.focus(); await row.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Edit to-do', exact: true });
  await editor.press('Meta+ArrowUp'); await editor.press('Backspace');
  await expect(page.getByRole('textbox', { name: 'Edit note', exact: true })).toHaveText('Mixed note mixed task');
  const exported = await (await request.get('/api/export')).json();
  expect(exported.tasks.some((row: { id: number }) => row.id === task.id)).toBe(false);
});

test('recovery applies an earlier completed-task draft through the unified endpoint', async ({ page, request }) => {
  const task = await (await request.post('/api/tasks', { data: { content: 'Task before recovery' } })).json();
  await request.post(`/api/tasks/${task.id}/complete`);
  const archived = (await (await request.get('/api/export')).json()).tasks.find((row: { id: number }) => row.id === task.id);
  const key = 'still-draft-2000-01-01';
  await page.addInitScript(({ key, archived }) => localStorage.setItem(key, JSON.stringify({
    active: true, mode: 'edit', kind: 'tasks', id: archived.id, revision: archived.revision,
    content: 'Task recovered correctly', saved: archived.content, tags: [], savedTags: [],
    clientId: crypto.randomUUID(), requestId: crypto.randomUUID(), parentId: null, afterId: null, hiddenTag: null,
  })), { key, archived });
  await page.goto('/');
  await expect.poll(async () => {
    const tasks = (await (await request.get('/api/export')).json()).tasks;
    return tasks.find((row: { id: number }) => row.id === task.id)?.content;
  }).toBe('Task recovered correctly');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  await request.delete(`/api/tasks/${task.id}`);
});
