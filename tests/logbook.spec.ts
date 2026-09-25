import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

test('to-do text stays vertically aligned when editing', async ({ page, request }) => {
  await request.post('/api/tasks', { data: { content: 'Keep this line still' } });
  await page.goto('/');
  const row = page.getByRole('group', { name: 'Keep this line still', exact: true });
  const textTop = (locator: typeof row) => locator.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!text) throw new Error('Expected rendered text');
    const range = document.createRange();
    range.selectNodeContents(text);
    return range.getBoundingClientRect().top;
  });
  const before = await textTop(row);
  await row.click();
  const editor = page.getByRole('textbox', { name: 'Edit to-do', exact: true });
  await expect(editor).toBeVisible();
  expect(await textTop(editor)).toBeCloseTo(before, 0);
});

test('nested to-dos use a clear indent and reveal progressively', async ({ page, request }) => {
  const parent = await (await request.post('/api/tasks', { data: { content: 'Indented parent' } })).json();
  await request.post('/api/tasks', { data: { content: 'First nested task', parent_id: parent.id } });
  await request.post('/api/tasks', { data: { content: 'Second nested task', parent_id: parent.id } });
  await page.goto('/');
  const root = page.getByRole('group', { name: 'Indented parent', exact: true });
  const first = page.getByRole('group', { name: 'First nested task', exact: true });
  const second = page.getByRole('group', { name: 'Second nested task', exact: true });
  await page.getByRole('button', { name: 'Expand Indented parent', exact: true }).click();
  await expect(first).toBeVisible();
  const [rootBox, childBox] = await Promise.all([root.boundingBox(), first.boundingBox()]);
  expect(childBox!.x - rootBox!.x).toBeGreaterThanOrEqual(27);
  const branch = page.locator(`[data-kind="tasks"][data-item-id="${parent.id}"] > [data-branch-for="${parent.id}"]`);
  await expect(branch).toHaveCSS('transition-duration', '0.32s, 0.24s, 0.32s, 0s');
  expect(await second.locator('xpath=..').evaluate(element => getComputedStyle(element).transitionDelay)).toContain('0.035s');
});

test('untouched bullets and to-dos disappear on blur or Backspace', async ({ page, request }) => {
  await page.goto('/');
  const note = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await note.press('Backspace');
  await expect(note).toBeHidden();
  await page.getByRole('region', { name: /^Today,/ }).getByRole('button', { name: 'Add journal bullet', exact: true }).click();
  await expect(note).toBeFocused();
  await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
  await expect(note).toBeHidden();

  const task = page.getByRole('textbox', { name: 'New to-do', exact: true });
  await page.getByRole('button', { name: 'Add to-do', exact: true }).click();
  await expect(task).toBeFocused();
  await task.press('Backspace');
  await expect(task).toBeHidden();
  await page.getByRole('button', { name: 'Add to-do', exact: true }).click();
  await expect(task).toBeFocused();
  await page.getByRole('button', { name: 'Start focus timer', exact: true }).focus();
  await expect(task).toBeHidden();

  const exported = await (await request.get('/api/export')).json();
  expect([...exported.notes, ...exported.tasks].every((item: { content: string }) => item.content.trim())).toBe(true);
});

test('session times edit inline without exposing or changing the date', async ({ page, request }) => {
  const today = '2026-09-02'; // A past day keeps manual sessions valid at any test run time.
  await request.post('/api/sessions', { data: { started_at: new Date(`${today}T10:15:00`).toISOString(), duration_seconds: 1500 } });
  await page.goto('/');
  await page.getByRole('button', { name: `Focus sessions for ${today}` }).click();
  const dialog = page.getByRole('dialog');
  const start = dialog.getByRole('button', { name: /Edit start of session/ });
  await expect(start).toHaveText(/\d{1,2}:\d{2}(?:\s[AP]M)?$/);
  await expect(start).not.toHaveText(/\d{1,2}:\d{2}:\d{2}/);
  const startBox = await start.boundingBox();
  const addBox = await dialog.getByRole('button', { name: 'Add session' }).boundingBox();
  expect(addBox!.x).toBeCloseTo(startBox!.x, 0);

  await start.click();
  const input = dialog.getByLabel('Start time');
  await expect(input).toHaveAttribute('type', 'time');
  await expect(input).toHaveCSS('border-top-width', '0px');
  await expect(input).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(input).toHaveCSS('box-shadow', 'none');
  await input.fill('08:45');
  await expect(dialog.locator('button[type="submit"]')).toHaveCount(0);
  await dialog.getByLabel('Start time', { exact: true }).press('Enter');
  const [session] = await (await request.get(`/api/sessions?date=${today}`)).json();
  expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(session.started_at))).toBe(today);
  await request.delete(`/api/sessions/${session.id}`);
});

for (const kind of ['notes', 'tasks'] as const) {
  test(`${kind} branches start collapsed and save an edit when folded`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const parent = await (await request.post(`/api/${kind}`, { data: { date: today, content: `Fold ${kind}` } })).json();
    const child = await (await request.post(`/api/${kind}`, { data: { date: today, content: `Folded child ${kind}`, parent_id: parent.id } })).json();
    await request.post(`/api/${kind}`, { data: { date: today, content: `Folded grandchild ${kind}`, parent_id: child.id } });
    await page.goto('/');
    const expand = page.getByRole('button', { name: `Expand Fold ${kind}`, exact: true });
    const childRow = page.getByRole('group', { name: `Folded child ${kind}`, exact: true });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(childRow).toBeHidden();
    await expand.hover();
    await expect(expand).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(childRow).toBeVisible();
    await childRow.hover();
    await expect(childRow).toBeVisible();
    await page.mouse.move(1200, 800);
    await expect(childRow).toBeHidden();
    await expand.hover();
    await expand.click();
    await page.mouse.move(1200, 800);
    await expect(childRow).toBeVisible();
    await page.getByRole('button', { name: `Collapse Fold ${kind}`, exact: true }).click();
    await expect(childRow).toBeHidden();
    await expand.press('Enter');
    await expect(childRow).toBeVisible();
    await expect(page.getByRole('group', { name: `Folded grandchild ${kind}`, exact: true })).toBeHidden();
    await childRow.click();
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit to-do', exact: true });
    await expect(editor).toBeFocused();
    await editor.fill(`Saved child ${kind}`);
    await page.getByRole('button', { name: `Collapse Fold ${kind}`, exact: true }).click();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(editor).toBeHidden();
    const composer = page.getByRole('textbox', { name: kind === 'notes' ? 'New journal bullet' : 'New to-do', exact: true });
    await expect(composer.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '0');
    const stored = (await (await request.get('/api/export')).json())[kind];
    expect(stored.find((row: { id: number }) => row.id === child.id).content).toBe(`Saved child ${kind}`);
    await expand.click();
    await expect(page.getByRole('group', { name: `Saved child ${kind}`, exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Expand Saved child ${kind}`, exact: true }).click();
    await expect(page.getByRole('group', { name: `Folded grandchild ${kind}`, exact: true })).toBeVisible();
    await page.reload();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('group', { name: `Saved child ${kind}`, exact: true })).toBeHidden();
  });
}

test('write, autosave, complete a to-do, use the timer, and edit sessions', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New journal bullet' });
  await expect(composer).toBeFocused();
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(0);
  await expect(page.getByRole('main').locator('svg, img')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/empty-desktop.png', fullPage: true });
  await composer.fill('A small beginning, and a clear mind.');
  await expect.poll(async () => {
    const data = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    return data.days[0].notes.some((note: { content: string }) => note.content === 'A small beginning, and a clear mind.');
  }).toBe(true);
  await page.reload();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText('');
  await expect(page.getByRole('group', { name: 'A small beginning, and a clear mind.', exact: true })).toBeVisible();
  await composer.fill('Made space for the important work.');
  await composer.press('Meta+ArrowDown');
  await composer.press('Enter');
  await expect(composer).toHaveText('');
  await expect(page.getByRole('group', { name: 'Made space for the important work.', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add to-do', exact: true }).click();
  await page.getByRole('textbox', { name: 'New to-do' }).fill('overdue trainings');
  await page.getByRole('textbox', { name: 'New to-do' }).press('Meta+ArrowDown');
  await page.getByRole('textbox', { name: 'New to-do' }).press('Enter');
  await page.getByRole('button', { name: 'Complete overdue trainings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Complete overdue trainings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'overdue trainings', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Start focus timer' }).click();
  await expect(page.getByTestId('compact-timer-time')).toContainText('00:00');
  await page.getByRole('button', { name: 'Stop focus timer' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Mute focus sound' }).click();
  await page.getByRole('button', { name: 'Play focus sound' }).click();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Stop focus timer' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop focus timer' }).click({ button: 'right' });
  await expect(page.getByRole('button', { name: 'Play focus sound' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Stop focus timer' }).click();
  await page.getByRole('button', { name: /Focus sessions for/ }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Edit duration of session/ })).toHaveCount(1);
  await dialog.getByRole('button', { name: /Edit duration of session/ }).click();
  await dialog.getByLabel('Start time').fill('00:00');
  await dialog.getByLabel('Duration', { exact: true }).fill('30s');
  await dialog.getByLabel('Duration', { exact: true }).press('Enter');
  await expect(dialog.getByRole('button', { name: /Edit duration of session/ })).toHaveText('30s');
  await dialog.getByRole('button', { name: /Delete session/ }).click();
  await expect(dialog.getByRole('button', { name: /Delete session/ })).toHaveCount(0);
  await expect(dialog.getByText('0s', { exact: true })).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(dialog).toBeHidden();
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(yesterday);
  const start = new Date(`${day}T09:00:00-07:00`).toISOString();
  await request.post('/api/sessions', { data: { started_at: start, duration_seconds: 75 * 60 } });
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  await page.getByRole('button', { name: 'Open focus statistics' }).click();
  const statsDialog = page.getByRole('dialog', { name: 'Statistics' });
  await expect(statsDialog).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(statsDialog.getByText(/1h 15m 00s total/)).toBeVisible();
  await statsDialog.getByRole('button', { name: '30 days', exact: true }).click();
  await expect(statsDialog.getByRole('button', { name: '30 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await statsDialog.getByRole('button', { name: /total · \d+ sessions?$/ }).click();
  await expect(statsDialog.getByRole('list')).toBeVisible();
  await page.screenshot({ path: 'test-results/statistics-desktop.png' });
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('recovers a failed autosave without losing the draft', async ({ page }) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New journal bullet' });
  await expect(composer).toBeFocused();
  await page.route('**/api/document/edit?*', route => route.abort());
  await composer.fill('This thought stays safe through a connection failure.');
  await expect(page.getByRole('button', { name: 'Retry saving' })).toBeVisible();
  await page.reload();
  await expect(composer).toHaveText('This thought stays safe through a connection failure.');
  await page.unroute('**/api/document/edit?*');
  await composer.press('Meta+ArrowDown');
  await composer.press('Enter');
  await expect(composer).toHaveText('');
  await expect(page.getByRole('group', { name: 'This thought stays safe through a connection failure.', exact: true })).toBeVisible();
});

test('narrow screens use the same three-pane journal as short screens', async ({ page, request }) => {
  const journal = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const previous = new Date(`${journal.today}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  await request.post('/api/notes', { data: { date: previous.toISOString().slice(0, 10), content: 'Older narrow note' } });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'New journal bullet' })).toBeFocused();
  await page.screenshot({ path: 'test-results/journal-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 440, height: 700 });
  await expect(page.getByRole('tablist', { name: 'Mobile views' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Today,/ })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Older narrow note', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New journal bullet' })).toBeVisible();
  await page.getByRole('tab', { name: 'to do', exact: true }).click();
  await expect(page.getByRole('region', { name: 'to do', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to-do', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'log', exact: true }).click();
  await page.screenshot({ path: 'test-results/compact-notes.png' });
  await page.setViewportSize({ width: 260, height: 180 });
  await expect(page.getByRole('tablist', { name: 'Mobile views' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Today,/ }).getByRole('button', { name: 'Add journal bullet', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start focus timer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open focus statistics' })).toBeHidden();
  expect(await page.locator('body').evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(260);
  await page.screenshot({ path: 'test-results/timer-only.png' });
});

test('creates a fresh day at midnight and focuses its new bullet', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-16T23:59:58-07:00') });
  await page.route('**/api/journal?*', async route => {
    const today = await page.evaluate(() => {
      const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    await route.fulfill({ json: { today, server_time: `${today}T23:59:58-07:00`, active_session: null, tasks: [], next_cursor: null,
      days: [{ date: today, notes: [], focused_seconds: 0, longest_session_seconds: 0, session_count: 0 }] } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Focus sessions for 2026-09-16' })).toBeVisible();
  await page.clock.runFor(3000);
  await expect(page.getByRole('button', { name: 'Focus sessions for 2026-09-17' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New journal bullet' })).toBeFocused();
});

test('journal and statistics meet automated accessibility checks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'New journal bullet' })).toBeFocused();
  await page.waitForTimeout(160); // Let initial hover/color transitions reach their contrast-stable state.
  const journal = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(journal.violations).toEqual([]);
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  await page.getByRole('button', { name: 'Open focus statistics' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Statistics' })).toBeVisible();
  await expect(page.getByText('focused per day', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
  const modal = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(modal.violations).toEqual([]);
});

test('recovers a draft from an earlier day into its original date', async ({ page, request }) => {
  const journal = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const yesterday = new Date(`${journal.today}T12:00:00`); yesterday.setDate(yesterday.getDate() - 2);
  const day = yesterday.toISOString().slice(0, 10);
  await page.addInitScript(({ day }) => {
    localStorage.setItem(`still-draft-${day}`, JSON.stringify({
      id: null, content: 'A thought from before midnight.', saved: '', clientId: 'earlier-draft-test',
    }));
  }, { day });
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'A thought from before midnight.', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: new RegExp(day) }).getByRole('group', { name: 'A thought from before midnight.', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New journal bullet' })).toBeFocused();
});

test('loads older days automatically and saves edits to historical notes', async ({ page, request }) => {
  for (let i = 1; i <= 24; i++) {
    const date = `2025-08-${String(i).padStart(2, '0')}`;
    const response = await request.post('/api/notes', { data: { date, content: `History entry ${i}` } });
    expect(response.ok()).toBeTruthy();
  }
  const pageRequests: URL[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/journal') pageRequests.push(url);
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'New journal bullet' })).toBeFocused();
  await page.waitForTimeout(350);
  const timer = page.getByRole('button', { name: 'Start focus timer' });
  const todo = page.getByRole('region', { name: 'to do', exact: true });
  const main = await page.getByRole('main').boundingBox();
  const timerBefore = await timer.boundingBox();
  const todoBefore = await todo.boundingBox();
  expect(main!.x).toBeGreaterThanOrEqual(240);
  expect(main!.x).toBeGreaterThan(1280 - main!.x - main!.width);
  expect(Math.abs(main!.x + main!.width / 2 - 640)).toBeLessThan(40);
  expect(timerBefore!.x + timerBefore!.width).toBe(1280 - 24);
  expect(timerBefore!.y).toBe(20);
  expect(todoBefore!.y + todoBefore!.height).toBeLessThanOrEqual((await page.getByRole('button', { name: /Focus sessions for/ }).first().boundingBox())!.y);
  expect(timerBefore!.height).toBe(timerBefore!.width);
  await expect(timer).toHaveCSS('border-radius', '50%');
  await expect(page.getByRole('group', { name: 'History entry 1', exact: true })).toHaveCount(0);
  expect(pageRequests.every(url => url.searchParams.get('limit') === '14')).toBe(true);
  expect(pageRequests.some(url => url.searchParams.has('before'))).toBe(false);
  await page.getByRole('button', { name: 'Earlier days', exact: true }).scrollIntoViewIfNeeded();
  const oldNote = page.getByRole('group', { name: 'History entry 1', exact: true });
  await expect(oldNote).toBeAttached();
  expect(pageRequests.some(url => url.searchParams.has('before'))).toBe(true);
  expect(pageRequests.every(url => url.searchParams.get('limit') === '14')).toBe(true);
  expect(await page.getByTestId('log-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.getByTestId('log-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.mouse.move(page.viewportSize()!.width - 10, page.viewportSize()!.height / 2);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await timer.boundingBox()).toEqual(timerBefore);
  expect(await todo.boundingBox()).toEqual(todoBefore);

  // Polling the current day keeps loaded history without downloading old pages again.
  const olderRequests = pageRequests.filter(url => url.searchParams.has('before')).length;
  await page.clock.install();
  await page.clock.runFor(15000);
  await expect(oldNote).toBeAttached();
  expect(pageRequests.filter(url => url.searchParams.has('before'))).toHaveLength(olderRequests);
  await oldNote.click();
  await page.getByRole('textbox', { name: 'Edit note' }).fill('A revised historical thought.');
  await page.getByRole('textbox', { name: 'Edit note' }).press('Meta+ArrowDown');
  await page.getByRole('textbox', { name: 'Edit note' }).press('Enter');
  await expect(page.getByRole('group', { name: 'A revised historical thought.', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'A revised historical thought.', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit note' }).press('Meta+a');
  await page.getByRole('textbox', { name: 'Edit note' }).press('Backspace');
  await page.getByRole('textbox', { name: 'Edit note' }).press('Enter');
  await expect(page.getByRole('group', { name: 'A revised historical thought.', exact: true })).toHaveCount(0);
});
