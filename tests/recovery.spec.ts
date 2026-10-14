import { expect, test } from './fixtures';

test('a superseded refresh keeps the saved entry visible until fresh data arrives', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'New note', exact: true });
  await expect(editor).toBeFocused();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let refreshes = 0;
  await page.route('**/api/journal?*', async route => {
    const response = await route.fetch();
    refreshes++;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await editor.fill('Stay visible while refreshing');
    await editor.press('Enter');
    const entry = page.getByRole('group', { name: 'Stay visible while refreshing', exact: true });
    await expect.poll(() => refreshes).toBe(1);
    await expect(entry).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => refreshes).toBe(2);
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }));
    await expect(entry).toBeVisible();
  } finally { release(); }
  await expect(page.getByRole('group', { name: 'Stay visible while refreshing', exact: true })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('still-pending-edits:')))).toEqual([]);
});

test('damaged history and queued edits preserve valid records and allow undo', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const saved = await (await request.post('/api/document/edit', { data: {
    changes: [{ kind: 'notes', date: today, content: 'Saved history entry' }], request_id: 'recovery-history',
  } })).json();
  await page.addInitScript(({ today, operation }) => {
    localStorage.setItem('still-document-history', JSON.stringify({
      undo: [{ key: 'saved', operations: [operation] }, null, { operations: 42 }], redo: 'damaged',
    }));
    localStorage.setItem(`still-pending-edits:still-draft-${today}`, JSON.stringify({
      edits: [null, { key: 'recovered', requestId: 'recovery-request', changes: [{
        id: -1, kind: 'notes', create: true, date: today, content: 'Recovered queued entry',
        tags: [], client_id: 'recovered-client', parent_id: null, after_id: null,
      }] }], aliases: [],
    }));
  }, { today, operation: saved.operation_id });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  const contents = async () => {
    const { notes } = await (await request.get('/api/export')).json();
    return notes.map((row: { content: string }) => row.content);
  };
  await expect.poll(contents).toEqual(['Saved history entry', 'Recovered queued entry']);
  await expect(page.getByRole('group', { name: 'Recovered queued entry', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
  await page.keyboard.press('Meta+z');
  await expect.poll(contents).toEqual(['Saved history entry']);
  await expect(page.getByRole('group', { name: 'Recovered queued entry', exact: true })).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await expect.poll(contents).toEqual([]);
  const backups = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('still-recovery:')));
  expect(backups.some(key => key.includes('still-document-history'))).toBe(true);
  expect(backups.some(key => key.includes('still-pending-edits:'))).toBe(true);
  expect(pageErrors).toEqual([]);
});

for (const failure of ['blocked', 'full'] as const) {
  test(`typing, Enter and Tab still save when browser storage is ${failure}`, async ({ page, request }) => {
    await page.addInitScript(failure => {
      if (failure === 'blocked') Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('Storage blocked', 'SecurityError'); },
      });
      else Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
    }, failure);
    const pageErrors: string[] = [], consoleErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto('/');
    const editor = page.getByRole('textbox', { name: 'New note', exact: true });
    await editor.fill('Parent without local storage');
    await editor.press('Enter');
    await editor.fill('Child without local storage');
    await editor.press('Tab');
    await editor.press('Enter');
    await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
    await expect.poll(async () => {
      const { notes } = await (await request.get('/api/export')).json() as {
        notes: Array<{ id: number; parent_id: number | null; content: string }>;
      };
      const parent = notes.find(row => row.content === 'Parent without local storage');
      const child = notes.find(row => row.content === 'Child without local storage');
      return { count: notes.length, parent: parent?.parent_id, nested: !!parent && child?.parent_id === parent.id };
    }).toEqual({ count: 2, parent: null, nested: true });
    expect(consoleErrors.some(message => message.includes('Could not read or save local data'))).toBe(true);
    expect(pageErrors).toEqual([]);
  });
}
