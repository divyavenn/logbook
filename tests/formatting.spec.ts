import { expect, test, type Locator, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

async function selectAll(editor: Locator) {
  await editor.focus();
  await editor.press('Meta+a');
}
async function saveAtEnd(editor: Locator) {
  await editor.press('Meta+ArrowDown');
  await editor.press('Enter');
}
async function openTaskComposer(page: Page) {
  await page.getByRole('button', { name: 'Add to-do', exact: true }).click();
}
async function rows(page: Page, kind: 'notes' | 'tasks') {
  return (await (await page.request.get('/api/export')).json())[kind] as { id: number; content: string; parent_id: number | null; source_task_id?: number }[];
}

test('mobile text selection exposes a compact formatting toolbar', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL!, viewport: { width: 440, height: 700 }, hasTouch: true });
  const mobile = await context.newPage();
  try {
    await mobile.goto('/');
    await mobile.evaluate(() => {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: {
        offsetLeft: 32, offsetTop: 0, width: 376, height: 700,
      } });
    });
    expect(await mobile.evaluate(() => [window.visualViewport?.offsetLeft, window.visualViewport?.width])).toEqual([32, 376]);
    const editor = mobile.getByRole('textbox', { name: 'New journal bullet', exact: true });
    await editor.fill('Mobile formatting reaches the right edge');
    await editor.press('Meta+ArrowRight');
    await editor.press('Shift+ArrowLeft');
    const toolbar = mobile.getByRole('toolbar', { name: 'Formatting', exact: true });
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button')).toHaveCount(5);
    await expect(toolbar.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
    const bounds = (await toolbar.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(40);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(400);
    await editor.press('Meta+a');
    await toolbar.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(editor.locator('strong')).toHaveText('Mobile formatting reaches the right edge');
    await toolbar.getByRole('button', { name: 'Code', exact: true }).click();
    await expect(editor.locator('code')).toHaveText('Mobile formatting reaches the right edge');
    await expect(editor).toBeFocused();
  } finally {
    await context.close();
  }
});

for (const kind of ['notes', 'tasks'] as const) {
  test(`link boundaries follow words while interior spaces stay linked in ${kind}`, async ({ page, request }) => {
    const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const url = 'https://example.com/guide';
    const cases = [
      { label: 'guide', caret: 5, text: ' next word', linked: 'guide', visible: 'guide next word', markdown: `[guide](${url}) next word` },
      { label: 'guide', caret: 5, text: 'book notes', linked: 'guidebook', visible: 'guidebook notes', markdown: `[guidebook](${url}) notes` },
      { label: 'guide', caret: 0, text: 'read ', linked: 'guide', visible: 'read guide', markdown: `read [guide](${url})` },
      { label: 'guide', caret: 0, text: 'pre', linked: 'preguide', visible: 'preguide', markdown: `[preguide](${url})` },
      { label: 'guide notes', caret: 6, text: 'project ', linked: 'guide project notes', visible: 'guide project notes', markdown: `[guide project notes](${url})` },
      { label: 'guide notes', caret: 5, text: ' and more', linked: 'guide and more notes', visible: 'guide and more notes', markdown: `[guide and more notes](${url})` },
    ];
    for (const scenario of cases) {
      const item = await (await request.post(`/api/${kind}`, { data: { date: today, content: `[${scenario.label}](${url})` } })).json();
      await page.goto('/');
      const preview = page.locator(`[data-kind="${kind}"][data-item-id="${item.id}"] [role="group"]`).first();
      await preview.focus(); await preview.press('Enter');
      const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit to-do', exact: true });
      await expect(editor).toBeFocused();
      await editor.press('Meta+ArrowUp');
      for (let i = 0; i < scenario.caret; i++) await editor.press('ArrowRight');
      await editor.pressSequentially(scenario.text);
      await expect(editor).toHaveText(scenario.visible);
      await expect(editor.locator('a')).toHaveText(scenario.linked);
      await saveAtEnd(editor);
      await expect(preview.locator('a')).toHaveText(scenario.linked);
      await expect.poll(async () => (await rows(page, kind)).find(row => row.id === item.id)?.content).toBe(scenario.markdown);
      await page.reload();
      await expect(preview.locator('a')).toHaveText(scenario.linked);
      await expect(preview.locator('a')).toHaveAttribute('href', url);
    }
  });
}

for (const kind of ['notes', 'tasks'] as const) {
  test(`formatting shortcuts render and persist as Markdown in ${kind}`, async ({ page }) => {
    await page.goto('/');
    if (kind === 'tasks') await openTaskComposer(page);
    const composer = page.getByRole('textbox', { name: kind === 'notes' ? 'New journal bullet' : 'New to-do', exact: true });
    const formats = [
      ['bold', 'Meta+b', 'strong', '**'],
      ['italic', 'Meta+i', 'em', '*'],
      ['underline', 'Meta+u', 'u', '++'],
      ['code', 'Meta+Shift+c', 'code', '`'],
    ];
    for (const [name, shortcut, tag, delimiter] of formats) {
      const text = `${kind} ${name}`;
      await composer.fill(text);
      await selectAll(composer);
      await composer.press(shortcut);
      await expect(composer.locator(tag)).toHaveText(text);
      if (tag === 'code') {
        await expect(composer.locator('code')).toHaveCSS('color', 'rgb(77, 97, 93)');
        await expect(composer.locator('code')).toHaveCSS('font-family', /monospace/);
        await expect(composer.locator('code')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(composer.locator('code')).toHaveCSS('padding-left', '0px');
      }
      await saveAtEnd(composer);
      await expect(composer).toHaveText('');
      await expect(page.getByRole('group', { name: text, exact: true }).locator(tag)).toHaveText(text);
      expect((await rows(page, kind)).some(row => row.content === `${delimiter}${text}${delimiter}`)).toBe(true);
    }
  });
}

test('link shortcut inserts a labeled link at the caret or links selected text', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: {
    readText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
  } }));
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await expect(composer).toBeFocused();
  await composer.press('Meta+k');
  const dialog = page.getByRole('dialog', { name: 'Link', exact: true });
  const label = dialog.getByRole('textbox', { name: 'Link label', exact: true });
  const field = dialog.getByRole('textbox', { name: 'Link URL' });
  await expect(label).toBeFocused();
  await label.fill('Fresh reference'); await label.press('Enter');
  await expect(field).toBeFocused();
  await field.fill('example.com/fresh'); await field.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(composer.getByRole('link', { name: 'Fresh reference', exact: true })).toHaveAttribute('href', 'https://example.com/fresh');
  await composer.fill('Project notes');
  await composer.press('ArrowRight');
  await composer.press('Meta+k');
  await expect(label).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect(composer).toBeFocused();
  await selectAll(composer); await composer.press('Meta+b'); await composer.press('Meta+k');
  await expect(field).toBeFocused();
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await expect(dialog.getByRole('button')).toHaveCount(0);
  await expect(dialog).toHaveCSS('opacity', '1');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await field.fill('example.com/project'); await field.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(composer.locator('a strong, strong a')).toHaveText('Project notes');
  await saveAtEnd(composer);
  const preview = page.getByRole('group', { name: 'Project notes', exact: true });
  await expect(preview.getByRole('link')).toHaveAttribute('href', 'https://example.com/project');
  const stored = (await rows(page, 'notes')).find(row => row.content.includes('example.com/project'))!;
  expect(stored.content).toContain('**');
  await page.reload();
  await preview.focus(); await preview.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await selectAll(editor); await editor.press('Meta+k');
  await expect(field).toHaveValue('https://example.com/project');
  await field.fill('javascript:alert(1)'); await field.press('Enter');
  await expect(dialog).toBeVisible();
  expect(await field.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  await field.fill('https://example.com/revised'); await field.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(editor.getByRole('link')).toHaveAttribute('href', 'https://example.com/revised');
  // Link labels are edited directly in the document, with their other marks intact.
  await selectAll(editor); await editor.pressSequentially('Updated project notes');
  await expect(editor.getByRole('link')).toHaveText('Updated project notes');
  await expect(editor.locator('strong')).toHaveText('Updated project notes');
  await selectAll(editor); await editor.press('Meta+k');
  await field.fill(''); await field.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(editor.getByRole('link')).toHaveCount(0);
  await expect(editor.locator('strong')).toHaveText('Updated project notes');
  await saveAtEnd(editor);
  await expect(page.getByRole('group', { name: 'Updated project notes', exact: true })).toBeVisible();
  expect((await rows(page, 'notes')).find(row => row.id === stored.id)!.content).toBe('**Updated project notes**');
});

test('clicking links opens them from saved text and the active editor', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: '[Open reference](https://example.com/reference)' } });
  await page.goto('/');
  const saved = page.getByRole('link', { name: 'Open reference', exact: true });
  let popupPromise = page.waitForEvent('popup');
  await saved.click();
  let popup = await popupPromise;
  expect(popup.url()).toContain('https://example.com/reference');
  await popup.close();

  const row = page.getByRole('group', { name: 'Open reference', exact: true });
  await row.focus(); await row.press('Enter');
  const editorLink = page.getByRole('textbox', { name: 'Edit note', exact: true }).getByRole('link', { name: 'Open reference', exact: true });
  await page.evaluate(() => {
    const target = window as typeof window & { __openedLink?: string };
    target.__openedLink = '';
    window.open = ((url?: string | URL) => {
      (window as typeof window & { __openedLink?: string }).__openedLink = String(url ?? '');
      return null;
    }) as typeof window.open;
  });
  await editorLink.click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __openedLink?: string }).__openedLink)).toBe('https://example.com/reference');
});

test('link field prefills clipboard URLs and never overwrites typing', async ({ page }) => {
  await page.addInitScript(() => {
    let call = 0;
    Object.defineProperty(navigator, 'clipboard', { value: { readText: () => {
      call++;
      if (call === 1) return Promise.resolve('https://example.com/copied');
      if (call === 2) return Promise.resolve('copied text that is not a URL');
      return new Promise<string>(resolve => { (window as unknown as { resolveClipboard: (value: string) => void }).resolveClipboard = resolve; });
    } } });
  });
  await page.goto('/');
  await openTaskComposer(page);
  const composer = page.getByRole('textbox', { name: 'New to-do', exact: true });
  await composer.press('Meta+k');
  const dialog = page.getByRole('dialog', { name: 'Link', exact: true });
  const label = dialog.getByRole('textbox', { name: 'Link label', exact: true });
  const field = dialog.getByRole('textbox', { name: 'Link URL' });
  await expect(label).toBeFocused();
  await label.fill('Clipboard link'); await label.press('Enter');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('https://example.com/copied');
  await field.press('Enter'); await expect(dialog).toBeHidden();
  await expect(composer.getByRole('link')).toHaveAttribute('href', 'https://example.com/copied');
  // Ordinary clipboard text leaves the existing link available for editing.
  await selectAll(composer); await composer.press('Meta+k');
  await expect(field).toHaveValue('https://example.com/copied');
  await field.press('Escape'); await expect(dialog).toBeHidden();
  await selectAll(composer); await composer.press('Meta+k');
  await field.fill('https://example.com/typed');
  await page.evaluate(() => (window as unknown as { resolveClipboard: (value: string) => void }).resolveClipboard('https://example.com/late'));
  await expect(field).toHaveValue('https://example.com/typed');
  await field.press('Enter'); await expect(dialog).toBeHidden();
  await expect(composer.getByRole('link')).toHaveAttribute('href', 'https://example.com/typed');
  await saveAtEnd(composer);
  await expect(page.getByRole('group', { name: 'Clipboard link', exact: true })).toBeVisible();
  expect((await rows(page, 'tasks')).some(row => row.content === '[Clipboard link](https://example.com/typed)')).toBe(true);
});

test('undo, redo and literal code backticks survive reload', async ({ page }) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await composer.fill('Reversible formatting');
  await selectAll(composer); await composer.press('Meta+b');
  await expect(composer.locator('strong')).toHaveCount(1);
  await composer.press('Meta+z');
  await expect(composer.locator('strong')).toHaveCount(0);
  await composer.press('Meta+Shift+z');
  await expect(composer.locator('strong')).toHaveCount(1);
  await composer.fill('`a` + ``b`` <tag>');
  await selectAll(composer); await composer.press('Meta+Shift+c');
  await saveAtEnd(composer);
  const preview = page.getByRole('group', { name: '`a` + ``b`` <tag>', exact: true });
  await expect(preview.locator('code')).toHaveText('`a` + ``b`` <tag>');
  expect((await rows(page, 'notes')).some(row => row.content === '``` `a` + ``b`` <tag> ```')).toBe(true);
  await page.reload();
  await expect(preview.locator('code')).toHaveText('`a` + ``b`` <tag>');
  await preview.click();
  await expect(page.getByRole('textbox', { name: 'Edit note' }).locator('code')).toHaveText('`a` + ``b`` <tag>');
});

test('retired finish and clear-formatting shortcuts are inert', async ({ page }) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await composer.fill('Keep this bold');
  await selectAll(composer);
  await composer.press('Meta+b');
  await expect(composer.locator('strong')).toHaveText('Keep this bold');
  await composer.press('Meta+Backslash');
  await expect(composer.locator('strong')).toHaveText('Keep this bold');
  await composer.press('Meta+Shift+x');
  await expect(composer.locator('strong')).toHaveText('Keep this bold');
  await expect(composer.locator('s')).toHaveCount(0);
});

test('plain text and safe pasted formatting retain content through editing and reload', async ({ page }) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  const literal = 'Use <JIRA link>, <b>literal tag</b>, &amp;, **literal stars**, ++plain plus++, ~~plain tildes~~';
  await composer.fill(literal);
  await saveAtEnd(composer);
  const preview = page.getByRole('group', { name: literal, exact: true });
  await expect(preview).toBeVisible();
  await page.reload();
  await expect(preview).toHaveText(literal);
  await expect(preview.locator('strong, u, s')).toHaveCount(0);
  await preview.click();
  await expect(page.getByRole('textbox', { name: 'Edit note' })).toHaveText(literal);
  await saveAtEnd(page.getByRole('textbox', { name: 'Edit note' }));
  await composer.focus();
  await composer.evaluate(element => {
    const data = new DataTransfer();
    data.setData('text/html', '<p><strong>Pasted bold</strong> and <em>italic</em> <a href="javascript:alert(1)">unsafe</a> <a href="https://example.com/pasted">safe</a></p>');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(composer.locator('strong')).toHaveText('Pasted bold');
  await expect(composer.getByRole('link', { name: 'unsafe' })).toHaveCount(0);
  await expect(composer.getByRole('link', { name: 'safe' })).toHaveAttribute('href', 'https://example.com/pasted');
  await saveAtEnd(composer);
  await expect(page.getByRole('group', { name: 'Pasted bold and italic unsafe safe', exact: true }).locator('strong')).toHaveText('Pasted bold');
  await page.reload();
  await expect(page.getByRole('group', { name: 'Pasted bold and italic unsafe safe', exact: true }).locator('strong')).toHaveText('Pasted bold');
});

test('Ctrl shortcuts work on Windows and block formatting saves valid Markdown', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New journal bullet', exact: true });
  await expect(composer).toBeFocused();
  await composer.fill('Windows bold');
  await composer.press('Control+a'); await composer.press('Control+b');
  await expect(composer.locator('strong')).toHaveText('Windows bold');
  await composer.press('Control+z'); await expect(composer.locator('strong')).toHaveCount(0);
  await composer.press('Control+y'); await expect(composer.locator('strong')).toHaveCount(1);
  await saveAtEnd(composer);
  await expect(composer).toHaveText('');
  await composer.fill('Windows code');
  await composer.press('Control+a'); await composer.press('Control+Shift+c');
  await expect(composer.locator('code')).toHaveText('Windows code');
  await saveAtEnd(composer);
  await expect(composer).toHaveText('');
  await composer.pressSequentially('Small heading');
  await composer.press('Control+Alt+2');
  await expect(composer.locator('h2')).toHaveText('Small heading');
  await saveAtEnd(composer);
  await expect(composer).toHaveText('');
  await composer.pressSequentially('A quoted thought');
  await composer.press('Control+Shift+b');
  await expect(composer.locator('blockquote')).toHaveText('A quoted thought');
  await saveAtEnd(composer);
  await expect(composer).toHaveText('');
  await composer.press('Control+Alt+c');
  await composer.pressSequentially('first line');
  await composer.press('Enter');
  await composer.pressSequentially('```');
  await composer.press('Enter');
  await composer.pressSequentially('third line');
  await expect(composer.locator('pre code')).toHaveText('first line\n```\nthird line');
  await composer.press('Control+Enter');
  await expect(composer).toHaveText('');
  await composer.pressSequentially('Line one');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('Line two');
  await composer.press('Enter');
  await expect(composer).toHaveText('');
  const content = (await rows(page, 'notes')).map(row => row.content);
  expect(content).toContain('**Windows bold**');
  expect(content).toContain('`Windows code`');
  expect(content).toContain('## Small heading');
  expect(content).toContain('> A quoted thought');
  expect(content).toContain('````\nfirst line\n```\nthird line\n````');
  expect(content).toContain('Line one\\\nLine two');
  await page.reload();
  await expect(page.getByRole('group', { name: 'Small heading', exact: true }).locator('h2')).toHaveText('Small heading');
  await expect(page.getByRole('group', { name: 'first line ``` third line', exact: true }).locator('pre code')).toHaveText('first line\n```\nthird line');
});

for (const kind of ['notes', 'tasks'] as const) {
  test(`Command Shift C formats a mouse selection in saved ${kind}`, async ({ page, request }) => {
    const journal = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const content = `Select ${kind === 'tasks' ? '**this**' : 'this'} code with the mouse ${kind}`;
    await request.post(`/api/${kind}`, { data: { date: journal.today, content } });
    await page.goto('/');
    const preview = page.getByRole('group', { name: `Select this code with the mouse ${kind}`, exact: true });
    const points = await preview.evaluate(element => {
      const at = (offset: number): [Node, number] => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const length = node.textContent!.length;
          if (offset <= length) return [node, offset];
          offset -= length;
        }
        throw new Error('Selection exceeds text length');
      };
      const range = document.createRange();
      range.setStart(...at(7)); range.setEnd(...at(16));
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y + rect.height / 2, end: rect.right };
    });
    // Check both drag directions, including text that already contains a mark.
    await page.mouse.move(kind === 'tasks' ? points.end : points.x, points.y);
    await page.mouse.down();
    await page.mouse.move(kind === 'tasks' ? points.x : points.end, points.y, { steps: 8 });
    await page.mouse.up();
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit to-do', exact: true });
    await expect(editor).toBeFocused();
    await page.keyboard.press('Meta+Shift+c');
    await expect(editor.locator('code')).toHaveText('this code');
    await saveAtEnd(editor);
    await expect(preview.locator('code')).toHaveText('this code');
    expect((await rows(page, kind)).some(row => row.content === `Select \`this code\` with the mouse ${kind}`)).toBe(true);
  });
}

for (const kind of ['notes', 'tasks'] as const) {
  test(`right-click edits link text and URL in saved and active ${kind}`, async ({ page, request }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: {
      readText: async () => { throw new Error('Context editing must not read the clipboard'); },
    } }));
    const journal = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
    const created = await (await request.post(`/api/${kind}`, { data: {
      date: journal.today, content: `Before [**Original ${kind} link**](https://example.com/original) after`,
    } })).json();
    await page.goto('/');
    const savedLink = page.getByRole('link', { name: `Original ${kind} link`, exact: true });
    await savedLink.click({ button: 'right' });
    const dialog = page.getByRole('dialog', { name: 'Link', exact: true });
    const textField = dialog.getByRole('textbox', { name: 'Link label', exact: true });
    const urlField = dialog.getByRole('textbox', { name: 'Link URL', exact: true });
    await expect(dialog.getByRole('textbox')).toHaveCount(2);
    await expect(dialog.locator('label')).toHaveCount(0);
    await expect(dialog.getByRole('button')).toHaveCount(0);
    await expect(dialog.getByRole('textbox').first()).toHaveValue(`Original ${kind} link`);
    await expect(dialog.getByRole('textbox').last()).toHaveValue('https://example.com/original');
    await expect(textField).toBeFocused();
    await textField.fill(`Short ${kind}`);
    await urlField.fill('https://example.com/changed');
    await urlField.press('Enter');
    await expect(dialog).toBeHidden();
    const editor = page.getByRole('textbox', { name: kind === 'notes' ? 'Edit note' : 'Edit to-do', exact: true });
    await expect(editor).toBeFocused();
    await expect(editor.getByRole('link')).toHaveText(`Short ${kind}`);
    await expect(editor.getByRole('link')).toHaveAttribute('href', 'https://example.com/changed');
    await expect(editor.locator('strong')).toHaveText(`Short ${kind}`);
    // Right-click also works without first leaving the editor.
    await editor.getByRole('link').click({ button: 'right' });
    await expect(textField).toHaveValue(`Short ${kind}`);
    await expect(urlField).toHaveValue('https://example.com/changed');
    await textField.fill(`Final ${kind}`);
    await textField.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(editor.getByRole('link')).toHaveText(`Final ${kind}`);
    await saveAtEnd(editor);
    await expect(page.getByRole('group', { name: `Before Final ${kind} after`, exact: true })).toBeVisible();
    const content = (await rows(page, kind)).find(row => row.id === created.id)!.content;
    expect(content).toContain(`Final ${kind}`);
    expect(content).toContain('**');
    expect(content).toContain('(https://example.com/changed)');
    await page.reload();
    await expect(page.getByRole('link', { name: `Final ${kind}`, exact: true })).toHaveAttribute('href', 'https://example.com/changed');
  });
}
