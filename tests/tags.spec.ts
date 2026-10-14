import { expect, test, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

for (const kind of ['notes', 'tasks'] as const) {
  test(`typed tags become removable inline atoms and metadata in ${kind}`, async ({ page, request }) => {
    await page.goto('/');
    if (kind === 'tasks') {
      const add = page.getByRole('button', { name: 'Add to-do', exact: true });
      await expect(add).toBeVisible();
      await add.click();
    }
    const composer = page.getByRole('textbox', { name: kind === 'notes' ? 'New journal bullet' : 'New to-do', exact: true });
    await composer.pressSequentially(`A tagged ${kind} #unique-${kind}`);
    await composer.press('Enter');
    await expect(composer).toHaveText('');
    const preview = page.getByRole('group', { name: new RegExp(`^A tagged ${kind}`) });
    const tag = preview.locator(`[data-tag="unique-${kind}"]`);
    await expect(tag).toHaveText(`#unique-${kind}`);
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
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit to-do', exact: true });
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
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
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
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
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

test('swipe tags page highlights the selected tag and filters to-dos and log entries', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Mobile focused note', tags: ['mobile'] } });
  await request.post('/api/notes', { data: { date: today, content: 'Other mobile note', tags: ['other'] } });
  await request.post('/api/tasks', { data: { content: 'Mobile focused task', tags: ['mobile'] } });
  await request.post('/api/tasks', { data: { content: 'Other mobile task', tags: ['other'] } });
  await page.setViewportSize({ width: 440, height: 400 });
  await page.goto('/');

  const tabs = page.getByRole('tablist', { name: 'Mobile views' });
  await expect(tabs.getByRole('tab')).toHaveText(['to do', 'log', 'tags']);
  await tabs.getByRole('tab', { name: 'tags', exact: true }).click();
  const mobile = page.getByRole('button', { name: '#mobile', exact: true });
  await expect(mobile.locator('span')).toHaveCSS('translate', '0px -1px');
  await mobile.click();
  await expect(mobile).toHaveAttribute('aria-pressed', 'true');
  await expect(mobile).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(mobile).toHaveCSS('border-color', 'rgb(24, 113, 186)');
  await expect(mobile).toHaveCSS('color', 'rgb(24, 113, 186)');

  await tabs.getByRole('tab', { name: 'to do', exact: true }).click();
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

test('hover tabs filter nested notes and tasks, hide the active tag, and preserve it during edits', async ({ page, request }) => {
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
  await expect(page.locator('[data-tag="focused"]')).toHaveCount(0);
  await expect(page.locator('[data-tag="secondary"]')).toHaveCount(1);
  await page.getByRole('group', { name: 'Focus parent', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await expect(editor.locator('[data-tag]')).toHaveCount(0);
  await expect.poll(() => page.evaluate((date) => {
    const draft = JSON.parse(localStorage.getItem(`still-draft-${date}`) ?? 'null');
    return draft && { hiddenTag: draft.hiddenTag, savedTags: draft.savedTags };
  }, today)).toEqual({ hiddenTag: 'focused', savedTags: ['focused'] });
  await editor.fill('Focus parent edited');
  await expect.poll(() => page.evaluate((date) => JSON.parse(localStorage.getItem(`still-draft-${date}`) ?? 'null')?.tags, today)).toEqual(['focused']);
  await editor.press('Enter');
  await expect(page.getByRole('group', { name: 'Focus parent edited', exact: true })).toBeVisible();
  await expect.poll(async () => {
    const data = await (await request.get('/api/export')).json();
    return data.notes.find((item: { id: number }) => item.id === parent.id)?.tags;
  }).toEqual(['focused']);
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await composer.fill('New filtered note'); await composer.press('Enter');
  await expect(page.getByRole('group', { name: 'New filtered note', exact: true })).toBeVisible();
  await expect.poll(async () => {
    const data = await (await request.get('/api/export')).json();
    return data.notes.find((item: { content: string }) => item.content === 'New filtered note')?.tags;
  }).toEqual(['focused']);
  await rail.hover(); await rail.getByRole('button', { name: 'logbook', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Unmatched ancestor', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'New filtered note', exact: true }).locator('[data-tag="focused"]')).toBeVisible();
});

test('completion animates out and in while preserving tag metadata', async ({ page, request }) => {
  const task = await (await request.post('/api/tasks', { data: { content: 'Animated task', tags: ['animation'] } })).json();
  await page.goto('/');
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
  expect(data.tasks.find((item: { id: number }) => item.id === task.id).tags).toEqual(['animation']);
});

test('to-do region expands for all rows and leaves a usable journal below', async ({ page, request }) => {
  for (let i = 0; i < 28; i++) await request.post('/api/tasks', { data: { content: `Expanding task ${i}` } });
  await page.goto('/');
  const todos = page.getByRole('region', { name: 'to do', exact: true });
  await expect(todos).toHaveCSS('overflow-y', 'visible');
  const dimensions = await todos.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
  await page.getByRole('group', { name: 'Expanding task 27', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('group', { name: 'Expanding task 27', exact: true })).toBeVisible();
  const journal = page.getByTestId('log-scroll');
  expect((await journal.boundingBox())!.height).toBeGreaterThanOrEqual(240);
  await journal.scrollIntoViewIfNeeded();
  await expect(page.getByRole('textbox', { name: 'New journal bullet', exact: true })).toBeVisible();
});

test('a tag-only entry stores its inline atom, and deleting it removes the final tab', async ({ page, request }) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await composer.pressSequentially('#only-chip'); await composer.press('Enter');
  await expect(composer).toHaveText('');
  const preview = page.getByRole('group', { name: '#only-chip', exact: true });
  await expect(preview.locator('[data-tag="only-chip"]')).toBeVisible();
  const data = await (await request.get('/api/export')).json();
  const stored = data.notes.find((row: { tags: string[] }) => row.tags.includes('only-chip'));
  expect(stored.content).toBe('#only-chip');
  await preview.click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await editor.locator('[data-tag]').click(); await page.keyboard.press('Backspace'); await editor.press('Enter');
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: '#only-chip', exact: true })).toHaveCount(0);
});
