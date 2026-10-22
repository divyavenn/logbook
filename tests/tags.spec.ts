import { expect, test, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

for (const kind of ['notes', 'tasks'] as const) {
  test(`typed tags become removable inline atoms and metadata in ${kind}`, async ({ page, request }) => {
    await page.goto('/');
    if (kind === 'tasks') {
      const add = page.getByRole('button', { name: 'Add task', exact: true });
      await expect(add).toBeVisible();
      await add.click();
    }
    const composer = page.getByRole('textbox', { name: kind === 'notes' ? 'New note' : 'New task', exact: true });
    await composer.pressSequentially(`A tagged ${kind} #unique-${kind}`);
    await composer.press('Enter');
    await expect(composer).toHaveText('');
    if (kind === 'tasks') {
      // A tagged task is filed under its tag, and listed in that view alone.
      await expect(page.getByRole('group', { name: new RegExp(`^A tagged ${kind}`) })).toHaveCount(0);
      const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
      await rail.hover();
      await rail.getByRole('button', { name: `#unique-${kind}`, exact: true }).click();
      await expect(page.getByRole('group', { name: new RegExp(`^A tagged ${kind}`) })).toBeVisible();
      const stored = (await (await request.get('/api/export')).json())[kind]
        .find((item: { content: string }) => item.content === `A tagged ${kind} #unique-${kind}`);
      expect(stored.tags).toEqual([`unique-${kind}`]);
      return;
    }
    const preview = page.getByRole('group', { name: new RegExp(`^A tagged ${kind}`) });
    const tag = preview.locator(`[data-tag="unique-${kind}"]`);
    await expect(tag).toHaveText(`#unique-${kind}`);
    // Saving re-keys the row from its local ID to the stored one, remounting
    // it. Measure only once that has happened, or the node is detached.
    await expect.poll(async () => Number(await preview.locator('xpath=ancestor::li[1]').getAttribute('data-item-id'))).toBeGreaterThan(0);
    const tagTypography = await tag.evaluate(element => {
      const style = getComputedStyle(element), parent = getComputedStyle(element.parentElement!);
      const background = getComputedStyle(element, '::before');
      return { fontFamily: style.fontFamily, parentFontFamily: parent.fontFamily,
        fontSize: style.fontSize, parentFontSize: parent.fontSize,
        verticalAlign: style.verticalAlign,
        paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
        marginLeft: style.marginLeft, marginRight: style.marginRight,
        transform: style.transform, backgroundTransform: background.transform };
    });
    expect(tagTypography).toMatchObject({
      fontFamily: tagTypography.parentFontFamily, paddingLeft: '7px', paddingRight: '8px', marginLeft: '0px', marginRight: '0px',
      verticalAlign: 'baseline', transform: 'none', backgroundTransform: 'none',
    });
    expect(parseFloat(tagTypography.parentFontSize) - parseFloat(tagTypography.fontSize)).toBeCloseTo(.5, 1);
    let data = await (await request.get('/api/export')).json();
    const row = data[kind].find((item: { content: string }) => item.content === `A tagged ${kind} #unique-${kind}`);
    expect(row.tags).toEqual([`unique-${kind}`]);
    expect(row.content).toContain(`#unique-${kind}`);
    await page.reload();
    await expect(preview.locator('[data-tag]')).toBeVisible();
    await preview.click();
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit task', exact: true });
    await editor.evaluate(element => {
      const tag = element.querySelector('[data-tag]')!;
      const range = document.createRange(); range.setStartAfter(tag); range.collapse(true);
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await editor.press('ArrowLeft');
    await expect(editor.locator('[data-tag]')).toHaveClass(/ProseMirror-selectednode/);
    await editor.press('ArrowRight');
    await editor.press('Backspace');
    await expect(editor.locator('[data-tag]')).toHaveClass(/ProseMirror-selectednode/);
    await editor.press('Backspace');
    await expect(editor.locator('[data-tag]')).toHaveCount(0);
    await editor.press('Enter');
    await expect(preview).toBeVisible();
    data = await (await request.get('/api/export')).json();
    expect(data[kind].find((item: { id: number }) => item.id === row.id).tags).toEqual([]);
    expect((await (await request.get('/api/tags')).json()).some((tag: { name: string }) => tag.name === `unique-${kind}`)).toBe(false);
  });
}

test('arrow keys treat a freshly typed tag as one character without adding spaces', async ({ page, request }) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New note', exact: true });
  await composer.pressSequentially('before #cursor-chip');
  await expect(composer.locator('.journal-tag-query')).toHaveText('#cursor-chip');
  await composer.press('ArrowLeft');
  const tag = composer.locator('[data-tag="cursor-chip"]');
  await expect(tag).toHaveCount(1);
  await expect(tag).toHaveClass(/ProseMirror-selectednode/);
  await expect(tag).toHaveText('#cursor-chip');
  await composer.press('ArrowLeft');
  await composer.press('ArrowRight');
  await expect(tag).toHaveClass(/ProseMirror-selectednode/);
  await composer.press('ArrowRight');
  await composer.pressSequentially(' after');
  await composer.press('Enter');
  const preview = page.getByRole('group', { name: 'before #cursor-chip after', exact: true });
  await expect(preview).toBeVisible();
  const data = await (await request.get('/api/export')).json();
  const row = data.notes.find((item: { content: string }) => item.content === 'before #cursor-chip after');
  expect(row.tags).toEqual(['cursor-chip']);
});

test('autocomplete cycles existing tags with arrows and keeps code literal', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Tag vocabulary', tags: ['alpha', 'alpine', 'alto', 'beta'] } });
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New note', exact: true });
  await composer.pressSequentially('Read #');
  const suggestions = page.getByRole('listbox', { name: 'Tags', exact: true });
  await expect(composer.locator('.journal-tag-query')).toHaveText('#');
  await expect(suggestions).toHaveCount(0);
  await composer.pressSequentially('al');
  await expect(suggestions.getByRole('option')).toHaveCount(3);
  const query = composer.locator('.journal-tag-query');
  await expect.poll(() => query.evaluate(element => getComputedStyle(element, '::after').content)).toBe('"pha"');
  expect(await query.evaluate(element => getComputedStyle(element, '::after').color)).not.toBe(await query.evaluate(element => getComputedStyle(element).color));
  const alternate = suggestions.getByRole('option', { name: '#alpine', exact: true });
  const third = suggestions.getByRole('option', { name: '#alto', exact: true });
  await expect(alternate).toHaveCSS('border-radius', '999px');
  const [queryBox, alternateBox, thirdBox] = await Promise.all([query.boundingBox(), alternate.boundingBox(), third.boundingBox()]);
  expect(alternateBox!.x).toBeCloseTo(queryBox!.x, 0);
  expect(alternateBox!.y).toBeGreaterThan(queryBox!.y + queryBox!.height);
  expect(thirdBox!.x).toBeCloseTo(queryBox!.x, 0);
  expect(thirdBox!.y).toBeGreaterThan(alternateBox!.y + alternateBox!.height);
  await composer.press('ArrowDown');
  await expect(suggestions.getByRole('option', { name: '#alpine', exact: true })).toHaveAttribute('aria-selected', 'true');
  await composer.press('ArrowUp');
  await expect(suggestions.getByRole('option', { name: '#alpha', exact: true })).toHaveAttribute('aria-selected', 'true');
  await composer.press('ArrowDown'); await composer.press('Enter');
  await expect(suggestions).toHaveCount(0);
  await expect(composer.locator('[data-tag="alpine"]')).toBeVisible();
  await composer.press('Enter');
  await expect(page.getByRole('group', { name: 'Read #alpine', exact: true }).locator('[data-tag="alpine"]')).toBeVisible();
  const data = await (await request.get('/api/export')).json();
  expect(data.notes.find((item: { content: string }) => item.content === 'Read #alpine').tags).toEqual(['alpine']);
  await composer.pressSequentially('Literal '); await composer.press('Meta+Shift+c');
  await composer.pressSequentially('#not-a-tag'); await composer.press('Meta+Shift+c'); await composer.press('Enter');
  const literal = page.getByRole('group', { name: 'Literal #not-a-tag', exact: true });
  await expect(literal.locator('code')).toHaveText('#not-a-tag');
  await expect(literal.locator('[data-tag]')).toHaveCount(0);
  await page.waitForTimeout(250);
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(a11y.violations).toEqual([]);
});

test('swipe tags page highlights the selected tag and filters tasks and log entries', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Mobile focused note', tags: ['mobile'] } });
  await request.post('/api/notes', { data: { date: today, content: 'Other mobile note', tags: ['other'] } });
  await request.post('/api/tasks', { data: { content: 'Mobile focused task', tags: ['mobile'] } });
  await request.post('/api/tasks', { data: { content: 'Other mobile task', tags: ['other'] } });
  await page.setViewportSize({ width: 440, height: 400 });
  await page.goto('/');

  const tabs = page.getByRole('tablist', { name: 'Mobile views' });
  await expect(tabs.getByRole('tab')).toHaveText(['tasks', 'log', 'tags']);
  await tabs.getByRole('tab', { name: 'tags', exact: true }).click();
  const mobile = page.getByRole('button', { name: '#mobile', exact: true });
  await expect(mobile.locator('span')).toHaveCSS('translate', '0px -1px');
  await mobile.click();
  await expect(mobile).toHaveAttribute('aria-pressed', 'true');
  await expect(mobile).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(mobile).toHaveCSS('border-color', 'rgb(24, 113, 186)');
  await expect(mobile).toHaveCSS('color', 'rgb(24, 113, 186)');

  await tabs.getByRole('tab', { name: 'tasks', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Mobile focused task', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Other mobile task', exact: true })).toHaveCount(0);
  await tabs.getByRole('tab', { name: 'log', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Mobile focused note', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Other mobile note', exact: true })).toHaveCount(0);

  await tabs.getByRole('tab', { name: 'tags', exact: true }).click();
  await page.getByRole('button', { name: 'all', exact: true }).click();
  await tabs.getByRole('tab', { name: 'log', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Other mobile note', exact: true })).toBeVisible();
});

test('hover tabs filter nested notes and tasks, hide only the active tag, and keep it through edits', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const createNote = async (content: string, tags: string[] = [], parent_id: number | null = null) =>
    (await request.post('/api/notes', { data: { date: today, content, tags, parent_id } })).json();
  const parent = await createNote('Focus parent', ['focused']);
  const child = await createNote('Included child', [], parent.id);
  await createNote('Included grandchild', ['secondary'], child.id);
  const unrelated = await createNote('Unmatched ancestor');
  await createNote('Matched nested root', ['focused'], unrelated.id);
  await createNote('Unmatched sibling', [], unrelated.id);
  const task = await (await request.post('/api/tasks', { data: { content: 'Focus task', tags: ['focused'] } })).json();
  await request.post('/api/tasks', { data: { content: 'Included subtask', parent_id: task.id } });
  await request.post('/api/tasks', { data: { content: 'Unmatched task' } });
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#focused', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Unmatched ancestor', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Unmatched sibling', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Unmatched task', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand Focus parent', exact: true }).click();
  await page.getByRole('button', { name: 'Expand Included child', exact: true }).click();
  await page.getByRole('button', { name: 'Expand Focus task', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Included grandchild', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Included subtask', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Matched nested root', exact: true }).locator('xpath=ancestor::li[1]')).toHaveAttribute('data-depth', '0');
  // Only the tag being filtered by is hidden; the others stay as they were.
  await expect(page.locator('[data-tag="focused"]')).toHaveCount(0);
  await expect(page.locator('[data-tag="secondary"]')).toHaveCount(1);
  await page.getByRole('group', { name: 'Focus parent', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  // Opening an entry shows every tag on it, the one filtering this view included.
  await expect(editor.locator('[data-tag]')).toHaveCount(1);
  await expect.poll(() => page.evaluate((date) => {
    const draft = JSON.parse(localStorage.getItem(`still-draft-${date}`) ?? 'null');
    return draft && { hiddenTags: draft.hiddenTags, savedTags: draft.savedTags };
  }, today)).toEqual({ hiddenTags: ['focused'], savedTags: ['focused'] });
  // An edit that keeps the tag keeps the entry filed under it.
  await editor.fill('Focus parent edited #focused ');
  await expect.poll(() => page.evaluate((date) => JSON.parse(localStorage.getItem(`still-draft-${date}`) ?? 'null')?.tags, today)).toEqual(['focused']);
  // Another tag can be added while filtering, and shows as a normal bubble.
  await editor.pressSequentially(' #extra ');
  await expect(editor.locator('[data-tag="extra"]')).toHaveCount(1);
  // The active tag is the entry's own, and shows while the entry is open.
  await expect(editor.locator('[data-tag="focused"]')).toBeVisible();
  // Names are read out of the entry, so they come in the order they are written.
  await expect.poll(() => page.evaluate((date) => JSON.parse(localStorage.getItem(`still-draft-${date}`) ?? 'null')?.tags?.slice().sort(), today)).toEqual(['extra', 'focused']);
  await editor.press('Enter');
  await expect(page.getByRole('group', { name: /^Focus parent edited/ })).toBeVisible();
  await expect.poll(async () => {
    const data = await (await request.get('/api/export')).json();
    return data.notes.find((item: { id: number }) => item.id === parent.id)?.tags?.slice().sort();
  }).toEqual(['extra', 'focused']);
  const composer = page.getByRole('textbox', { name: 'New note', exact: true });
  await composer.fill('New filtered note'); await composer.press('Enter');
  await expect(page.getByRole('group', { name: 'New filtered note', exact: true })).toBeVisible();
  // The tag that filed it is written into the entry, not held only as a name.
  await expect.poll(async () => {
    const data = await (await request.get('/api/export')).json();
    const row = data.notes.find((item: { content: string }) => item.content.startsWith('New filtered note'));
    return [row?.content, row?.tags];
  }).toEqual(['New filtered note #focused', ['focused']]);
  await rail.hover(); await rail.getByRole('button', { name: 'logbook', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Unmatched ancestor', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: /^New filtered note/ }).locator('[data-tag="focused"]')).toBeVisible();
  const exported = await (await request.get('/api/export')).json();
  expect(exported.notes.find((item: { content: string }) => item.content === 'Included grandchild').tags).toEqual(['secondary']);
});

test('deleting an entry in tag view only removes that tag', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Keeps its text', tags: ['pruned', 'kept'] } });
  await request.post('/api/notes', { data: { date: today, content: 'Only this tag', tags: ['pruned'] } });
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#pruned', exact: true }).click();
  const tagsOf = async (content: string) =>
    ((await (await request.get('/api/export')).json()).notes as Array<{ content: string; tags: string[] }>)
      .find(row => row.content === content)?.tags;
  const deleteEntry = async (content: string) => {
    // Deleting an entry hands editing to its neighbour, which is already open.
    const group = page.getByRole('group', { name: content, exact: true });
    if (await group.count()) await group.click();
    const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
    await expect(editor).toContainText(content);
    const box = (await editor.boundingBox())!;
    await editor.dblclick({ position: { x: box.width - 5, y: 12 } });
    await editor.press('Backspace');
  };

  await deleteEntry('Keeps its text');
  // The entry leaves the filtered list but keeps its text and its other tags.
  await expect.poll(() => tagsOf('Keeps its text')).toEqual(['kept']);
  await expect(page.getByRole('group', { name: 'Keeps its text', exact: true })).toHaveCount(0);
  await deleteEntry('Only this tag');
  await expect.poll(() => tagsOf('Only this tag')).toEqual([]);

  // Nothing carries the tag now, so the filter drops itself.
  const kept = page.getByRole('group', { name: 'Keeps its text', exact: true });
  await expect(kept).toBeVisible();
  await expect(page.getByRole('group', { name: 'Only this tag', exact: true })).toBeVisible();
  await expect(kept.locator('[data-tag="kept"]')).toBeVisible();
  await expect(kept.locator('[data-tag="pruned"]')).toHaveCount(0);
  await rail.hover();
  await expect(rail.getByRole('button', { name: '#pruned', exact: true })).toHaveCount(0);
});

test('a selection delete in tag view leaves no blank tagged rows behind', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const post = async (content: string, tags: string[]) =>
    (await request.post('/api/notes', { data: { date: today, content, tags } })).json();
  const first = await post('Range first', ['ranged']);
  const second = await post('Range second', ['ranged', 'other']);
  await post('Range stays', ['ranged']);
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#ranged', exact: true }).click();
  const written = page.locator(`[data-item-id="${first.id}"] > div > [role="group"]`);
  await expect(written).toBeVisible();
  // The selection has to belong to the page, not to the open composer.
  await written.focus();
  await expect(written).toBeFocused();
  await page.evaluate(({ firstId, secondId }) => {
    const from = document.querySelector(`[data-item-id="${firstId}"] [role="group"]`)!;
    const to = document.querySelector(`[data-item-id="${secondId}"] [role="group"]`)!;
    const range = document.createRange(); range.setStartBefore(from); range.setEndAfter(to);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  }, { firstId: first.id, secondId: second.id });
  await page.keyboard.press('Backspace');

  await expect(page.getByRole('group', { name: 'Range first', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Range second', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Range stays', exact: true })).toBeVisible();
  // The emptied entries are gone outright, not left as rows with no text.
  await expect.poll(async () => {
    const notes = (await (await request.get('/api/export')).json()).notes as Array<{ id: number }>;
    return notes.map(note => note.id);
  }).not.toContain(first.id);
  const notes = (await (await request.get('/api/export')).json()).notes as Array<{ id: number; content: string }>;
  expect(notes.some(note => note.id === second.id)).toBe(false);
  expect(notes.map(note => note.content)).toEqual(['Range stays']);
});

test('a filtered view withholds its tag until the entry is opened, and it keeps its place', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const note = await (await request.post('/api/notes', { data: { date: today, content: 'before #anchored after', tags: ['anchored'] } })).json();
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#anchored', exact: true }).click();
  const row = page.getByRole('group', { name: /^before/ });
  await expect(row.locator('[data-tag]')).toHaveCount(0);
  await row.click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  // The read view withholds it; opening the entry shows it, in its own place.
  await expect(editor).toHaveText('before #anchored after');
  await expect(editor.locator('[data-tag="anchored"]')).toBeVisible();
  await editor.press('Meta+ArrowDown');
  await editor.pressSequentially(' more');
  await editor.press('Enter');
  const stored = async () => ((await (await request.get('/api/export')).json()).notes as Array<{ id: number; content: string; tags: string[] }>)
    .find(item => item.id === note.id);
  // The tag keeps its place in the text instead of moving to the end.
  await expect.poll(async () => (await stored())?.content).toBe('before #anchored after more');
  expect((await stored())?.tags).toEqual(['anchored']);

  await rail.hover(); await rail.getByRole('button', { name: 'logbook', exact: true }).click();
  const full = page.getByRole('group', { name: /^before/ });
  await expect(full.locator('[data-tag="anchored"]')).toBeVisible();
  await expect(full).toHaveText('before #anchored after more');
});

test('tag view lists matching entries only, with no events or focus time', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Matching note', tags: ['listed'] } });
  await request.post('/api/notes', { data: { date: today, content: 'Unmatched note' } });
  await page.goto('/');
  const focus = page.locator('[data-focus-total]');
  await expect(focus).toBeVisible();

  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#listed', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Matching note', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Unmatched note', exact: true })).toHaveCount(0);
  await expect(focus).toHaveCount(0);
  await expect(page.getByLabel(`Calendar events for ${today}`)).toHaveCount(0);

  // Selecting closed the panel, so the pointer has to leave and come back.
  await page.mouse.move(700, 400);
  await rail.hover(); await rail.getByRole('button', { name: 'logbook', exact: true }).click();
  await expect(focus).toBeVisible();
});

test("a filtered view leaves out the day's events and its focus time", async ({ page }) => {
  const day = '2026-09-24';
  await page.route('**/api/journal?*', route => {
    const tag = new URL(route.request().url()).searchParams.get('tag');
    route.fulfill({ json: {
      today: day, server_time: new Date().toISOString(), active_session: null, next_cursor: null,
      tags: [{ name: 'listed', note_count: 1, task_count: 0 }], tag, tasks: [],
      days: [{ date: day, focused_seconds: 1500, notes: [
        { id: 1, content: 'Matching note', tags: ['listed'], parent_id: null, position: 0 },
        ...(tag ? [] : [{ id: 2, content: 'Unmatched note', tags: [], parent_id: null, position: 1 }]),
      ], events: [
        { id: 'standup', title: 'Standup', start: `${day}T09:00:00-07:00`, end: `${day}T09:30:00-07:00`, all_day: false, cancelled: false, links: [] },
      ] }],
    } });
  });
  await page.goto('/');
  const event = page.getByText('Standup (9 AM – 9:30 AM)', { exact: true });
  await expect(event).toBeVisible();
  await expect(page.locator('[data-focus-total]')).toHaveText('25m 00s');

  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#listed', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Unmatched note', exact: true })).toHaveCount(0);
  // The events and the focus time belong to the day, not to the tag.
  await expect(event).toHaveCount(0);
  await expect(page.locator('[data-focus-total]')).toHaveCount(0);
});

test('a tag added in one view is a tag in its own view too', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const note = await (await request.post('/api/notes', { data: { date: today, content: 'hello #beta', tags: ['beta'] } })).json();
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#beta', exact: true }).click();

  // Add one tag from another tag's view, where the first is hidden.
  const row = page.getByRole('group', { name: /^hello/ });
  await row.click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await editor.press('Meta+ArrowDown');
  await editor.pressSequentially('#alpha ');
  await editor.press('Enter');
  const stored = async () => ((await (await request.get('/api/export')).json()).notes as Array<{ id: number; content: string; tags: string[] }>)
    .find(item => item.id === note.id);
  // The hidden tag comes back beside the new one, not run together with it.
  await expect.poll(async () => (await stored())?.content).toBe('hello #beta #alpha');
  expect((await stored())?.tags.sort()).toEqual(['alpha', 'beta']);

  await page.mouse.move(700, 400);
  await rail.hover(); await rail.getByRole('button', { name: '#alpha', exact: true }).click();
  const filed = page.getByRole('group', { name: /^hello/ });
  await expect(filed).toBeVisible();
  // In its own view the new tag is hidden, and the other reads as a tag.
  await expect(filed).toHaveText('hello #beta');
  await expect(filed.locator('[data-tag="beta"]')).toBeVisible();
  await expect(filed.locator('[data-tag="alpha"]')).toHaveCount(0);
});

test('a date in tag view opens that day in the full logbook', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Tagged note', tags: ['dated'] } });
  await request.post('/api/notes', { data: { date: today, content: 'Untagged note' } });
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#dated', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Untagged note', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `Open ${today} in the full logbook`, exact: true }).click();
  await expect(page.getByRole('group', { name: 'Untagged note', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Tagged note', exact: true }).locator('[data-tag="dated"]')).toBeVisible();
  await expect(page.getByRole('button', { name: `Focus sessions for ${today}`, exact: true })).toBeVisible();
});

test('completion animates out and in while preserving tag metadata', async ({ page, request }) => {
  const task = await (await request.post('/api/tasks', { data: { content: 'Animated task', tags: ['animation', 'filed'] } })).json();
  await page.goto('/');
  // Tagging files it away, so the run happens in one of its tags' views, where
  // the other tag still shows.
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#filed', exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as { bulletTransitions: string[] }).bulletTransitions = [];
    document.addEventListener('transitionstart', event => {
      if ((event.target as Element).tagName === 'LI') (window as unknown as { bulletTransitions: string[] }).bulletTransitions.push((event as TransitionEvent).propertyName);
    });
  });
  await page.getByRole('button', { name: 'Complete Animated task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Complete Animated task', exact: true })).toHaveCount(0);
  const completed = page.getByRole('group', { name: 'Animated task', exact: true });
  await expect(completed.locator('[data-tag="animation"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { bulletTransitions: string[] }).bulletTransitions)).toEqual(expect.arrayContaining(['opacity', 'transform']));
  const data = await (await request.get('/api/export')).json();
  expect(data.tasks.find((item: { id: number }) => item.id === task.id).tags).toEqual(['animation', 'filed']);
});

test('task region expands for all rows and leaves a usable journal below', async ({ page, request }) => {
  for (let i = 0; i < 28; i++) await request.post('/api/tasks', { data: { content: `Expanding task ${i}` } });
  await page.goto('/');
  const tasks = page.getByRole('region', { name: 'to do', exact: true });
  await expect(tasks).toHaveCSS('overflow-y', 'visible');
  const dimensions = await tasks.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
  await page.getByRole('group', { name: 'Expanding task 27', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('group', { name: 'Expanding task 27', exact: true })).toBeVisible();
  const journal = page.getByTestId('log-scroll');
  expect((await journal.boundingBox())!.height).toBeGreaterThanOrEqual(240);
  await journal.scrollIntoViewIfNeeded();
  await expect(page.getByRole('textbox', { name: 'New note', exact: true })).toBeVisible();
});

test('a tag-only entry stores its inline atom, and deleting it removes the final tab', async ({ page, request }) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New note', exact: true });
  await composer.pressSequentially('#only-chip'); await composer.press('Enter');
  await expect(composer).toHaveText('');
  const preview = page.getByRole('group', { name: '#only-chip', exact: true });
  await expect(preview.locator('[data-tag="only-chip"]')).toBeVisible();
  const data = await (await request.get('/api/export')).json();
  const stored = data.notes.find((row: { tags: string[] }) => row.tags.includes('only-chip'));
  expect(stored.content).toBe('#only-chip');
  await preview.click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  // The tag is all the entry holds, so deleting it leaves nothing to keep.
  await editor.locator('[data-tag]').click(); await page.keyboard.press('Backspace');
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: '#only-chip', exact: true })).toHaveCount(0);
});

test('deleting the active tag in its own view takes the entry out of that view', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const note = await (await request.post('/api/notes',
    { data: { date: today, content: 'filed here #leaving', tags: ['leaving'] } })).json();
  await request.post('/api/notes', { data: { date: today, content: 'also here #leaving', tags: ['leaving'] } });
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('button', { name: '#leaving', exact: true }).click();
  const row = page.getByRole('group', { name: /^filed here/ });
  await row.click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  // The tag shows while the entry is open, and goes when it is deleted.
  const pill = editor.locator('[data-tag="leaving"]');
  await expect(pill).toBeVisible();
  await editor.fill('filed here');
  await expect(pill).toHaveCount(0);
  // The row stays long enough to fade, then is gone from this view.
  const leaving = page.locator(`[data-item-id="${note.id}"]`);
  await editor.press('Escape');
  await expect(leaving).toHaveCount(1);
  await expect(leaving).toHaveCount(0);
  await expect.poll(async () => {
    const row = ((await (await request.get('/api/export')).json()).notes as Array<{ id: number; tags: string[] }>)
      .find(item => item.id === note.id);
    return row?.tags;
  }).toEqual([]);
  // It is still in the full logbook, with the tag gone.
  await rail.hover(); await rail.getByRole('button', { name: 'logbook', exact: true }).click();
  await expect(page.getByRole('group', { name: 'filed here', exact: true })).toBeVisible();
});
